/**
 * M7a — `ar.html` Live Raw Dotted-Wall Capture Controller (`src/ar/app.js`).
 *
 * Wave 1 scope:
 *  - Strictly gated behind `arWall` sim flag (`resolveSimFlags` via `evaluateArPageAccess`).
 *    When off, displays "AR wall mode is disabled" and never starts camera or sensors.
 *  - Reuses `src/camera.js` (`startCamera`, `stopCamera`, `setExposure`, `getExposureInfo`,
 *    `setTorch`, `listVideoDevices`, `pickBackCameras`) with zero edits to `camera.js`.
 *  - Reuses `src/array/orient.js` (`createOrientationTracker`, `extractPanTiltRollDeg`) plus
 *    a passive `devicemotion` listener for raw gyro/accel recording.
 *  - Reuses `src/ar/layout.js` (M0) with live layout editor persisted to `localStorage`.
 *  - Reuses `src/ar/tape.js` (wrapping `src/tape/record.js`) to record raw uncomposited
 *    Y-plane frames + sensors + `meta.camera` and download `.dbct` + `.layout.json` sidecar.
 */

import { SIM_STORAGE_KEY } from '../sim/simflags.js';
import {
  startCamera,
  stopCamera,
  listVideoDevices,
  pickBackCameras,
  setTorch,
  getExposureInfo,
  setExposure,
} from '../camera.js';
import { formatExposureLabel } from '../capture/exposure.js';
import { createOrientationTracker, extractPanTiltRollDeg } from '../array/orient.js';
import { readRealFrameSize, syncOverlayCanvasSize } from '../ui/frame-map.js';
import {
  createArLayout,
  saveArLayoutToStorage,
  loadArLayoutFromStorage,
  serializeArLayout,
  deserializeArLayout,
} from './layout.js';
import { createArTapeRecorder, extractCameraMeta } from './tape.js';
import {
  evaluateArPageAccess,
  buildLayoutFromEditorInput,
  createFpsMeter,
  computeCentreBandCrop,
  estimateRecordingBudget,
  computePreviewWallTransform,
} from './app-logic.js';

const YUV_Y_FIRST_FORMATS = new Set(['I420', 'I420A', 'NV12', 'I422', 'I444']);

