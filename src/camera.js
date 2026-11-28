/**
 * Phase 4: Camera Capture & Android Chrome Hardware Configuration.
 *
 * - Requests rear camera (`facingMode: 'environment'`) locked to 1280x720
 *   (avoids 4K overhead while preventing 640x480 sub-pixel bar-merging).
 * - Explicitly applies `focusMode: 'continuous'` via `track.applyConstraints()` when supported.
 * - Logs `track.getSettings()` & `track.getCapabilities()` on startup for verification.
 */

export const TARGET_WIDTH = 1280;
export const TARGET_HEIGHT = 720;

/**
 * Lists available video input devices (labels are populated once camera permission is granted).
 */
export async function listVideoDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/**
 * Starts the rear camera stream (or a specific `deviceId`), attaches it to `videoEl`,
 * applies continuous autofocus when supported, and returns active hardware settings.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {{ deviceId?: string | null, width?: number, height?: number }} [opts]
 */
export async function startCamera(videoEl, opts = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('navigator.mediaDevices.getUserMedia is unavailable (requires HTTPS or localhost).');
  }

  const reqWidth = (opts.width | 0) || TARGET_WIDTH;
  const reqHeight = (opts.height | 0) || TARGET_HEIGHT;

  const videoConstraints = {
    width: { ideal: reqWidth },
    height: { ideal: reqHeight },
    frameRate: { ideal: 30, min: 15 },
  };
  if (opts.deviceId) {
    videoConstraints.deviceId = { exact: opts.deviceId };
  } else {
    videoConstraints.facingMode = { ideal: 'environment' };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: videoConstraints,
  });
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopCamera(stream);
    throw new Error('No video track returned by getUserMedia.');
  }

  const capabilities = typeof track.getCapabilities === 'function'
    ? track.getCapabilities()
    : {};

  // Explicitly lock continuous autofocus on Android Chrome when exposed by the camera HAL
  const focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  if (focusModes.includes('continuous')) {
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' }],
      });
    } catch (err) {
      console.warn('[camera] Failed to apply focusMode: continuous:', err);
    }
  }

  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  videoEl.muted = true;
  await videoEl.play();

  // Wait until intrinsic video dimensions are populated
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    await new Promise((resolve) => {
      const onReady = () => {
        videoEl.removeEventListener('loadedmetadata', onReady);
        resolve();
      };
      videoEl.addEventListener('loadedmetadata', onReady, { once: true });
    });
  }

  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
  const width = (settings.width | 0) || (videoEl.videoWidth | 0) || TARGET_WIDTH;
  const height = (settings.height | 0) || (videoEl.videoHeight | 0) || TARGET_HEIGHT;
  const focusMode = settings.focusMode || (focusModes.includes('continuous') ? 'continuous (req)' : 'unsupported');
  const hasTorch = Boolean(capabilities.torch);

  // Required startup diagnostic verification log
  console.info('[camera] Active track.getSettings():', settings);
  console.info('[camera] Track capabilities:', capabilities);

  return {
    stream,
    track,
    settings,
    capabilities,
    width,
    height,
    frameRate: settings.frameRate || 0,
    focusMode,
    facingMode: settings.facingMode || 'unknown',
    hasTorch,
  };
}

/**
 * Toggles rear camera torch/flash when supported by the device.
 * @param {MediaStreamTrack | null} track
 * @param {boolean} enabled
 */
export async function setTorch(track, enabled) {
  if (!track || typeof track.applyConstraints !== 'function') return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: Boolean(enabled) }] });
    return true;
  } catch (err) {
    console.warn('[camera] Torch constraint failed:', err);
    return false;
  }
}

/**
 * C4: Reads live exposure/ISO capabilities and current settings from a video track.
 * Safe on devices that do not expose Image Capture exposure keys.
 *
 * @param {MediaStreamTrack | null} track
 */
