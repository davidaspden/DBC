/**
 * Camera enumeration, exclusive per-device capability probing, resolution trials,
 * zoom sweep (framing-jump / logical-camera hint), and conservative rear-lens classification.
 *
 * Raw deviceId strings are NEVER written into the returned report objects; only 12-char
 * SHA-256 hashes are exposed in reports.
 */

import { stopCamera } from '../camera.js';
import { hashDeviceId } from './hash.js';

const CAPABILITY_KEYS = [
  'width',
  'height',
  'frameRate',
  'aspectRatio',
  'zoom',
  'focusMode',
  'focusDistance',
  'exposureMode',
  'exposureTime',
  'exposureCompensation',
  'iso',
  'torch',
  'whiteBalanceMode',
  'pointsOfInterest',
  'facingMode',
];

const RESOLUTION_TRIALS = [
  { name: '720p', width: 1280, height: 720 },
  { name: '1080p', width: 1920, height: 1080 },
  { name: '4K', width: 3840, height: 2160 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function roundNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

function cloneCapValue(val) {
  if (val === undefined || val === null) return 'n/a';
  if (Array.isArray(val)) return val.slice();
  if (typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val)) {
      out[k] = roundNum(val[k]);
    }
    return out;
  }
  return typeof val === 'number' ? roundNum(val) : val;
}

function extractCapabilities(track) {
  const raw = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const caps = {};
  for (const key of CAPABILITY_KEYS) {
    caps[key] = raw && key in raw ? cloneCapValue(raw[key]) : 'n/a';
  }
  return caps;
}

function inferFacing(label, settings, caps) {
  if (settings && typeof settings.facingMode === 'string' && settings.facingMode) {
    return settings.facingMode;
  }
  if (caps && Array.isArray(caps.facingMode) && caps.facingMode.length > 0) {
    return caps.facingMode[0];
  }
  const low = (label || '').toLowerCase();
  if (low.includes('back') || low.includes('rear') || low.includes('environment')) return 'environment';
  if (low.includes('front') || low.includes('user') || low.includes('selfie')) return 'user';
  return 'unknown';
}

async function waitForVideoReady(videoEl, timeoutMs = 2500) {
  if (videoEl.videoWidth > 0 && videoEl.readyState >= 2) return;
  await withTimeout(
    new Promise((resolve) => {
      const done = () => {
        videoEl.removeEventListener('loadeddata', done);
        videoEl.removeEventListener('loadedmetadata', done);
        resolve();
      };
      videoEl.addEventListener('loadeddata', done, { once: true });
      videoEl.addEventListener('loadedmetadata', done, { once: true });
    }),
    timeoutMs,
    'video-ready-timeout'
  );
}

/**
 * Samples a tiny 24x16 grayscale fingerprint + mean luma from `videoEl` to detect
 * abrupt lens handovers (framing/brightness jump) during a zoom sweep.
 */
function captureMiniSignature(videoEl, canvas) {
  if (!videoEl || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) return null;
  const w = 24;
  const h = 16;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(videoEl, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const luma = new Uint8Array(w * h);
  let sum = 0;
  for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
    const y = (77 * data[j] + 150 * data[j + 1] + 29 * data[j + 2]) >> 8;
    luma[i] = y;
    sum += y;
  }
  return { luma, mean: sum / luma.length };
}

function signatureDiff(a, b) {
  if (!a || !b || a.luma.length !== b.luma.length) return 0;
  // Normalize mean shift before computing MAE so pure brightness shifts and framing jumps both register
  let sad = 0;
  for (let i = 0; i < a.luma.length; i++) {
    sad += Math.abs(a.luma[i] - b.luma[i]);
  }
  return sad / a.luma.length;
}

/**
 * Initial camera permission grant (requesting rear camera + zoom/PTZ where offered).
 */
export async function requestCameraAccess() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return { granted: false, error: 'MediaDevicesUnavailable', stream: null, zoomRequested: false };
  }

  // First try with `zoom: true` (Chrome PTZ permission unlocks zoom capabilities on Android)
  try {
    const stream = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          zoom: true,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      }),
      15000,
      'permission-timeout'
    );
    return { granted: true, error: null, stream, zoomRequested: true };
  } catch (err) {
    const name = err && err.name ? err.name : String(err);
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'NotFoundError') {
      return { granted: false, error: name, stream: null, zoomRequested: true };
    }
    // Retry without `zoom: true` for browsers that reject PTZ constraint keys
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        }),
        10000,
        'permission-timeout'
      );
      return { granted: true, error: null, stream, zoomRequested: false };
    } catch (err2) {
      return {
        granted: false,
        error: err2 && err2.name ? err2.name : String(err2),
        stream: null,
        zoomRequested: false,
      };
    }
  }
}

