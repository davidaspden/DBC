/**
 * Phase 4: Application Entry Point, WebCodecs Luma Extractor, Worker Dispatch,
 * Audio Feedback, Decode History & Live HUD.
 *
 * Frame Extraction Strategy:
 *  - Primary Path: WebCodecs `new VideoFrame(video)` + `frame.copyTo()` into a pre-allocated
 *    buffer, extracting the raw Y (luma) plane directly without RGBA-to-grayscale conversion
 *    when the VideoFrame is YUV (NV12 / I420 / I422 / I444). Immediately disables WebCodecs
 *    without invoking `copyTo()` if Chrome exposes an opaque texture (`frame.format === null`).
 *    Always closes `VideoFrame` in `finally` to prevent GPU surface exhaustion.
 *  - Fallback Path: `OffscreenCanvas` / 2D Canvas `getImageData()` with integer Y conversion.
 *  - Zero-GC Transferable Ping-Pong: The luma `ArrayBuffer` is transferred to `scanner.worker.js`
 *    and returned back on every result message so buffers are recycled across frames.
 */

import { startCamera, setTorch, stopCamera, listVideoDevices } from './camera.js';
import { ROI_CONFIDENCE_THRESHOLD } from './worker/roi.js';

const YUV_Y_FIRST_FORMATS = new Set(['I420', 'I420A', 'NV12', 'I422', 'I444']);
const RGB_PACKED_FORMATS = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX']);
const MAX_HISTORY_ITEMS = 50;
const LIVE_DEBOUNCE_MS = 1500;

const els = {
  video: document.getElementById('camera-feed'),
  canvas: document.getElementById('hud-overlay'),
  btnStart: document.getElementById('btn-start'),
  btnRes: document.getElementById('btn-res'),
  btnSwitchCam: document.getElementById('btn-switch-cam'),
  btnSound: document.getElementById('btn-sound'),
  btnDebug: document.getElementById('btn-debug'),
  btnInventbar: document.getElementById('btn-inventbar'),
  btnUboat: document.getElementById('btn-uboat'),
  btnTorch: document.getElementById('btn-torch'),
  btnCapture: document.getElementById('btn-capture'),
  btnSynth: document.getElementById('btn-synth'),
  btnFile: document.getElementById('btn-file'),
  fileInput: document.getElementById('file-input'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  hudCapture: document.getElementById('hud-t-capture'),
  hudRoi: document.getElementById('hud-t-roi'),
  hudDecode: document.getElementById('hud-t-decode'),
  hudTotal: document.getElementById('hud-t-total'),
  hudFps: document.getElementById('hud-fps'),
  hudRes: document.getElementById('hud-res'),
  hudFocus: document.getElementById('hud-focus'),
  hudPath: document.getElementById('hud-path'),
  hudTheta: document.getElementById('hud-theta'),
  hudAgree: document.getElementById('hud-agree'),
  historyPanel: document.getElementById('history-panel'),
  historyTitle: document.getElementById('history-title'),
  historyList: document.getElementById('history-list'),
  btnHistoryToggle: document.getElementById('btn-history-toggle'),
  btnHistoryCopy: document.getElementById('btn-history-copy'),
  btnHistoryClear: document.getElementById('btn-history-clear'),
  payloadCard: document.getElementById('payload-card'),
  payloadValue: document.getElementById('payload-value'),
  payloadMeta: document.getElementById('payload-meta'),
  payloadHex: document.getElementById('payload-hex'),
  debugDrawer: document.getElementById('debug-drawer'),
  dbgDims: document.getElementById('dbg-dims'),
  dbgDsInfo: document.getElementById('dbg-ds-info'),
  dbgClusterInfo: document.getElementById('dbg-cluster-info'),
  dbgRunInfo: document.getElementById('dbg-run-info'),
  dbgLumaCanvas: document.getElementById('dbg-luma'),
  dbgTensorCanvas: document.getElementById('dbg-tensor'),
  dbgWaveCanvas: document.getElementById('dbg-wave'),
  dbgHexBox: document.getElementById('dbg-hex-box'),
};

const ctx = els.canvas.getContext('2d');
const dbgLumaCtx = els.dbgLumaCanvas.getContext('2d');
const dbgTensorCtx = els.dbgTensorCanvas.getContext('2d');
const dbgWaveCtx = els.dbgWaveCanvas.getContext('2d');

const app = {
  state: 'IDLE', // IDLE | STARTING | SCANNING | PAUSED | ERROR
  camera: null,
  videoDevices: [],
  activeDeviceIdx: -1,
  torchOn: false,
  worker: null,
  workerBusy: false,
  frameId: 0,
  rafHandle: 0,
  vfcHandle: 0,

  // Active frame geometry & target resolution preset ('720p' | '1080p')
  targetPreset: '720p',
  frameWidth: 1280,
  frameHeight: 720,

  // Pre-allocated recycled buffers (zero per-frame heap allocations)
  lumaBuffer: null,
  webcodecsBuf: null,
  webcodecsBufSize: 0,
  useWebCodecs: typeof VideoFrame !== 'undefined',
  capturePathLabel: 'init',

  // Fallback canvas extractor (allocated lazily once)
  fallbackCanvas: null,
  fallbackCtx: null,

  // Snapshot flag for one-tap `.pgm` diagnostic capture
  pendingPgmCapture: false,

  // Audio feedback (Web Audio API, zero dependencies)
  soundEnabled: true,
  audioCtx: null,

  // Decode history & U-boat unique-cart session set
  history: [],          // [{ payload, count, timeStr, ms, source }]
  seenPayloads: new Set(),
  lastFrameNewPayloads: new Set(),
  totalDecodeCount: 0,
  lastPayload: null,
  lastPayloadAtMs: 0,
  sourceTag: 'CAM',

  // Telemetry & lock-on tracking
  scanStartMs: 0,
  fpsWindowStart: 0,
  fpsFrames: 0,
  fpsValue: 0,
  lastResult: null,
  syntheticPreviewLuma: null,
  previewImage: null,
  previewGtBbox: null,
  synthIndex: 0,
  uboatIndex: 0,
  isStaticMode: false,
  debugOpen: false,
  lastStaticLabel: '',
};

function setStatus(state, message) {
  app.state = state;
  els.statusText.textContent = message;
  els.statusDot.dataset.state = state.toLowerCase();
}

// ============================================================================
// Audio Feedback (Zero-Dependency Web Audio API Scanner Chirp)
// ============================================================================

function unlockAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!app.audioCtx) {
    app.audioCtx = new AudioCtx();
  }
  if (app.audioCtx.state === 'suspended') {
    app.audioCtx.resume().catch(() => {});
  }
}

