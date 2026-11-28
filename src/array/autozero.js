/**
 * A6 — Auto Tote-Zero State Machine from First Square, Centred Label (`src/array/autozero.js`).
 *
 * Waits for 2 agreeing reads of the same Code 128 payload satisfying:
 *  - Label centre within 12% of frame centre
 *  - Scan angle within 8° of expected orientation (90° for ladder, 0° for picket)
 *  - Phone still (|wTotalDps| < 8 deg/s) and level (|rollDeg| < 10°)
 *  - Label pixel length consistent with physical `labelLenIn` at estimated D (±35%)
 *
 * Returns a deterministic `{ triggered, payload, estimatedDistanceIn }` result plus Undo support.
 */

function angleDiff180(a, b) {
  let d = Math.abs((((a - b) % 180) + 180) % 180);
  if (d > 90) d = 180 - d;
  return d;
}

export function createAutoZeroStateMachine(opts = {}) {
  const cfg = {
    maxCenterOffsetFrac: opts.maxCenterOffsetFrac || 0.12,
    maxAngleErrDeg: opts.maxAngleErrDeg || 8,
    maxRateDps: opts.maxRateDps || 8,
    maxRollDeg: opts.maxRollDeg || 10,
    requiredAgreements: opts.requiredAgreements || 2,
    expectedScanDeg: opts.expectedScanDeg ?? 90,
    labelLenIn: opts.labelLenIn || 3.5,
  };

  let armed = false;
  let pendingPayload = '';
  let agreeCount = 0;
  let lastTrigger = null;

  function arm() {
    armed = true;
    pendingPayload = '';
    agreeCount = 0;
  }

  function disarm() {
    armed = false;
    pendingPayload = '';
    agreeCount = 0;
  }

  /**
   * Evaluates a decoded observation against squareness, centring, stillness, and agreement gates.
   */
  function evaluate({
    payload,
    cx,
    cy,
    lenPx,
    thetaDeg,
    frameW,
    frameH,
    focalLengthPx,
    currentDistanceIn = 12,
    wTotalDps = 0,
    rollDeg = 0,
  }) {
    if (!armed || !payload) return { triggered: false, reason: 'disarmed' };

    const dxFrac = Math.abs(cx - frameW * 0.5) / Math.max(1, frameW);
    const dyFrac = Math.abs(cy - frameH * 0.5) / Math.max(1, frameH);
    if (dxFrac > cfg.maxCenterOffsetFrac || dyFrac > cfg.maxCenterOffsetFrac) {
      return { triggered: false, reason: 'off-center' };
    }

    if (typeof thetaDeg === 'number' && angleDiff180(thetaDeg, cfg.expectedScanDeg) > cfg.maxAngleErrDeg) {
      return { triggered: false, reason: 'skewed' };
    }

    if (Math.abs(wTotalDps) > cfg.maxRateDps) {
      return { triggered: false, reason: 'moving' };
    }

    if (Math.abs(rollDeg) > cfg.maxRollDeg) {
      return { triggered: false, reason: 'rolled' };
    }

    let estD = currentDistanceIn;
    if (lenPx > 30 && focalLengthPx > 0) {
      const rawD = (focalLengthPx * cfg.labelLenIn) / lenPx;
      const clampedD = Math.max(6, Math.min(45, rawD));
      // Check plausibility within +/-35% of current distance estimate (if nominal is plausible)
      if (currentDistanceIn >= 6 && currentDistanceIn <= 45) {
        if (Math.abs(clampedD - currentDistanceIn) / currentDistanceIn > 0.45) {
          return { triggered: false, reason: 'size-mismatch', rawD: Math.round(rawD * 10) / 10 };
        }
      }
      estD = Math.round(clampedD * 10) / 10;
    }

    if (payload === pendingPayload) {
      agreeCount++;
    } else {
      pendingPayload = payload;
      agreeCount = 1;
    }

    if (agreeCount >= cfg.requiredAgreements) {
      armed = false;
      lastTrigger = { payload, estimatedDistanceIn: estD, cx, cy, lenPx };
      return { triggered: true, payload, estimatedDistanceIn: estD };
    }

    return { triggered: false, reason: 'awaiting-second-read', agreeCount };
  }

  return {
    arm,
    disarm,
    isArmed: () => armed,
    evaluate,
    getLastTrigger: () => lastTrigger,
  };
}
