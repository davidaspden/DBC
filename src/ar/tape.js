/**
 * M7a / M8 (minimal) — AR Raw Tape Recorder Wrapper (`src/ar/tape.js`).
 *
 * Wraps `src/tape/record.js` WITHOUT editing it to record:
 *  - RAW uncomposited Y-plane luma frames (`expectedPayloads: []`, `composited: false`)
 *  - Live orientation / gyro / accelerometer sensor snapshots
 *  - Per-frame `meta.camera` (`{ exposureTime, iso, fps, width, height, zoom, focusDistance }`)
 *    and `meta.ar` (`{ layoutId, composited: false, camera, tracker, photometry }`)
 *  - Downloadable `.layout.json` sidecar containing the full M0 layout + measured overrides.
 *
 * Output binary container remains 100% `.dbct` v1 compliant and replays cleanly in `tools/replay.mjs`.
 */

import { createTapeRecorder } from '../tape/record.js';
import { serializeArLayout } from './layout.js';

const DEFAULT_AR_MAX_FRAMES = 2400; // ~80 s at 30 fps
const DEFAULT_AR_MAX_BYTES = 400 * 1024 * 1024; // 400 MiB ceiling (M8 budget)

/**
 * Safely extracts `meta.camera` from a MediaStreamTrack plus measured fps / frame dimensions.
 * Tolerates missing Image Capture keys cleanly (null when unsupported).
 */
export function extractCameraMeta(track = null, opts = {}) {
  const settings = track && typeof track.getSettings === 'function'
    ? (track.getSettings() || {})
    : {};

  const width = (opts.width | 0) || (settings.width | 0) || null;
  const height = (opts.height | 0) || (settings.height | 0) || null;
  const fps = typeof opts.fps === 'number' && Number.isFinite(opts.fps)
    ? Math.round(opts.fps * 100) / 100
    : (typeof settings.frameRate === 'number' && Number.isFinite(settings.frameRate)
        ? Math.round(settings.frameRate * 100) / 100
        : null);

  return {
    exposureTime: typeof settings.exposureTime === 'number' ? settings.exposureTime : (opts.exposureTime ?? null),
    iso: typeof settings.iso === 'number' ? settings.iso : (opts.iso ?? null),
    fps,
    width,
    height,
    zoom: typeof settings.zoom === 'number' ? settings.zoom : (opts.zoom ?? null),
    focusDistance: typeof settings.focusDistance === 'number' ? settings.focusDistance : (opts.focusDistance ?? null),
  };
}

/**
 * Splices per-frame `{ camera, ar }` metadata into an already-encoded `.dbct` v1 buffer
 * without decompressing or re-compressing the frame luma payloads.
 */
function augmentDbctV1Frames(baseBytes, frameExtras) {
  if (!frameExtras || frameExtras.length === 0) return baseBytes;
  const u8 = baseBytes instanceof Uint8Array ? baseBytes : new Uint8Array(baseBytes);
  if (u8.byteLength < 12) return u8;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerLen = dv.getUint32(8, true);
  const headerSlice = u8.subarray(0, 12 + headerLen);

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const records = [];
  let off = 12 + headerLen;
  let idx = 0;
  let totalSize = headerSlice.byteLength;

  while (off + 8 <= u8.byteLength) {
    const metaLen = dv.getUint32(off, true);
    const dataLen = dv.getUint32(off + 4, true);
    off += 8;
    const rawMeta = u8.subarray(off, off + metaLen);
    off += metaLen;
    const rawData = u8.subarray(off, off + dataLen);
    off += dataLen;

    const extra = idx < frameExtras.length ? frameExtras[idx] : null;
    let outMetaBytes = rawMeta;
    if (extra) {
      const parsedMeta = JSON.parse(decoder.decode(rawMeta));
      parsedMeta.camera = extra.camera;
      parsedMeta.ar = extra.ar;
      outMetaBytes = encoder.encode(JSON.stringify(parsedMeta));
    }
    records.push({ meta: outMetaBytes, data: rawData });
    totalSize += 8 + outMetaBytes.byteLength + rawData.byteLength;
    idx++;
  }

  const out = new Uint8Array(totalSize);
  const outDv = new DataView(out.buffer);
  out.set(headerSlice, 0);

  let writeOff = headerSlice.byteLength;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    outDv.setUint32(writeOff, rec.meta.byteLength, true);
    outDv.setUint32(writeOff + 4, rec.data.byteLength, true);
    writeOff += 8;
    out.set(rec.meta, writeOff);
    writeOff += rec.meta.byteLength;
    out.set(rec.data, writeOff);
    writeOff += rec.data.byteLength;
  }

  return out;
}

