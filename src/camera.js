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