function playDecodeBeep() {
  if (!app.soundEnabled) return;
  try {
    unlockAudio();
    const ac = app.audioCtx;
    if (!ac) return;

    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();

    // Crisp dual-pitch hardware scanner chirp (1850 Hz -> 2480 Hz, ~85 ms)
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1850, now);
    osc.frequency.setValueAtTime(2480, now + 0.042);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.22, now + 0.006);
    gain.gain.setValueAtTime(0.22, now + 0.068);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.10);

    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(35);
    }
  } catch {
    // Ignore audio errors if blocked by browser policy
  }
}

// ============================================================================
// Decode History
// ============================================================================

function formatTimeNow() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function recordDecodeHistory(payload, workerMs, sourceTag) {
  app.totalDecodeCount++;
  const timeStr = formatTimeNow();

  // Merge consecutive identical payload if it's already the newest entry, else prepend
  if (app.history.length > 0 && app.history[0].payload === payload) {
    app.history[0].count++;
    app.history[0].timeStr = timeStr;
    app.history[0].ms = workerMs;
    app.history[0].source = sourceTag;
  } else {
    app.history.unshift({
      payload,
      count: 1,
      timeStr,
      ms: workerMs,
      source: sourceTag,
    });
    if (app.history.length > MAX_HISTORY_ITEMS) {
      app.history.length = MAX_HISTORY_ITEMS;
    }
  }
  renderHistory();
}

function renderHistory() {
  const count = app.history.length;
  els.historyTitle.textContent = `Cart Sweep: ${app.seenPayloads.size} unique (${app.totalDecodeCount} scans)`;
  els.btnHistoryCopy.disabled = count === 0;
  els.btnHistoryClear.disabled = count === 0 && app.seenPayloads.size === 0;

  if (count === 0) {
    els.historyList.innerHTML = '<li class="history-empty">No barcodes decoded yet.</li>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const item = app.history[i];
    const li = document.createElement('li');
    li.className = 'history-item';
    li.title = 'Click to copy payload';

    const left = document.createElement('span');
    left.className = 'history-payload';
    left.textContent = item.payload;

    const right = document.createElement('span');
    right.className = 'history-meta';

    if (item.count > 1) {
      const badge = document.createElement('span');
      badge.className = 'history-badge';
      badge.textContent = `×${item.count}`;
      right.appendChild(badge);
    }

    const meta = document.createElement('span');
    meta.textContent = `${item.source} · ${item.ms.toFixed(1)}ms · ${item.timeStr}`;
    right.appendChild(meta);

    li.appendChild(left);
    li.appendChild(right);
    li.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(item.payload).then(() => {
          const orig = meta.textContent;
          meta.textContent = 'Copied!';
          setTimeout(() => { meta.textContent = orig; }, 900);
        }).catch(() => {});
      }
    });
    frag.appendChild(li);
  }
  els.historyList.replaceChildren(frag);
}

// ============================================================================
// Worker & Buffer Management
// ============================================================================