export function getExposureInfo(track) {
  const empty = {
    supported: false,
    manualSupported: false,
    mode: 'auto',
    exposureTime: null,
    exposureTimeSec: null,
    min: null,
    max: null,
    step: null,
    iso: null,
    isoMin: null,
    isoMax: null,
    compMin: null,
    compMax: null,
  };
  if (!track) return empty;
  const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
  const sets = typeof track.getSettings === 'function' ? track.getSettings() : {};
  const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
  const expCap = caps.exposureTime && typeof caps.exposureTime === 'object' ? caps.exposureTime : null;
  const isoCap = caps.iso && typeof caps.iso === 'object' ? caps.iso : null;
  const compCap = caps.exposureCompensation && typeof caps.exposureCompensation === 'object' ? caps.exposureCompensation : null;

  const rawExp = typeof sets.exposureTime === 'number' ? sets.exposureTime : null;
  // W3C Image Capture spec reports exposureTime in 100-microsecond units (10,000 = 1 s)
  const expSec = rawExp !== null ? rawExp * 1e-4 : null;

  return {
    supported: Boolean(expCap || modes.length > 0 || compCap),
    manualSupported: Boolean(modes.includes('manual') && expCap),
    mode: sets.exposureMode || 'auto',
    exposureTime: rawExp,
    exposureTimeSec: expSec,
    min: expCap ? expCap.min : null,
    max: expCap ? expCap.max : null,
    step: expCap ? (expCap.step || 1) : null,
    iso: typeof sets.iso === 'number' ? sets.iso : null,
    isoMin: isoCap ? isoCap.min : null,
    isoMax: isoCap ? isoCap.max : null,
    compMin: compCap ? compCap.min : null,
    compMax: compCap ? compCap.max : null,
  };
}

/**
 * C4: Applies manual fast shutter (two-step: mode first, then exposureTime & ISO)
 * or falls back to minimum exposureCompensation when manual mode is unavailable.
 *
 * @param {MediaStreamTrack | null} track
 * @param {{ targetSec?: number, enableManual?: boolean }} [opts]
 */
export async function setExposure(track, opts = {}) {
  if (!track || typeof track.applyConstraints !== 'function') {
    return { ok: false, mode: 'unavailable', info: getExposureInfo(track) };
  }
  const info = getExposureInfo(track);
  const targetSec = opts.targetSec || (1 / 500);
  const wantManual = opts.enableManual !== false;

  if (!wantManual) {
    try {
      await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] });
    } catch {}
    return { ok: true, mode: 'auto', info: getExposureInfo(track) };
  }

  if (info.manualSupported && info.min !== null && info.max !== null) {
    // Convert target seconds to 100-microsecond units and clamp/snap to HAL step
    const rawUnits = targetSec * 1e4;
    const step = info.step || 1;
    const clamped = Math.min(info.max, Math.max(info.min, info.min + Math.round((rawUnits - info.min) / step) * step));
    const adv = { exposureTime: clamped };
    if (info.isoMin !== null && info.isoMax !== null) {
      // Highest ISO within first 75% of range to maintain brightness at short shutter
      adv.iso = Math.round(info.isoMin + (info.isoMax - info.isoMin) * 0.75);
    }
    try {
      // Two-step apply per Android Chrome Camera2 HAL requirement
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual' }] });
      await track.applyConstraints({ advanced: [adv] });
      return { ok: true, mode: 'manual', info: getExposureInfo(track) };
    } catch (err) {
      console.warn('[camera] Manual exposure constraint failed:', err);
    }
  }

  if (info.compMin !== null) {
    try {
      await track.applyConstraints({ advanced: [{ exposureCompensation: info.compMin }] });
      return { ok: true, mode: 'comp-min', info: getExposureInfo(track) };
    } catch {}
  }

  return { ok: false, mode: 'auto', info: getExposureInfo(track) };
}

/**
 * Stops all active tracks on a MediaStream cleanly.
 * @param {MediaStream | null} stream
 */
export function stopCamera(stream) {
  if (!stream) return;
  const tracks = stream.getTracks();
  for (let i = 0; i < tracks.length; i++) {
    tracks[i].stop();
  }
}