/**
 * Creates a raw AR tape recorder wrapping `src/tape/record.js`.
 */
export function createArTapeRecorder(opts = {}) {
  const layout = opts.layout || null;
  const layoutId = opts.layoutId || (layout ? layout.layoutId : 'ar-unknown');
  const device = opts.device || '';
  const lighting = opts.lighting || '';
  const notes = opts.notes || '';

  const inner = createTapeRecorder({
    maxFrames: opts.maxFrames || DEFAULT_AR_MAX_FRAMES,
    maxBytes: opts.maxBytes || DEFAULT_AR_MAX_BYTES,
    everyNth: opts.everyNth || 1,
    compress: opts.compress !== false,
    meta: {
      mode: 'ar-raw',
      layoutId,
      composited: false,
      device,
      lighting,
      notes,
      ...(opts.meta || {}),
    },
  });

  const frameExtras = [];
  let startTimeMs = 0;
  let lastFrameMs = 0;
  let lastCamera = null;

  function start(nowMs = Date.now()) {
    frameExtras.length = 0;
    startTimeMs = nowMs;
    lastFrameMs = nowMs;
    lastCamera = null;
    inner.start();
  }

  function stop(nowMs = Date.now()) {
    if (inner.getStats().active) {
      lastFrameMs = Math.max(lastFrameMs, nowMs);
    }
    inner.stop();
  }

  /**
   * Pushes one raw Y-plane frame (no labels) + sensor snapshot + `meta.camera`.
   */
  async function pushFrame({
    frameId,
    tFrameMs = 0,
    width,
    height,
    cropX = 0,
    cropY = 0,
    luma,
    sensorSample = null,
    camera = null,
    ar = null,
  }) {
    const camMeta = {
      exposureTime: camera?.exposureTime ?? null,
      iso: camera?.iso ?? null,
      fps: camera?.fps ?? null,
      width: camera?.width ?? (width | 0),
      height: camera?.height ?? (height | 0),
      zoom: camera?.zoom ?? null,
      focusDistance: camera?.focusDistance ?? null,
    };

    const accepted = await inner.pushFrame({
      frameId,
      tFrameMs,
      fps: camMeta.fps,
      width,
      height,
      cropX,
      cropY,
      luma,
      expectedPayloads: [],
      sensorSample,
    });

    if (accepted) {
      lastCamera = camMeta;
      lastFrameMs = Date.now();
      frameExtras.push({
        camera: camMeta,
        ar: {
          layoutId,
          composited: false,
          tracker: ar && ar.tracker ? ar.tracker : null,
          photometry: ar && ar.photometry ? ar.photometry : null,
          camera: camMeta,
        },
      });
    }
    return accepted;
  }

  function exportBytes() {
    const baseBytes = inner.exportBytes();
    return augmentDbctV1Frames(baseBytes, frameExtras);
  }

  function getStats() {
    const st = inner.getStats();
    const durationSec = startTimeMs > 0 ? Math.max(0, (lastFrameMs - startTimeMs) / 1000) : 0;
    return {
      ...st,
      durationSec: Math.round(durationSec * 10) / 10,
      storedMb: Math.round((st.storedBytes / (1024 * 1024)) * 100) / 100,
      layoutId,
    };
  }

  /**
   * Builds the downloadable JSON sidecar object pairing the tape with its M0 layout.
   */
  function buildSidecar(extra = {}) {
    const st = getStats();
    return {
      version: 1,
      kind: 'dbc-ar-tape-sidecar',
      createdUtc: new Date().toISOString(),
      tapeFilename: extra.tapeFilename || null,
      layoutId,
      composited: false,
      device: extra.device ?? device,
      lighting: extra.lighting ?? lighting,
      notes: extra.notes ?? notes,
      cameraSummary: extra.cameraSummary ?? lastCamera,
      stats: {
        frameCount: st.frameCount,
        storedBytes: st.storedBytes,
        durationSec: st.durationSec,
      },
      layout: layout ? serializeArLayout(layout) : null,
    };
  }

  function triggerDownload(filename = `dbc-ar-raw-${Date.now()}.dbct`) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
    const bytes = exportBytes();
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function triggerSidecarDownload(filename = `dbc-ar-raw-${Date.now()}.layout.json`, extra = {}) {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return false;
    const sidecar = buildSidecar({ ...extra, tapeFilename: extra.tapeFilename || filename.replace(/\.layout\.json$/, '.dbct') });
    const blob = new Blob([JSON.stringify(sidecar, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  return {
    start,
    stop,
    pushFrame,
    exportBytes,
    getStats,
    buildSidecar,
    triggerDownload,
    triggerSidecarDownload,
  };
}
