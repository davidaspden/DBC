/**
 * U4 — Hold-to-Pause & Face-Down Gravity Pause Controller (`src/ui/pause.js`, flag: `pauseCtl`).
 *
 * Pauses frame dispatch while the user holds the Pause button OR while the phone is held
 * face-down (`accel.z < -7.5` or `> +7.5` depending on screen-down sign) for > 400 ms so
 * holster-carry never spams accidental decodes.
 */

export function createPauseController({ onChange } = {}) {
  let manualHeld = false;
  let faceDownPaused = false;
  let faceDownSinceMs = 0;
  let accel = null;

  function isPaused() {
    return manualHeld || faceDownPaused;
  }

  function emit() {
    if (typeof onChange === 'function') {
      onChange({ paused: isPaused(), manualHeld, faceDownPaused });
    }
  }

  function setManualHold(held) {
    const next = Boolean(held);
    if (next === manualHeld) return;
    manualHeld = next;
    emit();
  }

  /**
   * Feeds an accelerometer sample `(ax, ay, az)` in m/s² (exposed for unit tests & live sensor).
   */
  function ingestAccel(ax, ay, az, nowMs = performance.now()) {
    // Screen facing flat down toward floor: |az| > 7.8 and |ax|,|ay| < 4.5 (specifically az < -7.8 on Android)
    const isFaceDown = az < -7.8 && Math.hypot(ax, ay) < 4.5;
    if (isFaceDown) {
      if (faceDownSinceMs === 0) faceDownSinceMs = nowMs;
      if (!faceDownPaused && (nowMs - faceDownSinceMs) >= 400) {
        faceDownPaused = true;
        emit();
      }
    } else {
      faceDownSinceMs = 0;
      if (faceDownPaused) {
        faceDownPaused = false;
        emit();
      }
    }
  }

  function startFaceDownSensor() {
    if (accel || typeof globalThis.Accelerometer !== 'function') return false;
    try {
      accel = new globalThis.Accelerometer({ frequency: 15 });
      accel.addEventListener('reading', () => {
        ingestAccel(accel.x || 0, accel.y || 0, accel.z || 0, performance.now());
      });
      accel.addEventListener('error', () => {
        try { accel.stop(); } catch {}
        accel = null;
      });
      accel.start();
      return true;
    } catch {
      accel = null;
      return false;
    }
  }

  function stop() {
    manualHeld = false;
    faceDownPaused = false;
    faceDownSinceMs = 0;
    if (accel) { try { accel.stop(); } catch {} accel = null; }
  }

  return {
    isPaused,
    setManualHold,
    ingestAccel,
    startFaceDownSensor,
    stop,
  };
}