function readStoredSimFlags() {
  try {
    const raw = localStorage.getItem(SIM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function bootArPage() {
  const disabledView = document.getElementById('ar-disabled-view');
  const appView = document.getElementById('ar-app-view');
  const disabledMsgEl = document.getElementById('ar-disabled-msg');

  const access = evaluateArPageAccess({
    search: window.location.search,
    stored: readStoredSimFlags(),
  });

  if (!access.enabled) {
    if (disabledMsgEl) disabledMsgEl.textContent = access.message;
    if (disabledView) disabledView.hidden = false;
    if (appView) appView.hidden = true;
    return;
  }

  if (disabledView) disabledView.hidden = true;
  if (appView) appView.hidden = false;

  // DOM references
  const videoEl = document.getElementById('cam-video');
  const overlayCanvas = document.getElementById('cam-overlay');
  const overlayCtx = overlayCanvas.getContext('2d');
  const schematicCanvas = document.getElementById('layout-schematic');
  const schematicCtx = schematicCanvas.getContext('2d');

  const btnCamera = document.getElementById('btn-camera');
  const btnRecord = document.getElementById('btn-record');
  const btnDownloadSidecar = document.getElementById('btn-download-sidecar');
  const btnTorch = document.getElementById('btn-torch');
  const btnFastShutter = document.getElementById('btn-fast-shutter');
  const selCamera = document.getElementById('sel-camera');
  const selRes = document.getElementById('sel-res');
  const selCrop = document.getElementById('sel-crop');
  const selEveryNth = document.getElementById('sel-everynth');
  const inpLighting = document.getElementById('inp-lighting');
  const inpNotes = document.getElementById('inp-notes');

  const hudStatus = document.getElementById('hud-status');
  const hudRes = document.getElementById('hud-res');
  const hudFps = document.getElementById('hud-fps');
  const hudExp = document.getElementById('hud-exp');
  const hudSensor = document.getElementById('hud-sensor');
  const hudRec = document.getElementById('hud-rec');
  const hudBudget = document.getElementById('hud-budget');
  const hudFlags = document.getElementById('hud-flags');

  // Layout editor controls
  const edTier = document.getElementById('ed-tier');
  const edCols = document.getElementById('ed-cols');
  const edRows = document.getElementById('ed-rows');
  const edPitchX = document.getElementById('ed-pitchx');
  const edPitchY = document.getElementById('ed-pitchy');
  const edSpacing = document.getElementById('ed-spacing');
  const edDia = document.getElementById('ed-dia');
  const edPolarity = document.getElementById('ed-polarity');
  const edMeasXs = document.getElementById('ed-meas-xs');
  const edMeasYs = document.getElementById('ed-meas-ys');
  const edDotOverrides = document.getElementById('ed-dot-overrides');
  const edWarnings = document.getElementById('ed-warnings');
  const edSummary = document.getElementById('ed-summary');
  const btnApplyLayout = document.getElementById('btn-apply-layout');
  const btnResetLayout = document.getElementById('btn-reset-layout');
  const btnExportLayout = document.getElementById('btn-export-layout');
  const inpImportLayout = document.getElementById('inp-import-layout');

  const activeFlagNames = Object.keys(access.flags).filter((k) => access.flags[k]);
  hudFlags.textContent = `Flags: ${activeFlagNames.join(', ') || 'none'}`;

  // Persistent M0 layout state
  let currentLayout = loadArLayoutFromStorage() || createArLayout();

  // Camera, capture & sensor state
  const orient = createOrientationTracker({ gravityZero: false });
  const fpsMeter = createFpsMeter(1000);
  const anglesTmp = { panDeg: 0, tiltDeg: 0, rollDeg: 0 };

  const state = {
    running: false,
    stream: null,
    track: null,
    frameW: 1280,
    frameH: 720,
    torchOn: false,
    fastShutterOn: false,
    frameId: 0,
    useWebCodecs: typeof VideoFrame !== 'undefined',
    webcodecsBuf: null,
    lumaBuf: null,
    fallbackCanvas: null,
    fallbackCtx: null,
    recording: false,
    recorder: null,
    lastTapeBaseName: null,
    captureBusy: false,
    lastAccel: null,
    lastRotRate: null,
    dmListener: null,
    rafUiId: 0,
  };

  function setStatus(msg, level = 'info') {
    hudStatus.textContent = msg;
    hudStatus.dataset.level = level;
  }

  function populateEditorFromLayout(layout) {
    edTier.value = layout.config.tier;
    edCols.value = String(layout.config.cols);
    edRows.value = String(layout.config.rows);
    edPitchX.value = String(layout.config.pitchX);
    edPitchY.value = String(layout.config.pitchY);
    edSpacing.value = layout.config.spacingIn !== null ? String(layout.config.spacingIn) : '';
    edDia.value = String(layout.config.dotDiameterIn);
    edPolarity.value = layout.config.polarity;
    edMeasXs.value = Array.isArray(layout.measured?.xs) ? layout.measured.xs.join(', ') : '';
    edMeasYs.value = Array.isArray(layout.measured?.ys) ? layout.measured.ys.join(', ') : '';
    edDotOverrides.value = Array.isArray(layout.measured?.dots) && layout.measured.dots.length > 0
      ? JSON.stringify(layout.measured.dots)
      : '';
    renderLayoutSummaryAndWarnings(layout, []);
    drawLayoutSchematic(layout);
  }

  function renderLayoutSummaryAndWarnings(layout, parseErrors) {
    if (parseErrors && parseErrors.length > 0) {
      edWarnings.textContent = `Errors: ${parseErrors.join(' | ')}`;
      edWarnings.dataset.level = 'error';
      return;
    }
    edSummary.textContent =
      `${layout.layoutId} — ${layout.wallWidthIn}" × ${layout.wallHeightIn}" — ` +
      `${layout.counts.total} dots (corners: ${layout.counts.corners}, ` +
      `label-offset: ${layout.counts.labelOffsets}, grid: ${layout.counts.gridDots})`;
    if (layout.warnings.length > 0) {
      edWarnings.textContent = `Warnings (${layout.warnings.length}): ` +
        layout.warnings.map((w) => w.message).join(' | ');
      edWarnings.dataset.level = 'warn';
    } else {
      edWarnings.textContent = 'No layout tolerance warnings.';
      edWarnings.dataset.level = 'ok';
    }
  }

  function drawLayoutSchematic(layout) {
    const w = schematicCanvas.width;
    const h = schematicCanvas.height;
    schematicCtx.clearRect(0, 0, w, h);

    const isLightOnDark = layout.config.polarity === 'light-on-dark';
    schematicCtx.fillStyle = isLightOnDark ? '#111827' : '#f8fafc';
    schematicCtx.fillRect(0, 0, w, h);

    const tf = computePreviewWallTransform(layout.wallWidthIn, layout.wallHeightIn, w, h, 20);

    // Tote grid lines
    schematicCtx.strokeStyle = isLightOnDark ? '#334155' : '#cbd5e1';
    schematicCtx.lineWidth = 1;
    schematicCtx.strokeRect(tf.offsetX, tf.offsetY, tf.drawW, tf.drawH);
    for (let c = 1; c < layout.toteNominalXs.length - 1; c++) {
      const x = tf.offsetX + layout.toteNominalXs[c] * tf.scale;
      schematicCtx.beginPath();
      schematicCtx.moveTo(x, tf.offsetY);
      schematicCtx.lineTo(x, tf.offsetY + tf.drawH);
      schematicCtx.stroke();
    }
    for (let r = 1; r < layout.toteNominalYs.length - 1; r++) {
      const y = tf.offsetY + layout.toteNominalYs[r] * tf.scale;
      schematicCtx.beginPath();
      schematicCtx.moveTo(tf.offsetX, y);
      schematicCtx.lineTo(tf.offsetX + tf.drawW, y);
      schematicCtx.stroke();
    }

    // Label centre markers (faint rectangles)
    schematicCtx.strokeStyle = 'rgba(16, 185, 129, 0.5)';
    for (let i = 0; i < layout.labels.length; i++) {
      const lb = layout.labels[i];
      const lx = tf.offsetX + lb.x * tf.scale;
      const ly = tf.offsetY + lb.y * tf.scale;
      schematicCtx.strokeRect(lx - 5, ly - 8, 10, 16);
    }

    // Marker dots
    for (let i = 0; i < layout.dots.length; i++) {
      const d = layout.dots[i];
      const cx = tf.offsetX + d.x * tf.scale;
      const cy = tf.offsetY + d.y * tf.scale;
      const r = Math.max(2.2, (d.diameterIn * 0.5) * tf.scale);
      schematicCtx.beginPath();
      schematicCtx.arc(cx, cy, r, 0, Math.PI * 2);
      if (d.landmark === 'origin') schematicCtx.fillStyle = '#ef4444';
      else if (d.landmark === 'axis') schematicCtx.fillStyle = '#f59e0b';
      else if (d.landmark === 'corner') schematicCtx.fillStyle = '#14b8a6';
      else schematicCtx.fillStyle = isLightOnDark ? '#f8fafc' : '#0f172a';
      schematicCtx.fill();
    }
  }

  function updateBudgetHint() {
    const [reqW, reqH] = selRes.value.split('x').map((v) => Number.parseInt(v, 10));
    const useCrop = selCrop.value === 'centre60';
    const crop = useCrop ? computeCentreBandCrop(reqW, reqH, 0.6) : { width: reqW, height: reqH };
    const everyNth = Number.parseInt(selEveryNth.value, 10) || 1;
    const est = estimateRecordingBudget({
      width: crop.width,
      height: crop.height,
      fps: 30,
      everyNth,
      durationSec: 60,
    });
    hudBudget.textContent =
      `60s est (${crop.width}x${crop.height}, 1/${everyNth}): ` +
      `~${est.estLowMb}–${est.estHighMb} MB gzip (raw ${est.rawTotalMb} MB)` +
      (est.recommendDownscale ? ' — use 720p or crop for long sessions' : '');
  }

  function ensureCaptureBuffers(w, h) {
    state.frameW = w;
    state.frameH = h;
    if (!state.lumaBuf || state.lumaBuf.byteLength !== w * h) {
      state.lumaBuf = new Uint8Array(w * h);
    }
    if (!state.fallbackCanvas || state.fallbackCanvas.width !== w || state.fallbackCanvas.height !== h) {
      state.fallbackCanvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      state.fallbackCtx = state.fallbackCanvas.getContext('2d', { willReadFrequently: true });
    }
  }

  function startRawMotionListener() {
    if (state.dmListener || typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;
    state.dmListener = (ev) => {
      if (ev.accelerationIncludingGravity) {
        state.lastAccel = {
          x: ev.accelerationIncludingGravity.x,
          y: ev.accelerationIncludingGravity.y,
          z: ev.accelerationIncludingGravity.z,
        };
      }
      if (ev.rotationRate) {
        state.lastRotRate = {
          alpha: ev.rotationRate.alpha,
          beta: ev.rotationRate.beta,
          gamma: ev.rotationRate.gamma,
        };
      }
    };
    window.addEventListener('devicemotion', state.dmListener, { passive: true });
  }

  function stopRawMotionListener() {
    if (state.dmListener && typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', state.dmListener);
      state.dmListener = null;
    }
  }

  async function refreshCameraList() {
    const devices = await listVideoDevices();
    const rear = pickBackCameras(devices);
    const ordered = rear.length > 0 ? rear.concat(devices.filter((d) => !rear.includes(d))) : devices;
    const prev = selCamera.value;
    selCamera.innerHTML = '<option value="">Auto (Rear Main)</option>';
    for (let i = 0; i < ordered.length; i++) {
      const d = ordered[i];
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      selCamera.appendChild(opt);
    }
    if (prev) selCamera.value = prev;
  }

  function drawCameraOverlay() {
    const sync = syncOverlayCanvasSize(overlayCanvas, videoEl);
    if (!sync.ok) return;
    overlayCtx.setTransform(sync.dpr, 0, 0, sync.dpr, 0, 0);
    overlayCtx.clearRect(0, 0, sync.cssW, sync.cssH);

    // Subtle framing guide / centre-crop band preview
    const useCrop = selCrop.value === 'centre60';
    const frac = useCrop ? 0.6 : 0.85;
    const gw = sync.cssW * frac;
    const gh = sync.cssH * frac;
    const gx = (sync.cssW - gw) * 0.5;
    const gy = (sync.cssH - gh) * 0.5;

    overlayCtx.strokeStyle = state.recording ? 'rgba(239, 68, 68, 0.9)' : 'rgba(56, 189, 248, 0.75)';
    overlayCtx.lineWidth = state.recording ? 2.5 : 1.5;
    overlayCtx.setLineDash(useCrop ? [6, 4] : [10, 8]);
    overlayCtx.strokeRect(gx, gy, gw, gh);
    overlayCtx.setLineDash([]);

    // Centre crosshair
    const cx = sync.cssW * 0.5;
    const cy = sync.cssH * 0.5;
    overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    overlayCtx.moveTo(cx - 12, cy);
    overlayCtx.lineTo(cx + 12, cy);
    overlayCtx.moveTo(cx, cy - 12);
    overlayCtx.lineTo(cx, cy + 12);
    overlayCtx.stroke();

    if (access.flags.arShowDots) {
      overlayCtx.fillStyle = 'rgba(15, 23, 42, 0.7)';
      overlayCtx.fillRect(10, 10, 260, 24);
      overlayCtx.fillStyle = '#38bdf8';
      overlayCtx.font = '12px monospace';
      overlayCtx.fillText(`arShowDots active (Wave 1 preview — ${currentLayout.counts.total} dots)`, 16, 26);
    }

    if (state.recording && state.recorder) {
      const st = state.recorder.getStats();
      overlayCtx.fillStyle = 'rgba(220, 38, 38, 0.88)';
      overlayCtx.fillRect(10, sync.cssH - 34, 210, 24);
      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.font = 'bold 12px monospace';
      overlayCtx.fillText(`REC RAW ${st.frameCount}f | ${st.storedMb.toFixed(1)} MB | ${st.durationSec.toFixed(1)}s`, 18, sync.cssH - 18);
    }
  }

  async function captureOneFrame(tFrameMs) {
    if (!state.running || !state.recording || !state.recorder || state.captureBusy) return;
    state.captureBusy = true;
    try {
      const realSize = readRealFrameSize(videoEl, state.track, null, state.frameW, state.frameH);
      const fullW = realSize.width || state.frameW;
      const fullH = realSize.height || state.frameH;

      const useCrop = selCrop.value === 'centre60';
      const cropRect = useCrop ? computeCentreBandCrop(fullW, fullH, 0.6) : null;
      const sendW = cropRect ? cropRect.width : fullW;
      const sendH = cropRect ? cropRect.height : fullH;
      const cropX = cropRect ? cropRect.x : 0;
      const cropY = cropRect ? cropRect.y : 0;

      ensureCaptureBuffers(sendW, sendH);
      const outLuma = state.lumaBuf;
      let copied = false;

      if (state.useWebCodecs) {
        let vf = null;
        try {
          vf = new VideoFrame(videoEl);
          if (!vf.format || !YUV_Y_FIRST_FORMATS.has(vf.format)) {
            state.useWebCodecs = false;
          } else {
            const copyOpts = cropRect ? { rect: cropRect } : undefined;
            const allocSize = copyOpts ? vf.allocationSize(copyOpts) : vf.allocationSize();
            if (!state.webcodecsBuf || state.webcodecsBuf.byteLength < allocSize) {
              state.webcodecsBuf = new Uint8Array(allocSize);
            }
            const layouts = copyOpts
              ? await vf.copyTo(state.webcodecsBuf, copyOpts)
              : await vf.copyTo(state.webcodecsBuf);
            const stride = layouts[0].stride;
            const off = layouts[0].offset;
            if (stride === sendW && off === 0) {
              outLuma.set(state.webcodecsBuf.subarray(0, sendW * sendH));
            } else {
              for (let y = 0; y < sendH; y++) {
                const srcOff = off + y * stride;
                outLuma.set(state.webcodecsBuf.subarray(srcOff, srcOff + sendW), y * sendW);
              }
            }
            copied = true;
          }
        } catch {
          state.useWebCodecs = false;
        } finally {
          if (vf) vf.close();
        }
      }

      if (!copied) {
        if (cropRect) {
          state.fallbackCtx.drawImage(videoEl, cropX, cropY, sendW, sendH, 0, 0, sendW, sendH);
        } else {
          state.fallbackCtx.drawImage(videoEl, 0, 0, sendW, sendH);
        }
        const rgba = state.fallbackCtx.getImageData(0, 0, sendW, sendH).data;
        for (let i = 0, j = 0; i < sendW * sendH; i++, j += 4) {
          outLuma[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
        }
      }

      state.frameId++;
      const stOrient = orient.getStatus();
      const qNow = orient.getRelativeQuaternion();
      const measuredFps = fpsMeter.getFps();
      const camMeta = extractCameraMeta(state.track, {
        fps: measuredFps,
        width: sendW,
        height: sendH,
      });

      await state.recorder.pushFrame({
        frameId: state.frameId,
        tFrameMs,
        width: sendW,
        height: sendH,
        cropX,
        cropY,
        luma: outLuma,
        camera: camMeta,
        sensorSample: {
          q: [qNow[0], qNow[1], qNow[2], qNow[3]],
          wPanDps: stOrient.wPanDps,
          wPitchDps: stOrient.wPitchDps,
          source: stOrient.source,
          accel: state.lastAccel ? { ...state.lastAccel } : null,
          rotRate: state.lastRotRate ? { ...state.lastRotRate } : null,
        },
      });
    } finally {
      state.captureBusy = false;
    }
  }

  function scheduleVideoLoop() {
    if (!state.running) return;
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      videoEl.requestVideoFrameCallback((now, metadata) => {
        if (!state.running) return;
        fpsMeter.push(now);
        const ts = (metadata && metadata.captureTime) || now;
        captureOneFrame(ts);
        scheduleVideoLoop();
      });
    } else {
      requestAnimationFrame((now) => {
        if (!state.running) return;
        fpsMeter.push(now);
        captureOneFrame(now);
        scheduleVideoLoop();
      });
    }
  }

  function uiLoop() {
    if (!state.running) return;
    const fps = fpsMeter.getFps();
    hudFps.textContent = `${fps.toFixed(1)} fps`;

    const realSize = readRealFrameSize(videoEl, state.track, null, state.frameW, state.frameH);
    hudRes.textContent = `${realSize.width}×${realSize.height}`;

    const expInfo = getExposureInfo(state.track);
    hudExp.textContent = formatExposureLabel(expInfo);

    const st = orient.getStatus();
    const qRel = orient.getRelativeQuaternion();
    extractPanTiltRollDeg(qRel, anglesTmp);
    hudSensor.textContent = st.active
      ? `${st.source} ${st.measuredHz.toFixed(0)}Hz | P:${anglesTmp.panDeg.toFixed(1)}° T:${anglesTmp.tiltDeg.toFixed(1)}° R:${anglesTmp.rollDeg.toFixed(1)}°`
      : `Sensors: ${st.source || 'inactive'}`;

    if (state.recorder) {
      const rs = state.recorder.getStats();
      hudRec.textContent = state.recording
        ? `REC: ${rs.frameCount} frames | ${rs.storedMb.toFixed(1)} MB | ${rs.durationSec.toFixed(1)}s`
        : `Last tape: ${rs.frameCount} frames (${rs.storedMb.toFixed(1)} MB)`;
    }

    drawCameraOverlay();
    state.rafUiId = requestAnimationFrame(uiLoop);
  }

  async function startCapture() {
    const [reqW, reqH] = selRes.value.split('x').map((v) => Number.parseInt(v, 10));
    setStatus('Starting camera & sensors…');
    try {
      const sensRes = await orient.start();
      startRawMotionListener();
      if (typeof screen !== 'undefined' && screen.orientation) {
        orient.setScreenAngle(screen.orientation.angle || 0);
      }

      const cam = await startCamera(videoEl, {
        deviceId: selCamera.value || null,
        width: reqW || 1280,
        height: reqH || 720,
      });

      state.stream = cam.stream;
      state.track = cam.track;
      state.frameW = cam.width;
      state.frameH = cam.height;
      state.running = true;
      state.torchOn = false;
      state.fastShutterOn = false;
      fpsMeter.reset();

      btnCamera.textContent = 'Stop Camera';
      btnRecord.disabled = false;
      btnTorch.disabled = !cam.hasTorch;
      btnFastShutter.disabled = false;

      await refreshCameraList();
      setStatus(
        `Live ${cam.width}×${cam.height} | Sensors: ${sensRes.ok ? sensRes.source : sensRes.error}`,
        'ok'
      );

      scheduleVideoLoop();
      state.rafUiId = requestAnimationFrame(uiLoop);
    } catch (err) {
      stopCapture();
      setStatus(`Start failed: ${err && err.message ? err.message : String(err)}`, 'error');
    }
  }

  function stopCapture() {
    if (state.recording) {
      stopAndSaveRecording();
    }
    state.running = false;
    if (state.rafUiId) {
      cancelAnimationFrame(state.rafUiId);
      state.rafUiId = 0;
    }
    stopCamera(state.stream);
    state.stream = null;
    state.track = null;
    orient.stop();
    stopRawMotionListener();
    videoEl.srcObject = null;

    btnCamera.textContent = 'Start Camera & Sensors';
    btnRecord.disabled = true;
    btnTorch.disabled = true;
    btnFastShutter.disabled = true;
    setStatus('Stopped');
  }

  function startRecording() {
    if (!state.running) return;
    const everyNth = Number.parseInt(selEveryNth.value, 10) || 1;
    state.frameId = 0;
    state.recorder = createArTapeRecorder({
      layout: currentLayout,
      everyNth,
      device: navigator.userAgent || 'unknown',
      lighting: inpLighting.value.trim(),
      notes: inpNotes.value.trim(),
    });
    state.recorder.start();
    state.recording = true;
    state.lastTapeBaseName = `dbc-ar-raw-${currentLayout.layoutId}-${Date.now()}`;
    btnRecord.textContent = 'Stop & Save Raw Tape';
    btnRecord.classList.add('recording');
    btnDownloadSidecar.disabled = true;
    setStatus('Recording raw dotted-wall frames (no labels)…', 'ok');
  }

  function stopAndSaveRecording() {
    if (!state.recorder || !state.recording) return;
    state.recording = false;
    state.recorder.stop();
    btnRecord.textContent = 'Record Raw Tape (.dbct)';
    btnRecord.classList.remove('recording');

    const st = state.recorder.getStats();
    const base = state.lastTapeBaseName || `dbc-ar-raw-${Date.now()}`;
    if (st.frameCount > 0) {
      const tapeFile = `${base}.dbct`;
      state.recorder.triggerDownload(tapeFile);
      btnDownloadSidecar.disabled = false;
      setStatus(`Saved ${tapeFile} (${st.frameCount} frames, ${st.storedMb.toFixed(1)} MB). Click "Download Layout Sidecar" to save JSON.`, 'ok');
    } else {
      setStatus('Recording stopped (0 frames captured).', 'warn');
    }
  }

  // Event listeners
  btnCamera.addEventListener('click', () => {
    if (state.running) stopCapture();
    else startCapture();
  });

  btnRecord.addEventListener('click', () => {
    if (state.recording) stopAndSaveRecording();
    else startRecording();
  });

  btnDownloadSidecar.addEventListener('click', () => {
    const base = state.lastTapeBaseName || `dbc-ar-raw-${currentLayout.layoutId}-${Date.now()}`;
    if (state.recorder) {
      state.recorder.triggerSidecarDownload(`${base}.layout.json`, {
        tapeFilename: `${base}.dbct`,
        lighting: inpLighting.value.trim(),
        notes: inpNotes.value.trim(),
      });
    } else {
      const blob = new Blob([JSON.stringify(serializeArLayout(currentLayout), null, 2) + '\n'], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${base}.layout.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  btnTorch.addEventListener('click', async () => {
    if (!state.track) return;
    const next = !state.torchOn;
    const ok = await setTorch(state.track, next);
    if (ok) {
      state.torchOn = next;
      btnTorch.textContent = next ? 'Torch: ON' : 'Torch: OFF';
    }
  });

  btnFastShutter.addEventListener('click', async () => {
    if (!state.track) return;
    const next = !state.fastShutterOn;
    const res = await setExposure(state.track, { targetSec: 1 / 250, enableManual: next });
    state.fastShutterOn = next && res.ok;
    btnFastShutter.textContent = state.fastShutterOn ? `Shutter: ${res.mode}` : 'Shutter: Auto';
  });

  selRes.addEventListener('change', updateBudgetHint);
  selCrop.addEventListener('change', updateBudgetHint);
  selEveryNth.addEventListener('change', updateBudgetHint);

  btnApplyLayout.addEventListener('click', () => {
    const res = buildLayoutFromEditorInput({
      tier: edTier.value,
      cols: edCols.value,
      rows: edRows.value,
      pitchX: edPitchX.value,
      pitchY: edPitchY.value,
      spacingIn: edSpacing.value,
      dotDiameterIn: edDia.value,
      polarity: edPolarity.value,
      measuredXsText: edMeasXs.value,
      measuredYsText: edMeasYs.value,
      dotOverridesText: edDotOverrides.value,
    });
    if (!res.ok) {
      renderLayoutSummaryAndWarnings(currentLayout, res.parseErrors);
      return;
    }
    currentLayout = res.layout;
    saveArLayoutToStorage(currentLayout);
    renderLayoutSummaryAndWarnings(currentLayout, []);
    drawLayoutSchematic(currentLayout);
    setStatus(`Saved layout ${currentLayout.layoutId} to localStorage.`, 'ok');
  });

  btnResetLayout.addEventListener('click', () => {
    currentLayout = createArLayout();
    saveArLayoutToStorage(currentLayout);
    populateEditorFromLayout(currentLayout);
    setStatus('Reset AR layout to defaults (4×4, 16×14 in, Tier A).');
  });

  btnExportLayout.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(serializeArLayout(currentLayout), null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentLayout.layoutId}.layout.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  inpImportLayout.addEventListener('change', async () => {
    const file = inpImportLayout.files && inpImportLayout.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const layoutPayload = parsed && parsed.layout ? parsed.layout : parsed;
      currentLayout = deserializeArLayout(layoutPayload);
      saveArLayoutToStorage(currentLayout);
      populateEditorFromLayout(currentLayout);
      setStatus(`Imported layout ${currentLayout.layoutId}.`, 'ok');
    } catch (err) {
      renderLayoutSummaryAndWarnings(currentLayout, [
        `Import failed: ${err && err.message ? err.message : String(err)}`,
      ]);
    } finally {
      inpImportLayout.value = '';
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.running) stopCapture();
  });

  // Initial render
  populateEditorFromLayout(currentLayout);
  updateBudgetHint();
  setStatus('Ready. Tap "Start Camera & Sensors" to preview the dotted wall.');
}