async function openDeviceTrack(rawDeviceId, width, height, requestZoom) {
  const video = {
    width: { ideal: width },
    height: { ideal: height },
  };
  if (rawDeviceId) {
    video.deviceId = { exact: rawDeviceId };
  }
  if (requestZoom) {
    video.zoom = true;
  }
  try {
    return await withTimeout(
      navigator.mediaDevices.getUserMedia({ video, audio: false }),
      3000,
      'getUserMedia-timeout'
    );
  } catch (err) {
    if (requestZoom && err && err.name !== 'NotAllowedError' && err.name !== 'NotFoundError') {
      delete video.zoom;
      return await withTimeout(
        navigator.mediaDevices.getUserMedia({ video, audio: false }),
        3000,
        'getUserMedia-timeout'
      );
    }
    throw err;
  }
}

function buildZoomSteps(zoomCap) {
  const min = zoomCap.min;
  const max = zoomCap.max;
  const step = zoomCap.step || 0.1;
  const raw = [min, 2, 3, 5, (min + max) * 0.5, max];
  const clamped = [];
  for (const v of raw) {
    if (v < min - 1e-6 || v > max + 1e-6) continue;
    const snapped = Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
    const rounded = roundNum(snapped);
    if (!clamped.some((c) => Math.abs(c - rounded) < 0.05)) {
      clamped.push(rounded);
    }
  }
  clamped.sort((a, b) => a - b);
  return clamped.slice(0, 5);
}

/**
 * Conservatively classifies rear cameras by capabilities (never trusting `camera2 N` indices).
 */
export function classifyCameras(cameras) {
  const rear = cameras.filter((c) => c.facing === 'environment');
  if (rear.length === 0) {
    for (const cam of cameras) {
      cam.roleGuess = cam.facing === 'user' ? 'FRONT' : 'WEBCAM?';
    }
    return cameras;
  }

  let maxAfWidth = 0;
  let mainCam = null;

  for (const cam of rear) {
    const wMax = cam.capabilities && cam.capabilities.width && typeof cam.capabilities.width.max === 'number'
      ? cam.capabilities.width.max
      : (cam.settings && cam.settings.width ? cam.settings.width : 0);
    const fm = cam.capabilities && Array.isArray(cam.capabilities.focusMode) ? cam.capabilities.focusMode : [];
    const hasAf = fm.includes('continuous') || fm.includes('single-shot');
    cam._hasAf = hasAf;
    cam._wMax = wMax;

    if (hasAf && wMax > maxAfWidth) {
      maxAfWidth = wMax;
      mainCam = cam;
    }
  }
  // If no rear camera advertised focusMode, fall back to highest max width
  if (!mainCam) {
    for (const cam of rear) {
      if (cam._wMax > maxAfWidth) {
        maxAfWidth = cam._wMax;
        mainCam = cam;
      }
    }
  }

  const mainMinFocus = mainCam && mainCam.capabilities && typeof mainCam.capabilities.focusDistance === 'object'
    ? mainCam.capabilities.focusDistance.min
    : null;

  for (const cam of cameras) {
    if (cam.facing !== 'environment') {
      cam.roleGuess = cam.facing === 'user' ? 'FRONT' : 'UNKNOWN';
      continue;
    }
    if (cam.error) {
      cam.roleGuess = 'UNAVAILABLE';
      continue;
    }
    const wMax = cam._wMax || 0;
    const hasAf = Boolean(cam._hasAf);
    const fdMin = cam.capabilities && typeof cam.capabilities.focusDistance === 'object'
      ? cam.capabilities.focusDistance.min
      : null;

    if (cam === mainCam) {
      cam.roleGuess = 'MAIN?';
      cam.suitable = wMax >= 1280;
    } else if (wMax > 0 && wMax < 1280) {
      cam.roleGuess = 'MACRO/DEPTH?';
      cam.suitable = false;
      cam.unsuitableReason = 'low resolution (<1280px)';
    } else if (!hasAf && wMax > 0 && wMax <= 2600) {
      cam.roleGuess = 'MACRO/DEPTH?';
      cam.suitable = false;
      cam.unsuitableReason = 'low resolution or no AF';
    } else if (
      hasAf &&
      typeof fdMin === 'number' &&
      fdMin >= 0.18 &&
      (typeof mainMinFocus !== 'number' || fdMin > mainMinFocus * 1.4)
    ) {
      cam.roleGuess = 'TELE?';
      cam.suitable = true;
    } else if (mainCam && wMax > 0 && wMax < maxAfWidth * 0.85) {
      cam.roleGuess = 'ULTRAWIDE?';
      cam.suitable = hasAf && wMax >= 1280;
      if (!hasAf) cam.unsuitableReason = 'no AF';
    } else {
      cam.roleGuess = 'REAR-AUX?';
      cam.suitable = hasAf && wMax >= 1280;
    }
  }

  // Strip temporary internal fields
  for (const cam of cameras) {
    delete cam._hasAf;
    delete cam._wMax;
  }
  return cameras;
}