function ensureWorker() {
  if (app.worker) return app.worker;
  const worker = new Worker(new URL('./worker/scanner.worker.js', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = handleWorkerMessage;
  worker.onerror = (err) => {
    console.error('[main] Worker error:', err);
    setStatus('ERROR', `Worker error: ${err.message || 'unknown'}`);
    app.workerBusy = false;
  };
  app.worker = worker;
  return worker;
}

function ensureLumaBuffer(width, height) {
  const needed = Math.imul(width, height);
  if (!app.lumaBuffer || app.lumaBuffer.byteLength !== needed) {
    app.lumaBuffer = new Uint8Array(needed);
  }
}

function ensureFallbackCanvas(width, height) {
  if (!app.fallbackCanvas || app.fallbackCanvas.width !== width || app.fallbackCanvas.height !== height) {
    if (typeof OffscreenCanvas !== 'undefined') {
      app.fallbackCanvas = new OffscreenCanvas(width, height);
    } else {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      app.fallbackCanvas = c;
    }
    app.fallbackCtx = app.fallbackCanvas.getContext('2d', { willReadFrequently: true });
  }
}

function clearHudCanvas() {
  const cssW = els.canvas.clientWidth | 0;
  const cssH = els.canvas.clientHeight | 0;
  if (cssW > 0 && cssH > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  }
}

/**
 * Extracts raw Y (luma) bytes into `app.lumaBuffer` via WebCodecs `VideoFrame.copyTo()`
 * (zero RGBA conversion for NV12/I420) or OffscreenCanvas/2D fallback.
 *
 * Immediately disables WebCodecs if Chrome returns an opaque texture (`frame.format === null`),
 * preventing wasted GPU readbacks + double-work per frame.
 */
async function extractLumaFrame(videoEl) {
  const t0 = performance.now();
  let width = (videoEl.videoWidth | 0) || app.frameWidth;
  let height = (videoEl.videoHeight | 0) || app.frameHeight;

  if (app.useWebCodecs) {
    let frame = null;
    try {
      frame = new VideoFrame(videoEl);
      const format = frame.format;

      if (!format || (!YUV_Y_FIRST_FORMATS.has(format) && !RGB_PACKED_FORMATS.has(format))) {
        console.info('[main] WebCodecs VideoFrame format unsupported/opaque:', format, '-> using Canvas fallback');
        app.useWebCodecs = false;
      } else {
        const vis = frame.visibleRect;
        const visX = vis ? (vis.x | 0) : 0;
        const visY = vis ? (vis.y | 0) : 0;
        width = vis ? (vis.width | 0) : (frame.codedWidth | 0);
        height = vis ? (vis.height | 0) : (frame.codedHeight | 0);
        app.frameWidth = width;
        app.frameHeight = height;

        const allocSize = frame.allocationSize();
        if (!app.webcodecsBuf || app.webcodecsBufSize < allocSize) {
          app.webcodecsBuf = new Uint8Array(allocSize);
          app.webcodecsBufSize = allocSize;
        }

        const layouts = await frame.copyTo(app.webcodecsBuf);
        const yLayout = layouts && layouts[0];

        if (YUV_Y_FIRST_FORMATS.has(format) && yLayout) {
          app.capturePathLabel = `WebCodecs (${format})`;
          const stride = yLayout.stride | 0;
          const yOffset = (yLayout.offset + Math.imul(visY, stride) + visX) | 0;

          if (stride === width && yOffset === 0 && Math.imul(width, height) <= app.webcodecsBuf.byteLength) {
            // Zero-copy transfer directly from Plane 0
            const buf = app.webcodecsBuf.buffer;
            app.webcodecsBuf = null;
            app.webcodecsBufSize = 0;
            return {
              buffer: buf,
              byteOffset: 0,
              width,
              height,
              tCaptureMs: performance.now() - t0,
              isWebCodecsScratch: true,
            };
          }

          // Compact strided / cropped Y plane into pre-allocated lumaBuffer
          ensureLumaBuffer(width, height);
          const src = app.webcodecsBuf;
          const dst = app.lumaBuffer;
          for (let y = 0; y < height; y++) {
            const sRow = (yOffset + Math.imul(y, stride)) | 0;
            const dRow = Math.imul(y, width);
            dst.set(src.subarray(sRow, sRow + width), dRow);
          }
          const buf = dst.buffer;
          app.lumaBuffer = null;
          return {
            buffer: buf,
            byteOffset: 0,
            width,
            height,
            tCaptureMs: performance.now() - t0,
            isWebCodecsScratch: false,
          };
        }

        if (RGB_PACKED_FORMATS.has(format)) {
          app.capturePathLabel = `WebCodecs (${format})`;
          ensureLumaBuffer(width, height);
          const src = app.webcodecsBuf;
          const dst = app.lumaBuffer;
          const stride = (yLayout && yLayout.stride) ? (yLayout.stride | 0) : (width << 2);
          const baseOff = ((yLayout ? yLayout.offset : 0) + Math.imul(visY, stride) + (visX << 2)) | 0;
          const isBgr = format === 'BGRA' || format === 'BGRX';
          const rOff = isBgr ? 2 : 0;
          const bOff = isBgr ? 0 : 2;

          let dIdx = 0;
          for (let y = 0; y < height; y++) {
            let sIdx = (baseOff + Math.imul(y, stride)) | 0;
            for (let x = 0; x < width; x++) {
              const r = src[(sIdx + rOff) | 0];
              const g = src[(sIdx + 1) | 0];
              const b = src[(sIdx + bOff) | 0];
              dst[dIdx++] = (Math.imul(77, r) + Math.imul(150, g) + Math.imul(29, b)) >> 8;
              sIdx = (sIdx + 4) | 0;
            }
          }
          const buf = dst.buffer;
          app.lumaBuffer = null;
          return {
            buffer: buf,
            byteOffset: 0,
            width,
            height,
            tCaptureMs: performance.now() - t0,
            isWebCodecsScratch: false,
          };
        }
      }
    } catch (err) {
      console.warn('[main] WebCodecs VideoFrame failed, switching to Canvas fallback:', err);
      app.useWebCodecs = false;
    } finally {
      if (frame) frame.close();
    }
  }

  // Fallback path: OffscreenCanvas / 2D Canvas getImageData()
  app.frameWidth = width;
  app.frameHeight = height;
  app.capturePathLabel = typeof OffscreenCanvas !== 'undefined' ? 'OffscreenCanvas' : 'Canvas2D';
  ensureFallbackCanvas(width, height);
  ensureLumaBuffer(width, height);
  app.fallbackCtx.drawImage(videoEl, 0, 0, width, height);
  const rgba = app.fallbackCtx.getImageData(0, 0, width, height).data;
  const dst = app.lumaBuffer;
  const count = Math.imul(width, height);
  for (let i = 0, j = 0; i < count; i++, j = (j + 4) | 0) {
    dst[i] = (Math.imul(77, rgba[j]) + Math.imul(150, rgba[j + 1]) + Math.imul(29, rgba[j + 2])) >> 8;
  }
  const buf = dst.buffer;
  app.lumaBuffer = null;
  return {
    buffer: buf,
    byteOffset: 0,
    width,
    height,
    tCaptureMs: performance.now() - t0,
    isWebCodecsScratch: false,
  };
}

function downloadLumaAsPGM(lumaBytes, width, height) {
  const header = `P5\n${width} ${height}\n255\n`;
  const pgm = new Uint8Array(header.length + width * height);
  for (let i = 0; i < header.length; i++) pgm[i] = header.charCodeAt(i);
  pgm.set(lumaBytes.subarray(0, width * height), header.length);

  const blob = new Blob([pgm], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capture_${width}x${height}_${Date.now()}.pgm`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let lastTransferredWasWebCodecs = false;

function handleWorkerMessage(event) {
  const msg = event.data;
  if (!msg || msg.type !== 'result') return;

  app.workerBusy = false;

  if (msg.buffer) {
    const returnedView = new Uint8Array(msg.buffer);
    if (app.pendingPgmCapture) {
      app.pendingPgmCapture = false;
      downloadLumaAsPGM(returnedView, app.frameWidth, app.frameHeight);
    }
    if (lastTransferredWasWebCodecs) {
      app.webcodecsBuf = returnedView;
      app.webcodecsBufSize = returnedView.byteLength;
    } else {
      app.lumaBuffer = returnedView;
    }
  }

  const now = performance.now();
  app.fpsFrames++;
  if (app.fpsWindowStart === 0) {
    app.fpsWindowStart = now;
  } else if (now - app.fpsWindowStart >= 500) {
    app.fpsValue = (app.fpsFrames * 1000) / (now - app.fpsWindowStart);
    app.fpsFrames = 0;
    app.fpsWindowStart = now;
  }

  app.lastResult = msg;
  updateTelemetryHUD(msg, now);
  drawHudOverlay(msg);
  if (app.debugOpen && msg.debug) {
    renderDebugPipeline(msg);
  }
}

function updateTelemetryHUD(msg, now) {
  const totalPipelineMs = (msg.tCaptureMs || 0) + (msg.tTotalMs || 0);
  els.hudCapture.textContent = `${(msg.tCaptureMs || 0).toFixed(1)} ms`;
  els.hudRoi.textContent = `${(msg.tRoiMs || 0).toFixed(2)} ms`;
  els.hudDecode.textContent = `${(msg.tDecodeMs || 0).toFixed(2)} ms`;
  els.hudTotal.textContent = `${totalPipelineMs.toFixed(1)} ms`;
  els.hudFps.textContent = `${app.fpsValue.toFixed(0)} fps`;
  els.hudRes.textContent = `${app.frameWidth}×${app.frameHeight}`;
  els.hudPath.textContent = app.capturePathLabel;
  els.hudTheta.textContent = msg.roiConfidence >= ROI_CONFIDENCE_THRESHOLD
    ? `${msg.thetaDeg.toFixed(1)}°`
    : 'fan';
  els.hudAgree.textContent = `${msg.consensusCount || 0}x`;

  app.lastFrameNewPayloads.clear();
  const dets = Array.isArray(msg.detections) && msg.detections.length > 0
    ? msg.detections
    : (msg.detected === 1 && msg.payload ? [msg] : []);

  if (dets.length > 0) {
    let newestDet = null;
    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (!d.payload) continue;
      const isNewInCart = !app.seenPayloads.has(d.payload);
      const shouldLog = app.isStaticMode || isNewInCart;

      if (shouldLog) {
        app.seenPayloads.add(d.payload);
        app.lastFrameNewPayloads.add(d.payload);
        recordDecodeHistory(d.payload, msg.tTotalMs || 0, app.sourceTag);
        newestDet = d;
      }
    }

    const displayDet = newestDet || dets[0];
    app.lastPayload = displayDet.payload;
    app.lastPayloadAtMs = now;

    els.payloadValue.textContent = dets.length > 1
      ? `${displayDet.payload}  (+${dets.length - 1} in frame)`
      : displayDet.payload;
    els.payloadMeta.textContent =
      `CODE 128 • ${displayDet.consensusCount} scanlines • θ=${displayDet.thetaDeg.toFixed(1)}° • ` +
      `worker ${(msg.tTotalMs || 0).toFixed(2)} ms • ${app.seenPayloads.size} unique`;
    if (displayDet.payloadHex) {
      els.payloadHex.hidden = false;
      els.payloadHex.textContent = `HEX: ${displayDet.payloadHex}`;
    }
    els.payloadCard.classList.add('locked');

    if (newestDet) {
      playDecodeBeep();
      els.payloadCard.classList.remove('flash');
      void els.payloadCard.offsetWidth;
      els.payloadCard.classList.add('flash');
    }
  } else if (app.isStaticMode) {
    app.lastPayload = null;
    els.payloadCard.classList.remove('locked');
    els.payloadValue.textContent = 'No Code 128 decoded';
    els.payloadMeta.textContent =
      msg.roiConfidence >= ROI_CONFIDENCE_THRESHOLD
        ? `RoI locked (conf=${msg.roiConfidence.toFixed(2)}, θ=${msg.thetaDeg.toFixed(1)}°) — non-Code128 or unreadable • ${(msg.tTotalMs || 0).toFixed(2)} ms`
        : `No barcode RoI above threshold • ${(msg.tTotalMs || 0).toFixed(2)} ms`;
    els.payloadHex.hidden = true;
    els.payloadHex.textContent = '';
  } else if (app.lastPayload && (now - app.lastPayloadAtMs) > 2500) {
    els.payloadCard.classList.remove('locked');
  }
}

/**
 * Renders Stage 1a (downsampled luma + cast scanlines), Stage 1b (2D Structure Tensor
 * coherence/angle heatmap + Top-K clusters), Stage 2–3 (1D scanline waveform + reconstructed
 * binary bar/space strip), and Stage 4–5 (ASCII Hex + Code 128 raw symbol table).
 */
function renderDebugPipeline(msg) {
  const dbg = msg.debug;
  if (!dbg) return;

  const fullW = app.frameWidth;
  const fullH = app.frameHeight;
  const dsScale = 1 << dbg.dsShift;
  els.dbgDims.textContent = `${fullW}×${fullH} (÷${dsScale})`;
  els.dbgDsInfo.textContent = `${dbg.dsW}×${dbg.dsH}`;
  els.dbgClusterInfo.textContent = `${dbg.clusters.length} RoI`;
  els.dbgRunInfo.textContent = `L${dbg.waveLineIdx} · ${dbg.runCount} runs`;

  // 1a. Downsampled Y Luma + Cast Scanlines
  const lumaCanvas = els.dbgLumaCanvas;
  if (lumaCanvas.width !== dbg.dsW || lumaCanvas.height !== dbg.dsH) {
    lumaCanvas.width = dbg.dsW;
    lumaCanvas.height = dbg.dsH;
  }
  const lumaImg = dbgLumaCtx.createImageData(dbg.dsW, dbg.dsH);
  const lumaRgba = lumaImg.data;
  const ds = dbg.downsampled;
  for (let i = 0, j = 0; i < ds.length; i++, j += 4) {
    const v = ds[i];
    lumaRgba[j] = v;
    lumaRgba[j + 1] = v;
    lumaRgba[j + 2] = v;
    lumaRgba[j + 3] = 255;
  }
  dbgLumaCtx.putImageData(lumaImg, 0, 0);

  // Overlay Stage 2 scanlines on downsampled luma
  const invDs = 1 / dsScale;
  for (let i = 0; i < dbg.scanlines.length; i++) {
    const s = dbg.scanlines[i];
    dbgLumaCtx.strokeStyle = s.active ? '#22d3ee' : 'rgba(250, 204, 21, 0.55)';
    dbgLumaCtx.lineWidth = s.active ? 2 : 1;
    dbgLumaCtx.beginPath();
    dbgLumaCtx.moveTo(s.x0 * invDs, s.y0 * invDs);
    dbgLumaCtx.lineTo(s.x1 * invDs, s.y1 * invDs);
    dbgLumaCtx.stroke();
  }

  // 1b. Structure Tensor Coherence & Orientation Pseudo-Image + Top-K Cluster Boxes
  const tensorCanvas = els.dbgTensorCanvas;
  if (tensorCanvas.width !== dbg.dsW || tensorCanvas.height !== dbg.dsH) {
    tensorCanvas.width = dbg.dsW;
    tensorCanvas.height = dbg.dsH;
  }
  dbgTensorCtx.fillStyle = '#020617';
  dbgTensorCtx.fillRect(0, 0, dbg.dsW, dbg.dsH);

  const cellPx = 8; // 8x8 downsampled pixels per tensor block
  for (let by = 0; by < dbg.gridH; by++) {
    for (let bx = 0; bx < dbg.gridW; bx++) {
      const idx = by * dbg.gridW + bx;
      const coh = dbg.blockCoherence[idx];
      if (coh <= 0.1) continue;

      const active = dbg.blockState[idx] > 0;
      const angRad = 0.5 * Math.atan2(dbg.blockDirSin2[idx], dbg.blockDirCos2[idx]);
      let deg = (angRad * 180) / Math.PI;
      if (deg < 0) deg += 180;
      // Map orientation [0, 180) -> hue [180..540] (cyan=0°, lime=45°, magenta=90°, orange=135°)
      const hue = (180 + deg * 2) % 360;
      const light = active ? Math.min(62, 18 + coh * 45) : Math.min(26, coh * 22);
      const sat = active ? 92 : 35;
      dbgTensorCtx.fillStyle = `hsl(${hue.toFixed(0)}, ${sat}%, ${light.toFixed(0)}%)`;
      dbgTensorCtx.fillRect(bx * cellPx, by * cellPx, cellPx - 1, cellPx - 1);
    }
  }

  // Draw raw Stage 1 RoI cluster boxes subtly in amber, then decoded detections cleanly in bright green
  const detList = Array.isArray(msg.detections) && msg.detections.length > 0 ? msg.detections : null;
  dbgTensorCtx.font = 'bold 10px monospace';
  const showClusterLabels = dbg.clusters.length <= 6;
  for (let c = 0; c < dbg.clusters.length; c++) {
    const cl = dbg.clusters[c];
    dbgTensorCtx.strokeStyle = detList ? 'rgba(245, 158, 11, 0.5)' : (c === 0 ? '#4ade80' : '#f59e0b');
    dbgTensorCtx.lineWidth = 1;
    const rx = cl.x * invDs;
    const ry = cl.y * invDs;
    const rw = cl.w * invDs;
    const rh = cl.h * invDs;
    dbgTensorCtx.strokeRect(rx, ry, rw, rh);
    if (showClusterLabels) {
      dbgTensorCtx.fillStyle = c === 0 ? '#4ade80' : '#f59e0b';
      dbgTensorCtx.fillText(`#${c}`, rx + 2, Math.max(10, ry + 10));
    }
  }
  if (detList) {
    dbgTensorCtx.strokeStyle = '#4ade80';
    dbgTensorCtx.lineWidth = 2;
    for (let d = 0; d < detList.length; d++) {
      const det = detList[d];
      dbgTensorCtx.strokeRect(det.roiX * invDs, det.roiY * invDs, det.roiW * invDs, det.roiH * invDs);
    }
    els.dbgClusterInfo.textContent = `${detList.length} hit / ${dbg.clusters.length} RoI`;
  }

  // 2–3. 1D Scanline Luma Waveform (top) + Reconstructed Bar/Space Pseudo-Barcode Strip (bottom)
  const wCanvas = els.dbgWaveCanvas;
  const wW = wCanvas.width;
  const wH = wCanvas.height;
  dbgWaveCtx.fillStyle = '#020617';
  dbgWaveCtx.fillRect(0, 0, wW, wH);

  const wave = dbg.waveLuma;
  const waveTop = 4;
  const waveH = 54;
  const stripTop = 64;
  const stripH = 24;

  // Midline grid
  dbgWaveCtx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
  dbgWaveCtx.lineWidth = 1;
  dbgWaveCtx.beginPath();
  dbgWaveCtx.moveTo(0, waveTop + waveH * 0.5);
  dbgWaveCtx.lineTo(wW, waveTop + waveH * 0.5);
  dbgWaveCtx.stroke();

  if (wave.length > 1) {
    const xScale = wW / (wave.length - 1);
    dbgWaveCtx.strokeStyle = '#38bdf8';
    dbgWaveCtx.lineWidth = 1.25;
    dbgWaveCtx.beginPath();
    for (let i = 0; i < wave.length; i++) {
      const px = i * xScale;
      const py = waveTop + waveH - (wave[i] / 255) * waveH;
      if (i === 0) dbgWaveCtx.moveTo(px, py);
      else dbgWaveCtx.lineTo(px, py);
    }
    dbgWaveCtx.stroke();

    // Draw reconstructed binary bars/spaces directly from Stage 3 runWidthsQ8 & runIsBar
    dbgWaveCtx.fillStyle = '#e2e8f0';
    dbgWaveCtx.fillRect(0, stripTop, wW, stripH);

    let posPx = 0;
    const scaleRun = wW / wave.length;
    for (let r = 0; r < dbg.runCount; r++) {
      const runPx = dbg.runWidthsQ8[r] / 256;
      const x0 = posPx * scaleRun;
      const rw = Math.max(0.75, runPx * scaleRun);
      if (dbg.runIsBar[r] === 1) {
        dbgWaveCtx.fillStyle = '#090d14';
        dbgWaveCtx.fillRect(x0, stripTop, rw, stripH);
      }
      // Subtle edge transition tick above strip
      dbgWaveCtx.fillStyle = dbg.runIsBar[r] === 1 ? '#22c55e' : '#f43f5e';
      dbgWaveCtx.fillRect(x0, stripTop - 4, 1, 4);
      posPx += runPx;
    }
  }

  // 4–5. Hex & Code 128 Symbol Breakdown (supports both single and multi-barcode arrays)
  if (detList && detList.length > 1) {
    let html = `<div style="color:#4ade80;font-weight:700;margin-bottom:3px;">${detList.length} CODE 128 DECODED (wave shows #1: ${escapeHtml(detList[0].payload)})</div>`;
    html += `<div style="color:#facc15;margin-bottom:4px;">#1 SYMS: ${escapeHtml(detList[0].symbolsHex || '')}</div>`;
    for (let i = 0; i < detList.length; i++) {
      const d = detList[i];
      html += `<div><span style="color:#4ade80;">#${i + 1} ${escapeHtml(d.payload)}</span> <span style="color:#7dd3fc;">[${escapeHtml(d.payloadHex || '')}]</span></div>`;
    }
    els.dbgHexBox.innerHTML = html;
  } else if (msg.detected === 1 && msg.payload) {
    els.dbgHexBox.innerHTML =
      `<div style="color:#4ade80;font-weight:700;">ASCII: ${escapeHtml(msg.payload)}</div>` +
      `<div style="color:#7dd3fc;">HEX  : ${escapeHtml(msg.payloadHex || '')}</div>` +
      `<div style="color:#facc15;">SYMS : ${escapeHtml(msg.symbolsHex || '')}</div>`;
  } else {
    els.dbgHexBox.textContent =
      `No Code 128 lock (RoI conf=${(msg.roiConfidence || 0).toFixed(2)}, θ=${(msg.thetaDeg || 0).toFixed(1)}°, runs=${dbg.runCount})`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function drawHudOverlay(msg) {
  const canvas = els.canvas;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth | 0;
  const cssH = canvas.clientHeight | 0;
  if (cssW <= 0 || cssH <= 0) return;

  const targetW = Math.round(cssW * dpr);
  const targetH = Math.round(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const srcW = app.frameWidth;
  const srcH = app.frameHeight;
  const scale = app.isStaticMode
    ? Math.min(cssW / srcW, cssH / srcH)
    : Math.max(cssW / srcW, cssH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const offX = (cssW - drawW) * 0.5;
  const offY = (cssH - drawH) * 0.5;

  if (app.previewImage) {
    ctx.drawImage(app.previewImage, offX, offY, drawW, drawH);
  } else if (app.syntheticPreviewLuma) {
    ensureFallbackCanvas(srcW, srcH);
    const imgData = app.fallbackCtx.createImageData(srcW, srcH);
    const rgba = imgData.data;
    const luma = app.syntheticPreviewLuma;
    for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
      const v = luma[i];
      rgba[j] = v;
      rgba[j + 1] = v;
      rgba[j + 2] = v;
      rgba[j + 3] = 255;
    }
    app.fallbackCtx.putImageData(imgData, 0, 0);
    ctx.drawImage(app.fallbackCanvas, offX, offY, drawW, drawH);
  }

  if (!app.isStaticMode) {
    const guideW = Math.min(cssW * 0.72, 420);
    const guideH = Math.min(cssH * 0.30, 190);
    const gx = (cssW - guideW) * 0.5;
    const gy = (cssH - guideH) * 0.5;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.lineWidth = 2;
    const corner = 22;
    ctx.beginPath();
    ctx.moveTo(gx, gy + corner); ctx.lineTo(gx, gy); ctx.lineTo(gx + corner, gy);
    ctx.moveTo(gx + guideW - corner, gy); ctx.lineTo(gx + guideW, gy); ctx.lineTo(gx + guideW, gy + corner);
    ctx.moveTo(gx + guideW, gy + guideH - corner); ctx.lineTo(gx + guideW, gy + guideH); ctx.lineTo(gx + guideW - corner, gy + guideH);
    ctx.moveTo(gx + corner, gy + guideH); ctx.lineTo(gx, gy + guideH); ctx.lineTo(gx, gy + guideH - corner);
    ctx.stroke();
  }

  if (app.previewGtBbox) {
    const b = app.previewGtBbox;
    ctx.save();
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      offX + b.minX * scale,
      offY + b.minY * scale,
      (b.maxX - b.minX) * scale,
      (b.maxY - b.minY) * scale
    );
    ctx.restore();
  }

  if (!msg) return;

  const dets = Array.isArray(msg.detections) && msg.detections.length > 0
    ? msg.detections
    : null;

  if (dets) {
    ctx.font = 'bold 12px ui-monospace, monospace';
    for (let i = 0; i < dets.length; i++) {
      const d = dets[i];
      if (d.roiW <= 0 || d.roiH <= 0) continue;
      const isFresh = app.isStaticMode || app.lastFrameNewPayloads.has(d.payload);
      const rx = offX + d.roiX * scale;
      const ry = offY + d.roiY * scale;
      const rw = d.roiW * scale;
      const rh = d.roiH * scale;
      const cx = offX + d.roiCenterX * scale;
      const cy = offY + d.roiCenterY * scale;

      // Bright green for newly captured barcode; calm blue for already-scanned box in view
      const boxColor = isFresh ? '#00ff7f' : '#38bdf8';
      ctx.strokeStyle = boxColor;
      ctx.lineWidth = isFresh ? 3 : 2;
      ctx.strokeRect(rx, ry, rw, rh);

      const rad = (d.thetaDeg * Math.PI) / 180;
      const halfLen = Math.max(36, (d.roiMajorLen * 0.5) * scale);
      const dx = Math.cos(rad) * halfLen;
      const dy = Math.sin(rad) * halfLen;
      ctx.strokeStyle = isFresh ? '#ff33cc' : 'rgba(56, 189, 248, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - dx, cy - dy);
      ctx.lineTo(cx + dx, cy + dy);
      ctx.stroke();

      // Label pill above each box
      const tag = isFresh ? d.payload : `✓ ${d.payload}`;
      const textW = ctx.measureText(tag).width + 10;
      const labelY = Math.max(20, ry - 6);
      ctx.fillStyle = isFresh ? 'rgba(6, 40, 24, 0.88)' : 'rgba(15, 23, 42, 0.84)';
      ctx.fillRect(rx, labelY - 15, textW, 18);
      ctx.fillStyle = boxColor;
      ctx.fillText(tag, rx + 5, labelY - 2);
    }
    return;
  }

  if (msg.roiConfidence < ROI_CONFIDENCE_THRESHOLD || msg.roiW <= 0 || msg.roiH <= 0) {
    return;
  }

  const rx = offX + msg.roiX * scale;
  const ry = offY + msg.roiY * scale;
  const rw = msg.roiW * scale;
  const rh = msg.roiH * scale;
  const cx = offX + msg.roiCenterX * scale;
  const cy = offY + msg.roiCenterY * scale;

  ctx.strokeStyle = msg.detected === 1 ? '#00ff7f' : '#38bdf8';
  ctx.lineWidth = msg.detected === 1 ? 3 : 2;
  ctx.strokeRect(rx, ry, rw, rh);

  const rad = (msg.thetaDeg * Math.PI) / 180;
  const halfLen = Math.max(40, (msg.roiMajorLen * 0.5) * scale);
  const dx = Math.cos(rad) * halfLen;
  const dy = Math.sin(rad) * halfLen;
  ctx.strokeStyle = msg.detected === 1 ? '#ff33cc' : 'rgba(255, 51, 204, 0.75)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx - dx, cy - dy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();

  ctx.fillStyle = '#ffe600';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
}

// ============================================================================
// Live Camera Loop
// ============================================================================

async function pumpVideoFrame() {
  if (app.state !== 'SCANNING') return;

  // Schedule next camera tick BEFORE awaiting VideoFrame.copyTo() so we never miss a tick
  scheduleNextFrame();

  if (!app.workerBusy && els.video.readyState >= 2) {
    app.workerBusy = true;
    try {
      const cap = await extractLumaFrame(els.video);
      if (app.state !== 'SCANNING') {
        if (cap.isWebCodecsScratch) {
          app.webcodecsBuf = new Uint8Array(cap.buffer);
          app.webcodecsBufSize = cap.buffer.byteLength;
        } else {
          app.lumaBuffer = new Uint8Array(cap.buffer);
        }
        app.workerBusy = false;
        return;
      }
      lastTransferredWasWebCodecs = cap.isWebCodecsScratch;
      const frameId = ++app.frameId;
      app.worker.postMessage(
        {
          type: 'frame',
          frameId,
          width: cap.width,
          height: cap.height,
          byteOffset: cap.byteOffset,
          tCaptureMs: cap.tCaptureMs,
          debug: app.debugOpen,
          buffer: cap.buffer,
        },
        [cap.buffer]
      );
    } catch (err) {
      console.error('[main] Frame dispatch error:', err);
      app.workerBusy = false;
    }
  }
}

function scheduleNextFrame() {
  if (app.state !== 'SCANNING') return;
  if (typeof els.video.requestVideoFrameCallback === 'function') {
    app.vfcHandle = els.video.requestVideoFrameCallback(() => {
      pumpVideoFrame();
    });
  } else {
    app.rafHandle = requestAnimationFrame(() => {
      pumpVideoFrame();
    });
  }
}

async function startScanning(deviceId = null) {
  if (app.state === 'STARTING') return;
  unlockAudio();
  app.syntheticPreviewLuma = null;
  app.previewImage = null;
  app.previewGtBbox = null;
  app.isStaticMode = false;
  app.sourceTag = 'CAM';
  app.lastResult = null;
  app.useWebCodecs = typeof VideoFrame !== 'undefined';
  clearHudCanvas();

  const reqW = app.targetPreset === '1080p' ? 1920 : 1280;
  const reqH = app.targetPreset === '1080p' ? 1080 : 720;
  setStatus('STARTING', `Requesting ${reqW}×${reqH} camera...`);
  els.btnStart.disabled = true;

  try {
    const cam = await startCamera(els.video, { deviceId, width: reqW, height: reqH });
    app.camera = cam;
    app.frameWidth = cam.width;
    app.frameHeight = cam.height;
    app.torchOn = false;

    // Populate camera switcher if multiple cameras exist
    app.videoDevices = await listVideoDevices();
    if (app.videoDevices.length > 1) {
      const curId = cam.settings.deviceId;
      app.activeDeviceIdx = Math.max(0, app.videoDevices.findIndex((d) => d.deviceId === curId));
      els.btnSwitchCam.hidden = false;
    } else {
      els.btnSwitchCam.hidden = true;
    }

    els.hudRes.textContent = `${cam.width}×${cam.height}`;
    els.hudFocus.textContent = String(cam.focusMode);
    els.btnTorch.disabled = !cam.hasTorch;
    els.btnCapture.disabled = false;

    const worker = ensureWorker();
    worker.postMessage({ type: 'init', width: cam.width, height: cam.height });

    app.scanStartMs = performance.now();
    app.fpsWindowStart = 0;
    app.fpsFrames = 0;
    app.workerBusy = false;

    setStatus('SCANNING', `Live camera (${cam.width}×${cam.height}, Code 128)`);
    els.btnStart.textContent = 'Stop Camera';
    els.btnStart.disabled = false;
    scheduleNextFrame();
  } catch (err) {
    console.error('[main] Camera startup error:', err);
    setStatus('ERROR', err.message || 'Camera access failed');
    els.btnStart.textContent = 'Start Camera';
    els.btnStart.disabled = false;
  }
}

function stopScanning() {
  if (app.rafHandle) cancelAnimationFrame(app.rafHandle);
  if (app.vfcHandle && typeof els.video.cancelVideoFrameCallback === 'function') {
    els.video.cancelVideoFrameCallback(app.vfcHandle);
  }
  app.rafHandle = 0;
  app.vfcHandle = 0;

  if (app.camera) {
    stopCamera(app.camera.stream);
    app.camera = null;
  }
  els.video.srcObject = null;
  app.torchOn = false;
  els.btnTorch.disabled = true;
  els.btnTorch.textContent = 'Torch';
  els.btnCapture.disabled = true;
  els.btnSwitchCam.hidden = true;
  els.btnStart.textContent = 'Start Camera';
  clearHudCanvas();
  setStatus('IDLE', 'Camera stopped');
}

// ============================================================================
// Static Dataset / Image Test Modes
// ============================================================================

function dispatchStaticImage(img, label, pathLabel, sourceTag, gtBbox = null) {
  const width = (img.naturalWidth || img.width) | 0;
  const height = (img.naturalHeight || img.height) | 0;
  const tCap0 = performance.now();

  ensureFallbackCanvas(width, height);
  app.fallbackCtx.drawImage(img, 0, 0, width, height);
  const rgba = app.fallbackCtx.getImageData(0, 0, width, height).data;
  const count = Math.imul(width, height);
  const luma = new Uint8Array(count);
  for (let i = 0, j = 0; i < count; i++, j = (j + 4) | 0) {
    luma[i] = (Math.imul(77, rgba[j]) + Math.imul(150, rgba[j + 1]) + Math.imul(29, rgba[j + 2])) >> 8;
  }
  const tCaptureMs = performance.now() - tCap0;

  app.isStaticMode = true;
  app.sourceTag = sourceTag;
  app.lastStaticLabel = label;
  app.frameWidth = width;
  app.frameHeight = height;
  app.previewImage = img;
  app.syntheticPreviewLuma = null;
  app.previewGtBbox = gtBbox;
  app.capturePathLabel = pathLabel;
  els.hudFocus.textContent = 'static';

  const worker = ensureWorker();
  worker.postMessage({ type: 'init', width, height });

  lastTransferredWasWebCodecs = false;
  app.workerBusy = true;
  app.scanStartMs = performance.now();
  worker.postMessage(
    {
      type: 'frame',
      frameId: ++app.frameId,
      width,
      height,
      byteOffset: 0,
      tCaptureMs,
      debug: app.debugOpen,
      buffer: luma.buffer,
    },
    [luma.buffer]
  );
  setStatus('PAUSED', label);
}

async function runRandomInventBar() {
  unlockAudio();
  if (app.state === 'SCANNING') stopScanning();
  const idx = 1 + Math.floor(Math.random() * 527);
  const num = String(idx).padStart(3, '0');
  const jpgUrl = `./InventBar/ProductBarcode${num}.jpg`;
  const txtUrl = `./InventBar/ProductBarcode${num}.txt`;
  setStatus('STARTING', `Loading InventBar #${num}...`);

  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Could not load ${jpgUrl}`));
      el.src = jpgUrl;
    });

    let gtBbox = null;
    try {
      const resp = await fetch(txtUrl);
      if (resp.ok) {
        const line = (await resp.text()).trim().split(/\r?\n/)[0] || '';
        const parts = line.trim().split(/\s+/).map(Number);
        if (parts.length >= 5) {
          const cx = parts[1] * img.naturalWidth;
          const cy = parts[2] * img.naturalHeight;
          const bw = parts[3] * img.naturalWidth;
          const bh = parts[4] * img.naturalHeight;
          gtBbox = {
            minX: Math.max(0, cx - bw * 0.5),
            minY: Math.max(0, cy - bh * 0.5),
            maxX: Math.min(img.naturalWidth, cx + bw * 0.5),
            maxY: Math.min(img.naturalHeight, cy + bh * 0.5),
          };
        }
      }
    } catch {
      // Optional GT box
    }

    dispatchStaticImage(img, `InventBar: ProductBarcode${num}.jpg (Space = next)`, 'InventBar JPG', 'INVENTBAR', gtBbox);
  } catch (err) {
    console.error('[main] InventBar load failed:', err);
    setStatus('ERROR', err.message || 'Failed to load InventBar image');
  }
}

async function runNextUboatGrid() {
  unlockAudio();
  if (app.state === 'SCANNING') stopScanning();
  setStatus('STARTING', 'Generating shaded U-boat vertical grid...');
  try {
    const { synthesizeGridFixture, UBOAT_GRID_SPECS } = await import('../tests/harness.js');
    const spec = UBOAT_GRID_SPECS[app.uboatIndex % UBOAT_GRID_SPECS.length];
    const displayNum = (app.uboatIndex % UBOAT_GRID_SPECS.length) + 1;
    app.uboatIndex++;
    const fx = synthesizeGridFixture(spec);

    // Clear prior cart set so every carton in this grid lights up fresh green
    app.history.length = 0;
    app.seenPayloads.clear();
    app.lastFrameNewPayloads.clear();
    app.totalDecodeCount = 0;
    renderHistory();

    app.isStaticMode = true;
    app.sourceTag = 'UBOAT';
    app.lastStaticLabel = `U-Boat [${displayNum}/${UBOAT_GRID_SPECS.length}]: ${spec.id} (${fx.rows}×${fx.cols})`;
    app.frameWidth = fx.width;
    app.frameHeight = fx.height;
    app.previewImage = null;
    app.syntheticPreviewLuma = fx.luma;
    app.previewGtBbox = null;
    app.capturePathLabel = `${fx.width}×${fx.height} Grid`;
    els.hudFocus.textContent = 'synthetic';

    const worker = ensureWorker();
    worker.postMessage({ type: 'init', width: fx.width, height: fx.height });

    const copy = new Uint8Array(fx.luma);
    lastTransferredWasWebCodecs = false;
    app.workerBusy = true;
    app.scanStartMs = performance.now();
    worker.postMessage(
      {
        type: 'frame',
        frameId: ++app.frameId,
        width: fx.width,
        height: fx.height,
        byteOffset: 0,
        tCaptureMs: 0.0,
        debug: app.debugOpen,
        buffer: copy.buffer,
      },
      [copy.buffer]
    );
    setStatus('PAUSED', app.lastStaticLabel);
  } catch (err) {
    console.error('[main] U-boat grid test failed:', err);
    setStatus('ERROR', `U-boat test failed: ${err.message}`);
  }
}

async function runNextSynthetic() {
  unlockAudio();
  if (app.state === 'SCANNING') stopScanning();
  setStatus('STARTING', 'Generating synthetic 720p fixture...');
  try {
    const { synthesizeFixture, SYNTHETIC_CODE128_SPECS } = await import('../tests/harness.js');
    const spec = SYNTHETIC_CODE128_SPECS[app.synthIndex % SYNTHETIC_CODE128_SPECS.length];
    const displayNum = (app.synthIndex % SYNTHETIC_CODE128_SPECS.length) + 1;
    app.synthIndex++;
    const fx = synthesizeFixture(spec);

    app.isStaticMode = true;
    app.sourceTag = 'SYNTH';
    app.frameWidth = fx.width;
    app.frameHeight = fx.height;
    app.previewImage = null;
    app.syntheticPreviewLuma = fx.luma;
    app.previewGtBbox = fx.bbox;
    app.capturePathLabel = 'Synthetic 720p';
    els.hudFocus.textContent = 'synthetic';

    const worker = ensureWorker();
    worker.postMessage({ type: 'init', width: fx.width, height: fx.height });

    const copy = new Uint8Array(fx.luma);
    lastTransferredWasWebCodecs = false;
    app.workerBusy = true;
    app.scanStartMs = performance.now();
    worker.postMessage(
      {
        type: 'frame',
        frameId: ++app.frameId,
        width: fx.width,
        height: fx.height,
        byteOffset: 0,
        tCaptureMs: 0.0,
        debug: app.debugOpen,
        buffer: copy.buffer,
      },
      [copy.buffer]
    );
    setStatus('PAUSED', `Synthetic [${displayNum}/${SYNTHETIC_CODE128_SPECS.length}]: ${spec.id}`);
  } catch (err) {
    console.error('[main] Synthetic self-test failed:', err);
    setStatus('ERROR', `Self-test failed: ${err.message}`);
  }
}

async function openLocalImageFile(file) {
  if (!file) return;
  unlockAudio();
  if (app.state === 'SCANNING') stopScanning();
  setStatus('STARTING', `Loading ${file.name}...`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Could not decode image ${file.name}`));
      el.src = url;
    });
    dispatchStaticImage(img, `File: ${file.name}`, 'Local Image', 'FILE', null);
  } catch (err) {
    console.error('[main] Local image load failed:', err);
    setStatus('ERROR', err.message || 'Image load failed');
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// UI Event Wiring
// ============================================================================

els.btnStart.addEventListener('click', () => {
  if (app.state === 'SCANNING') {
    stopScanning();
  } else {
    startScanning();
  }
});

els.btnRes.addEventListener('click', () => {
  app.targetPreset = app.targetPreset === '720p' ? '1080p' : '720p';
  els.btnRes.textContent = app.targetPreset;
  els.btnRes.classList.toggle('active', app.targetPreset === '1080p');
  if (app.state === 'SCANNING') {
    const curId = app.camera && app.camera.settings ? app.camera.settings.deviceId : null;
    stopScanning();
    startScanning(curId);
  }
});

els.btnSwitchCam.addEventListener('click', () => {
  if (app.videoDevices.length < 2) return;
  const nextIdx = (app.activeDeviceIdx + 1) % app.videoDevices.length;
  const nextId = app.videoDevices[nextIdx].deviceId;
  stopScanning();
  startScanning(nextId);
});

els.btnSound.addEventListener('click', () => {
  app.soundEnabled = !app.soundEnabled;
  els.btnSound.textContent = app.soundEnabled ? 'Sound ON' : 'Muted';
  els.btnSound.classList.toggle('active', app.soundEnabled);
  if (app.soundEnabled) playDecodeBeep();
});

els.btnDebug.addEventListener('click', () => {
  app.debugOpen = !app.debugOpen;
  els.debugDrawer.hidden = !app.debugOpen;
  els.btnDebug.classList.toggle('active', app.debugOpen);
  els.btnDebug.textContent = app.debugOpen ? 'Debug ON' : 'Debug View';

  // If currently inspecting a static image, re-run it immediately so intermediates populate
  if (app.debugOpen && app.isStaticMode && !app.workerBusy) {
    if (app.previewImage) {
      dispatchStaticImage(
        app.previewImage,
        app.lastStaticLabel || 'Static image',
        app.capturePathLabel,
        app.sourceTag,
        app.previewGtBbox
      );
    } else if (app.syntheticPreviewLuma) {
      const copy = new Uint8Array(app.syntheticPreviewLuma);
      lastTransferredWasWebCodecs = false;
      app.workerBusy = true;
      ensureWorker().postMessage(
        {
          type: 'frame',
          frameId: ++app.frameId,
          width: app.frameWidth,
          height: app.frameHeight,
          byteOffset: 0,
          tCaptureMs: 0.0,
          debug: true,
          buffer: copy.buffer,
        },
        [copy.buffer]
      );
    }
  }
});

els.btnInventbar.addEventListener('click', () => {
  runRandomInventBar();
});

els.btnUboat.addEventListener('click', () => {
  runNextUboatGrid();
});

els.btnSynth.addEventListener('click', () => {
  runNextSynthetic();
});

els.btnFile.addEventListener('click', () => {
  els.fileInput.value = '';
  els.fileInput.click();
});

els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (file) openLocalImageFile(file);
});

