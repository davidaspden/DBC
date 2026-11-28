/**
 * GR3 — Browser & Node Frame/Sensor Tape Recorder (`.dbct` v1).
 *
 * Uses built-in `CompressionStream('gzip')` (or Node `zlib` / raw fallback) to pack
 * raw Y-plane frames, timestamps, crop offsets, sensor samples, and golden decoded
 * payloads into a compact downloadable `.dbct` binary tape.
 */

const MAGIC = new Uint8Array([0x44, 0x42, 0x43, 0x54]); // "DBCT"
const FORMAT_VERSION = 1;

async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'function') {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return { codec: 'gzip', data: out };
  }
  return { codec: 'raw', data: bytes };
}

/**
 * Creates a bounded in-memory `.dbct` tape recorder.
 *
 * @param {{
 *   maxFrames?: number,
 *   maxBytes?: number,
 *   everyNth?: number,
 *   compress?: boolean,
 *   meta?: object
 * }} [opts]
 */
export function createTapeRecorder(opts = {}) {
  const maxFrames = opts.maxFrames || 180;
  const maxBytes = opts.maxBytes || 64 * 1024 * 1024; // 64 MiB default cap
  const everyNth = Math.max(1, opts.everyNth | 0);
  const compress = opts.compress !== false;
  const meta = opts.meta || {};

  const frames = [];
  let seen = 0;
  let storedBytes = 0;
  let active = false;

  function start() {
    frames.length = 0;
    seen = 0;
    storedBytes = 0;
    active = true;
  }

  function stop() {
    active = false;
  }

  /**
   * Captures a single Y-plane frame + optional sensor snapshot + golden payloads.
   */
  async function pushFrame({
    frameId = seen,
    tFrameMs = 0,
    width,
    height,
    cropX = 0,
    cropY = 0,
    luma,
    expectedPayloads = [],
    sensorSample = null,
  }) {
    if (!active) return false;
    seen++;
    if ((seen - 1) % everyNth !== 0) return false;
    if (frames.length >= maxFrames || storedBytes >= maxBytes) return false;

    const rawCopy = new Uint8Array(luma.buffer, luma.byteOffset, width * height).slice();
    const packed = compress ? await gzipBytes(rawCopy) : { codec: 'raw', data: rawCopy };
    storedBytes += packed.data.byteLength;
    frames.push({
      meta: {
        frameId,
        tFrameMs,
        width,
        height,
        cropX,
        cropY,
        codec: packed.codec,
        expectedPayloads: Array.isArray(expectedPayloads) ? expectedPayloads.slice() : [],
        sensorSample,
      },
      data: packed.data,
    });
    return true;
  }

  /**
   * Packs all recorded frames into a single `.dbct` v1 `Uint8Array`.
   */
  function exportBytes() {
    const encoder = new TextEncoder();
    const headerObj = {
      version: FORMAT_VERSION,
      createdUtc: new Date().toISOString(),
      frameCount: frames.length,
      codec: frames.length > 0 ? frames[0].meta.codec : (compress ? 'gzip' : 'raw'),
      meta,
    };
    const headerBytes = encoder.encode(JSON.stringify(headerObj));

    const encodedMetas = frames.map((f) => encoder.encode(JSON.stringify(f.meta)));
    let totalSize = 12 + headerBytes.byteLength;
    for (let i = 0; i < frames.length; i++) {
      totalSize += 8 + encodedMetas[i].byteLength + frames[i].data.byteLength;
    }

    const out = new Uint8Array(totalSize);
    const dv = new DataView(out.buffer);
    out.set(MAGIC, 0);
    dv.setUint32(4, FORMAT_VERSION, true);
    dv.setUint32(8, headerBytes.byteLength, true);
    out.set(headerBytes, 12);

    let off = 12 + headerBytes.byteLength;
    for (let i = 0; i < frames.length; i++) {
      const mBytes = encodedMetas[i];
      const dBytes = frames[i].data;
      dv.setUint32(off, mBytes.byteLength, true);
      dv.setUint32(off + 4, dBytes.byteLength, true);
      off += 8;
      out.set(mBytes, off);
      off += mBytes.byteLength;
      out.set(dBytes, off);
      off += dBytes.byteLength;
    }
    return out;
  }

  function triggerDownload(filename = `dbc-tape-${Date.now()}.dbct`) {
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

  return {
    start,
    stop,
    pushFrame,
    exportBytes,
    triggerDownload,
    getStats: () => ({
      active,
      frameCount: frames.length,
      storedBytes,
      maxFrames,
      maxBytes,
    }),
  };
}