/**
 * Probes every enumerated videoinput exclusively (releasing each track before opening the next).
 * Returns `{ cameras: CameraReport[], deviceMap: Map<idHash, rawDeviceId> }`.
 *
 * @param {HTMLVideoElement} previewEl
 * @param {{ onProgress?: (i: number, total: number, label: string) => void, zoomRequested?: boolean }} [opts]
 */
export async function probeCameras(previewEl, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const zoomRequested = opts.zoomRequested !== false;

  if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return { cameras: [], deviceMap: new Map() };
  }

  const all = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = all.filter((d) => d.kind === 'videoinput');
  const cameras = [];
  const deviceMap = new Map();
  const sigCanvas = document.createElement('canvas');

  for (let i = 0; i < videoInputs.length; i++) {
    const dev = videoInputs[i];
    const idHash = await hashDeviceId(dev.deviceId);
    const groupHash = await hashDeviceId(dev.groupId);
    if (dev.deviceId) {
      deviceMap.set(idHash, dev.deviceId);
    }
    if (onProgress) onProgress(i + 1, videoInputs.length, dev.label || `camera ${i + 1}`);

    const entry = {
      index: i,
      label: dev.label || '(unlabeled camera)',
      idHash,
      groupHash,
      facing: inferFacing(dev.label, null, null),
      roleGuess: 'UNKNOWN',
      suitable: true,
      unsuitableReason: null,
      capabilities: null,
      settings: null,
      resolutions: {},
      zoomSweep: null,
      error: null,
    };

    // Ensure previous preview stream is fully stopped before exclusive open
    if (previewEl && previewEl.srcObject) {
      stopCamera(previewEl.srcObject);
      previewEl.srcObject = null;
    }

    let stream = null;
    try {
      stream = await openDeviceTrack(dev.deviceId, 1920, 1080, zoomRequested);
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('NoVideoTrack');

      if (previewEl) {
        previewEl.srcObject = stream;
        previewEl.playsInline = true;
        previewEl.muted = true;
        await previewEl.play().catch(() => {});
        await waitForVideoReady(previewEl, 2500).catch(() => {});
      }

      // Some Android HALs populate capabilities only after the first rendered frame
      let rawCaps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
      if (!rawCaps || Object.keys(rawCaps).length === 0) {
        await sleep(180);
      }

      const caps = extractCapabilities(track);
      const rawSettings = typeof track.getSettings === 'function' ? track.getSettings() : {};
      const settingsIdHash = await hashDeviceId(rawSettings.deviceId || dev.deviceId);

      entry.capabilities = caps;
      entry.settings = {
        width: rawSettings.width || (previewEl ? previewEl.videoWidth : 0) || 0,
        height: rawSettings.height || (previewEl ? previewEl.videoHeight : 0) || 0,
        frameRate: roundNum(rawSettings.frameRate || 0),
        zoom: rawSettings.zoom !== undefined ? roundNum(rawSettings.zoom) : 'n/a',
        focusMode: rawSettings.focusMode || 'n/a',
        facingMode: rawSettings.facingMode || 'n/a',
        deviceIdHash: settingsIdHash,
      };
      entry.facing = inferFacing(dev.label, rawSettings, caps);

      const shouldProbeExtended = entry.facing === 'environment' || videoInputs.length === 1;

      // Zoom sweep (rear only, when zoom capability is exposed)
      if (shouldProbeExtended && caps.zoom && typeof caps.zoom === 'object' && caps.zoom.max > caps.zoom.min) {
        const steps = buildZoomSteps(caps.zoom);
        const sweepSteps = [];
        let prevSig = null;
        let prevExpAvail = caps.exposureTime !== 'n/a';
        let prevFocusMin = typeof caps.focusDistance === 'object' ? caps.focusDistance.min : null;
        let framingJumpDetected = false;
        let capsChangedDetected = false;

        for (const z of steps) {
          try {
            await track.applyConstraints({ advanced: [{ zoom: z }] });
            await sleep(200);
            const st = typeof track.getSettings === 'function' ? track.getSettings() : {};
            const curCaps = extractCapabilities(track);
            const curExpAvail = curCaps.exposureTime !== 'n/a';
            const curFocusMin = typeof curCaps.focusDistance === 'object' ? curCaps.focusDistance.min : null;
            const sig = previewEl ? captureMiniSignature(previewEl, sigCanvas) : null;
            const diff = prevSig && sig ? roundNum(signatureDiff(prevSig, sig)) : 0;
            const meanDelta = prevSig && sig ? roundNum(Math.abs(sig.mean - prevSig.mean)) : 0;

            const capDelta =
              curExpAvail !== prevExpAvail ||
              (typeof curFocusMin === 'number' && typeof prevFocusMin === 'number' && Math.abs(curFocusMin - prevFocusMin) > 0.03);
            if (capDelta) capsChangedDetected = true;
            // A framing/exposure discontinuity > 28 luma MAE with a mean jump hints at physical lens handover
            if (prevSig && (diff > 32 || (diff > 20 && meanDelta > 12))) {
              framingJumpDetected = true;
            }

            sweepSteps.push({
              requested: z,
              achieved: st.zoom !== undefined ? roundNum(st.zoom) : z,
              meanLuma: sig ? roundNum(sig.mean) : null,
              frameDiff: diff,
              capDelta,
            });
            prevSig = sig;
            prevExpAvail = curExpAvail;
            prevFocusMin = curFocusMin;
          } catch (zErr) {
            sweepSteps.push({
              requested: z,
              error: zErr && zErr.name ? zErr.name : String(zErr),
            });
          }
        }

        // Reset zoom back to min
        try {
          await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
        } catch {}

        entry.zoomSweep = {
          steps: sweepSteps,
          framingJumpDetected,
          capsChangedDetected,
          logicalZoomLikely: caps.zoom.max >= 3 && (framingJumpDetected || capsChangedDetected),
        };
      }

      // Release default track before resolution trials so each trial opens cleanly
      stopCamera(stream);
      stream = null;
      if (previewEl) previewEl.srcObject = null;

      // Resolution trials (720p, 1080p, 4K) on rear cameras (or lone desktop webcam)
      if (shouldProbeExtended) {
        for (const trial of RESOLUTION_TRIALS) {
          let tStream = null;
          try {
            tStream = await openDeviceTrack(dev.deviceId, trial.width, trial.height, false);
            const tTrack = tStream.getVideoTracks()[0];
            if (previewEl) {
              previewEl.srcObject = tStream;
              await previewEl.play().catch(() => {});
              await waitForVideoReady(previewEl, 2000).catch(() => {});
            }
            const ts = typeof tTrack.getSettings === 'function' ? tTrack.getSettings() : {};
            entry.resolutions[trial.name] = {
              ok: true,
              width: ts.width || (previewEl ? previewEl.videoWidth : 0) || 0,
              height: ts.height || (previewEl ? previewEl.videoHeight : 0) || 0,
              frameRate: roundNum(ts.frameRate || 0),
            };
          } catch (rErr) {
            entry.resolutions[trial.name] = {
              ok: false,
              error: rErr && rErr.name ? rErr.name : String(rErr),
            };
          } finally {
            if (tStream) stopCamera(tStream);
            if (previewEl) previewEl.srcObject = null;
          }
        }
      }
    } catch (err) {
      entry.error = err && err.name ? err.name : String(err);
    } finally {
      if (stream) stopCamera(stream);
      if (previewEl) previewEl.srcObject = null;
    }

    cameras.push(entry);
  }

  classifyCameras(cameras);
  return { cameras, deviceMap };
}