els.btnTorch.addEventListener('click', async () => {
  if (!app.camera || !app.camera.hasTorch) return;
  const next = !app.torchOn;
  const ok = await setTorch(app.camera.track, next);
  if (ok) {
    app.torchOn = next;
    els.btnTorch.textContent = next ? 'Torch ON' : 'Torch';
  }
});

els.btnCapture.addEventListener('click', () => {
  if (app.state === 'SCANNING') {
    app.pendingPgmCapture = true;
  }
});

els.btnHistoryToggle.addEventListener('click', () => {
  const collapsed = els.historyPanel.classList.toggle('collapsed');
  els.btnHistoryToggle.textContent = collapsed ? 'Show' : 'Hide';
});

els.btnHistoryCopy.addEventListener('click', () => {
  if (app.history.length === 0) return;
  const text = app.history.map((h) => h.payload).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      els.btnHistoryCopy.textContent = 'Copied!';
      setTimeout(() => { els.btnHistoryCopy.textContent = 'Copy All'; }, 1000);
    }).catch(() => {});
  }
});

els.btnHistoryClear.addEventListener('click', () => {
  app.history.length = 0;
  app.seenPayloads.clear();
  app.lastFrameNewPayloads.clear();
  app.totalDecodeCount = 0;
  app.lastPayload = null;
  renderHistory();
  if (app.lastResult) drawHudOverlay(app.lastResult);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    runRandomInventBar();
  }
});

window.addEventListener('resize', () => {
  if (app.lastResult) drawHudOverlay(app.lastResult);
});

setStatus('IDLE', 'Ready — Start Camera, Random InventBar (Space), or Open Image');
