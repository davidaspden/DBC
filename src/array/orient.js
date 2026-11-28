/**
 * Fused Tilt & Pan Orientation Tracker for Stand-Back Array Scanning (Part 3).
 *
 * Sensor priority (no magnetometer — steel warehouse racking corrupts compass yaw):
 *  1. RelativeOrientationSensor (OS gyro + accel fusion, screen referenceFrame)
 *  2. Generic Sensor Gyroscope (+ GravitySensor / Accelerometer fallback)
 *  3. DeviceMotionEvent (rotationRate + accelerationIncludingGravity; handles iOS permission)
 *
 * Pre-allocates a 128-sample Float64Array ring buffer for zero per-sample GC allocations
 * and supports timestamp-interpolated orientation lookup to compensate for camera latency.
 */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const RING_SIZE = 128;
const RING_MASK = RING_SIZE - 1;

// Quaternion helpers (mutating preallocated Float64Array [x, y, z, w] — zero allocations)
export function quatIdentity(out) {
  out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
  return out;
}

export function quatConjugate(q, out) {
  out[0] = -q[0]; out[1] = -q[1]; out[2] = -q[2]; out[3] = q[3];
  return out;
}

export function quatNormalize(q, out) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len < 1e-12) return quatIdentity(out);
  const inv = 1 / len;
  out[0] = q[0] * inv;
  out[1] = q[1] * inv;
  out[2] = q[2] * inv;
  out[3] = q[3] * inv;
  return out;
}

export function quatMultiply(a, b, out) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * Rotates 3D vector `(vx, vy, vz)` by unit quaternion `q = [x, y, z, w]` into `out3`.
 */
export function quatRotateVec(q, vx, vy, vz, out3) {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out3[0] = vx + qw * tx + (qy * tz - qz * ty);
  out3[1] = vy + qw * ty + (qz * tx - qx * tz);
  out3[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out3;
}

/**
 * Builds a quaternion from incremental axis-angle `(wx, wy, wz)` (radians) using exact exp map.
 */
export function quatFromAxisAngleVec(rx, ry, rz, out) {
  const angle = Math.hypot(rx, ry, rz);
  if (angle < 1e-9) {
    out[0] = 0.5 * rx;
    out[1] = 0.5 * ry;
    out[2] = 0.5 * rz;
    out[3] = 1;
    return quatNormalize(out, out);
  }
  const half = 0.5 * angle;
  const s = Math.sin(half) / angle;
  out[0] = rx * s;
  out[1] = ry * s;
  out[2] = rz * s;
  out[3] = Math.cos(half);
  return out;
}

/**
 * Builds a quaternion representing camera yaw (right +), pitch (up +), roll (CCW +)
 * in wall-normal space where the camera optical axis is `(0, 0, -1)`.
 */
export function quatFromPanTiltRollDeg(panRightDeg, tiltUpDeg, rollDeg = 0, out = new Float64Array(4)) {
  const cy = Math.cos((-panRightDeg * 0.5) * DEG_TO_RAD);
  const sy = Math.sin((-panRightDeg * 0.5) * DEG_TO_RAD);
  const cp = Math.cos((tiltUpDeg * 0.5) * DEG_TO_RAD);
  const sp = Math.sin((tiltUpDeg * 0.5) * DEG_TO_RAD);
  const cr = Math.cos((rollDeg * 0.5) * DEG_TO_RAD);
  const sr = Math.sin((rollDeg * 0.5) * DEG_TO_RAD);

  // q = qYaw(Y) * qPitch(X) * qRoll(Z)
  const qy = [0, sy, 0, cy];
  const qp = [sp, 0, 0, cp];
  const qr = [0, 0, sr, cr];
  const tmp = new Float64Array(4);
  quatMultiply(qy, qp, tmp);
  quatMultiply(tmp, qr, out);
  return quatNormalize(out, out);
}

/**
 * Extracts intuitive pan (right + deg), tilt (up + deg), and roll (deg) from relative
 * quaternion `qRel` where reference forward is `(0, 0, -1)`.
 */
export function extractPanTiltRollDeg(qRel, out = { panDeg: 0, tiltDeg: 0, rollDeg: 0 }) {
  const f = new Float64Array(3);
  const r = new Float64Array(3);
  quatRotateVec(qRel, 0, 0, -1, f);
  quatRotateVec(qRel, 1, 0, 0, r);
  const horiz = Math.hypot(f[0], -f[2]) || 1e-9;
  out.panDeg = Math.atan2(f[0], -f[2]) * RAD_TO_DEG;
  out.tiltDeg = Math.atan2(f[1], horiz) * RAD_TO_DEG;
  out.rollDeg = Math.atan2(r[1], Math.hypot(r[0], r[2]) || 1e-9) * RAD_TO_DEG;
  return out;
}

/**
 * Creates a live sensor-backed OrientationTracker instance.
 *
 * @param {{ gravityZero?: boolean }} [opts]
 *  - `gravityZero` (A7 flag `orientGravityZero`, default false): uses `referenceFrame: 'device'`,
 *    keeps pitch & roll absolute from gravity, zeroes yaw only (`zeroYawOnly`), and compensates
 *    explicitly for `screen.orientation.angle`.
 */
export function createOrientationTracker(opts = {}) {
  const gravityZeroMode = Boolean(opts && opts.gravityZero);
  // Preallocated quaternion & ring buffers (zero hot-loop allocations)
  const qCur = new Float64Array([0, 0, 0, 1]);
  const qZeroInv = new Float64Array([0, 0, 0, 1]);
  const qRel = new Float64Array([0, 0, 0, 1]);
  const qPrev = new Float64Array([0, 0, 0, 1]);
  const qDelta = new Float64Array([0, 0, 0, 1]);
  const qTmp = new Float64Array([0, 0, 0, 1]);
  const qTmp2 = new Float64Array([0, 0, 0, 1]);
  const qRxNeg90 = new Float64Array([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]); // Rx(-90 deg): world(+Z up) -> wall(+Y up, -Z fwd)
  const qScreenCorr = new Float64Array([0, 0, 0, 1]);
  const qYawZero = new Float64Array([0, 0, 0, 1]);
  const vecTmp = new Float64Array(3);

  let screenAngleDeg = (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number')
    ? screen.orientation.angle
    : 0;
  let yawZeroRad = 0;

  function updateScreenCorrQuat() {
    const half = (-screenAngleDeg * 0.5) * DEG_TO_RAD;
    qScreenCorr[0] = 0;
    qScreenCorr[1] = 0;
    qScreenCorr[2] = Math.sin(half);
    qScreenCorr[3] = Math.cos(half);
  }
  updateScreenCorrQuat();

  // Ring buffer: [ts, qx, qy, qz, qw, wPanDps, wPitchDps] per slot (stride 7)
  const STRIDE = 7;
  const ring = new Float64Array(RING_SIZE * STRIDE);
  let ringHead = 0;
  let ringCount = 0;

  let active = false;
  let source = 'none';
  let sampleCount = 0;
  let lastSampleTs = 0;
  let firstSampleTs = 0;
  let measuredHz = 0;

  // Gyro bias in rad/s (used when integrating raw gyro)
  let biasX = 0;
  let biasY = 0;
  let biasZ = 0;
  let biasCalibrated = false;
  let lastBiasRmsDps = 0;

  // Instantaneous angular rates (deg/s)
  let wPanDps = 0;
  let wPitchDps = 0;
  let wTotalDps = 0;

  // Active sensor handles
  let relSensor = null;
  let gyroSensor = null;
  let dmListener = null;

  // Calibration accumulator (for 2 s stationary bias/noise check)
  let calActive = false;
  let calSumX = 0;
  let calSumY = 0;
  let calSumZ = 0;
  let calN = 0;
  const calBufX = new Float32Array(512);
  const calBufY = new Float32Array(512);
  const calBufZ = new Float32Array(512);

  function pushRing(ts, q, panRateDps, pitchRateDps) {
    const off = ringHead * STRIDE;
    ring[off] = ts;
    ring[off + 1] = q[0];
    ring[off + 2] = q[1];
    ring[off + 3] = q[2];
    ring[off + 4] = q[3];
    ring[off + 5] = panRateDps;
    ring[off + 6] = pitchRateDps;
    ringHead = (ringHead + 1) & RING_MASK;
    if (ringCount < RING_SIZE) ringCount++;
  }

  function updateRatesFromQuats(dtSec) {
    if (dtSec <= 1e-4 || dtSec > 0.5) return;
    // qDelta = conj(qPrev) * qCur (body-frame incremental rotation)
    quatConjugate(qPrev, qTmp);
    quatMultiply(qTmp, qCur, qDelta);
    if (qDelta[3] < 0) {
      qDelta[0] = -qDelta[0]; qDelta[1] = -qDelta[1]; qDelta[2] = -qDelta[2]; qDelta[3] = -qDelta[3];
    }
    const sinHalf = Math.hypot(qDelta[0], qDelta[1], qDelta[2]);
    if (sinHalf > 1e-7) {
      const angle = 2 * Math.atan2(sinHalf, qDelta[3]);
      const scale = (angle / sinHalf) / dtSec; // rad/s
      const wx = qDelta[0] * scale;
      const wy = qDelta[1] * scale;
      const wz = qDelta[2] * scale;
      wPitchDps = wx * RAD_TO_DEG;
      wPanDps = -wy * RAD_TO_DEG;
      wTotalDps = Math.hypot(wx, wy, wz) * RAD_TO_DEG;
      if (calActive && calN < 512) {
        calBufX[calN] = wx; calBufY[calN] = wy; calBufZ[calN] = wz;
        calSumX += wx; calSumY += wy; calSumZ += wz;
        calN++;
      }
    } else {
      wPitchDps = 0; wPanDps = 0; wTotalDps = 0;
      if (calActive && calN < 512) {
        calBufX[calN] = 0; calBufY[calN] = 0; calBufZ[calN] = 0;
        calN++;
      }
    }
  }

  function computeRelFromCur() {
    if (gravityZeroMode) {
      // qRel = Rx(-90) * Rz(yawZeroRad) * qCur * Rz(-screenAngleDeg)
      quatMultiply(qCur, qScreenCorr, qTmp);
      quatMultiply(qYawZero, qTmp, qTmp2);
      quatMultiply(qRxNeg90, qTmp2, qRel);
      quatNormalize(qRel, qRel);
    } else {
      quatMultiply(qZeroInv, qCur, qRel);
    }
  }

  function recordSample(ts) {
    if (sampleCount === 0) firstSampleTs = ts;
    sampleCount++;
    const elapsed = ts - firstSampleTs;
    if (sampleCount > 4 && elapsed > 200) {
      measuredHz = Math.round(((sampleCount - 1) * 10000) / elapsed) / 10;
    }
    computeRelFromCur();
    pushRing(ts, qRel, wPanDps, wPitchDps);
    lastSampleTs = ts;
  }

  function ingestRawGyro(wxRad, wyRad, wzRad, ts) {
    if (calActive && calN < 512) {
      calBufX[calN] = wxRad; calBufY[calN] = wyRad; calBufZ[calN] = wzRad;
      calSumX += wxRad; calSumY += wyRad; calSumZ += wzRad;
      calN++;
    }
    const cx = wxRad - biasX;
    const cy = wyRad - biasY;
    const cz = wzRad - biasZ;
    wPitchDps = cx * RAD_TO_DEG;
    wPanDps = -cy * RAD_TO_DEG;
    wTotalDps = Math.hypot(cx, cy, cz) * RAD_TO_DEG;

    if (lastSampleTs > 0) {
      const dt = (ts - lastSampleTs) * 0.001;
      if (dt > 0 && dt < 0.25) {
        quatFromAxisAngleVec(cx * dt, cy * dt, cz * dt, qDelta);
        quatMultiply(qCur, qDelta, qTmp);
        quatNormalize(qTmp, qCur);
      }
    }
    recordSample(ts);
  }

  function zeroNow() {
    quatConjugate(qCur, qZeroInv);
    quatIdentity(qRel);
  }

  /**
   * Sets the reference frame so the current physical phone orientation maps exactly
   * to `targetQuat` in wall-normal space (`qZeroInv = targetQuat * conj(qCur)`).
   * Used when zeroing on Top-Left (R1C1) or Top-Right (R1C4) without tangent distortion.
   */
  function zeroToQuaternion(targetQuat) {
    if (!targetQuat) {
      zeroNow();
      return;
    }
    quatConjugate(qCur, qTmp);
    quatMultiply(targetQuat, qTmp, qZeroInv);
    quatNormalize(qZeroInv, qZeroInv);
    quatMultiply(qZeroInv, qCur, qRel);
    const now = performance.now();
    pushRing(now, qRel, wPanDps, wPitchDps);
  }

  /**
   * A7: Sets screen orientation angle (0/90/180/270 deg). In gravity-zero device-frame mode
   * this seamlessly rotates the camera-to-device mapping without jumping world orientation;
   * in legacy screen-frame mode it compensates `qZeroInv` by the angle delta.
   */
  function setScreenAngle(angleDeg) {
    const next = (((angleDeg | 0) % 360) + 360) % 360;
    const delta = next - screenAngleDeg;
    screenAngleDeg = next;
    updateScreenCorrQuat();
    if (!gravityZeroMode && delta !== 0) {
      const half = (delta * 0.5) * DEG_TO_RAD;
      qTmp[0] = 0; qTmp[1] = 0; qTmp[2] = Math.sin(half); qTmp[3] = Math.cos(half);
      quatMultiply(qZeroInv, qTmp, qTmp2);
      quatNormalize(qTmp2, qZeroInv);
    }
    computeRelFromCur();
  }

  /**
   * A7: Zeroes ONLY horizontal yaw so the current optical ray azimuth maps to `targetPanRightDeg`,
   * while preserving absolute gravity-referenced pitch and roll.
   */
  function zeroYawOnly(targetPanRightDeg = 0) {
    // Back camera forward in world frame (+Z = up) after screen-angle compensation
    quatMultiply(qCur, qScreenCorr, qTmp);
    quatRotateVec(qTmp, 0, 0, -1, vecTmp);
    const curAzRad = Math.atan2(vecTmp[0], vecTmp[1]);
    yawZeroRad = curAzRad - targetPanRightDeg * DEG_TO_RAD;
    const half = yawZeroRad * 0.5;
    qYawZero[0] = 0;
    qYawZero[1] = 0;
    qYawZero[2] = Math.sin(half);
    qYawZero[3] = Math.cos(half);
    computeRelFromCur();
    const now = performance.now();
    pushRing(now, qRel, wPanDps, wPitchDps);
  }

  /**
   * A7: Injects a synthetic gravity-aligned device quaternion (`qWorldFromDevice`) for unit tests.
   */
  function setDeviceQuaternion(qWorldFromDevice, ts = performance.now()) {
    qCur[0] = qWorldFromDevice[0];
    qCur[1] = qWorldFromDevice[1];
    qCur[2] = qWorldFromDevice[2];
    qCur[3] = qWorldFromDevice[3];
    quatNormalize(qCur, qCur);
    computeRelFromCur();
    pushRing(ts, qRel, 0, 0);
    lastSampleTs = ts;
  }

  /**
   * A7: Returns current gravity-relative pitch, roll & screen angle for preflight UI.
   */
  function getSetupInfo() {
    quatMultiply(qCur, qScreenCorr, qTmp);
    const f = new Float64Array(3);
    const u = new Float64Array(3);
    const r = new Float64Array(3);
    if (gravityZeroMode) {
      quatRotateVec(qTmp, 0, 0, -1, f);
      quatRotateVec(qTmp, 0, 1, 0, u);
      quatRotateVec(qTmp, 1, 0, 0, r);
      const pitchDeg = Math.asin(Math.max(-1, Math.min(1, f[2]))) * RAD_TO_DEG;
      const rollDeg = Math.atan2(r[2], u[2]) * RAD_TO_DEG;
      return { pitchDeg, rollDeg, screenAngleDeg, gravityZeroMode };
    }
    const ang = extractPanTiltRollDeg(qRel);
    return { pitchDeg: ang.tiltDeg, rollDeg: ang.rollDeg, screenAngleDeg, gravityZeroMode };
  }

  /**
   * Manually sets relative orientation (used for desktop drag-to-pan simulation fallback).
   */
  function setManualPanTilt(panRightDeg, tiltUpDeg, rollDeg = 0) {
    quatFromPanTiltRollDeg(panRightDeg, tiltUpDeg, rollDeg, qCur);
    quatIdentity(qZeroInv);
    quatRelCopyFromCur();
    const now = performance.now();
    pushRing(now, qRel, 0, 0);
    lastSampleTs = now;
  }

  function quatRelCopyFromCur() {
    qRel[0] = qCur[0]; qRel[1] = qCur[1]; qRel[2] = qCur[2]; qRel[3] = qCur[3];
  }

  /**
   * Starts motion sensors (call inside a user tap handler for iOS Safari compatibility).
   */
  async function start() {
    stop();
    sampleCount = 0;
    lastSampleTs = 0;
    firstSampleTs = 0;
    measuredHz = 0;
    ringCount = 0;
    ringHead = 0;
    quatIdentity(qCur);
    quatIdentity(qZeroInv);
    quatIdentity(qRel);

    // Handle iOS Safari DeviceMotion permission first inside user gesture
    if (
      typeof globalThis.DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') {
          source = 'denied';
          return { ok: false, source, error: 'PermissionDenied' };
        }
      } catch (err) {
        source = 'denied';
        return { ok: false, source, error: err && err.name ? err.name : String(err) };
      }
    }

    // Path 1: RelativeOrientationSensor (OS fused gyro+accel, no magnetometer)
    if (typeof globalThis.RelativeOrientationSensor === 'function') {
      const okRel = await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        try {
          relSensor = new globalThis.RelativeOrientationSensor({
            frequency: 60,
            referenceFrame: gravityZeroMode ? 'device' : 'screen',
          });
          let gotFirst = false;
          relSensor.addEventListener('reading', () => {
            const q = relSensor.quaternion;
            if (!q || q.length < 4) return;
            const ts = typeof relSensor.timestamp === 'number' && relSensor.timestamp > 0
              ? relSensor.timestamp
              : performance.now();
            qPrev[0] = qCur[0]; qPrev[1] = qCur[1]; qPrev[2] = qCur[2]; qPrev[3] = qCur[3];
            qCur[0] = q[0]; qCur[1] = q[1]; qCur[2] = q[2]; qCur[3] = q[3];
            quatNormalize(qCur, qCur);
            if (!gotFirst) {
              gotFirst = true;
              zeroNow();
              finish(true);
            } else {
              updateRatesFromQuats((ts - lastSampleTs) * 0.001);
            }
            recordSample(ts);
          });
          relSensor.addEventListener('error', () => {
            try { relSensor.stop(); } catch {}
            relSensor = null;
            finish(false);
          });
          relSensor.start();
          setTimeout(() => {
            if (!gotFirst) {
              try { relSensor.stop(); } catch {}
              relSensor = null;
              finish(false);
            }
          }, 900);
        } catch {
          relSensor = null;
          finish(false);
        }
      });

      if (okRel) {
        active = true;
        source = 'RelativeOrientationSensor';
        return { ok: true, source, error: null };
      }
    }

    // Path 2: Generic Sensor Gyroscope (screen referenceFrame)
    if (typeof globalThis.Gyroscope === 'function') {
      const okGyro = await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        try {
          gyroSensor = new globalThis.Gyroscope({
            frequency: 60,
            referenceFrame: gravityZeroMode ? 'device' : 'screen',
          });
          let gotFirst = false;
          gyroSensor.addEventListener('reading', () => {
            const ts = typeof gyroSensor.timestamp === 'number' && gyroSensor.timestamp > 0
              ? gyroSensor.timestamp
              : performance.now();
            if (!gotFirst) {
              gotFirst = true;
              finish(true);
            }
            ingestRawGyro(gyroSensor.x || 0, gyroSensor.y || 0, gyroSensor.z || 0, ts);
          });
          gyroSensor.addEventListener('error', () => {
            try { gyroSensor.stop(); } catch {}
            gyroSensor = null;
            finish(false);
          });
          gyroSensor.start();
          setTimeout(() => {
            if (!gotFirst) {
              try { gyroSensor.stop(); } catch {}
              gyroSensor = null;
              finish(false);
            }
          }, 900);
        } catch {
          gyroSensor = null;
          finish(false);
        }
      });

      if (okGyro) {
        active = true;
        source = 'Gyroscope';
        return { ok: true, source, error: null };
      }
    }

    // Path 3: devicemotion fallback (deg/s)
    if (typeof window !== 'undefined' && 'DeviceMotionEvent' in window) {
      const okDm = await new Promise((resolve) => {
        let gotRot = false;
        dmListener = (ev) => {
          const rr = ev.rotationRate;
          if (!rr) return;
          if (rr.alpha === null && rr.beta === null && rr.gamma === null) return;
          if (!gotRot) {
            gotRot = true;
            resolve(true);
          }
          const ts = ev.timeStamp || performance.now();
          // DeviceMotion rotationRate: beta = X (pitch), gamma = Y (pan), alpha = Z (roll) in deg/s
          ingestRawGyro(
            (rr.beta || 0) * DEG_TO_RAD,
            (rr.gamma || 0) * DEG_TO_RAD,
            (rr.alpha || 0) * DEG_TO_RAD,
            ts
          );
        };
        window.addEventListener('devicemotion', dmListener);
        setTimeout(() => {
          if (!gotRot) {
            window.removeEventListener('devicemotion', dmListener);
            dmListener = null;
            resolve(false);
          }
        }, 1000);
      });

      if (okDm) {
        active = true;
        source = 'devicemotion';
        return { ok: true, source, error: null };
      }
    }

    source = 'manual';
    active = false;
    return { ok: false, source, error: 'NoMotionSensor' };
  }

  function stop() {
    active = false;
    if (relSensor) { try { relSensor.stop(); } catch {} relSensor = null; }
    if (gyroSensor) { try { gyroSensor.stop(); } catch {} gyroSensor = null; }
    if (dmListener && typeof window !== 'undefined') {
      window.removeEventListener('devicemotion', dmListener);
      dmListener = null;
    }
  }

  /**
   * Runs a stationary hold (`durationMs`, default 1800 ms) to verify stillness,
   * estimate raw gyro bias, and lock the reference zero orientation (optionally to `targetQuat`).
   */
  async function calibrateZero(durationMs = 1800, targetQuat = null) {
    calActive = true;
    calSumX = 0; calSumY = 0; calSumZ = 0; calN = 0;

    await new Promise((r) => setTimeout(r, durationMs));
    calActive = false;

    if (calN < 5) {
      if (targetQuat) zeroToQuaternion(targetQuat);
      else zeroNow();
      return { ok: false, n: calN, rmsDps: 0, biasDps: 0, moved: false };
    }

    const mx = calSumX / calN;
    const my = calSumY / calN;
    const mz = calSumZ / calN;
    let vSum = 0;
    for (let i = 0; i < calN; i++) {
      const dx = calBufX[i] - mx;
      const dy = calBufY[i] - my;
      const dz = calBufZ[i] - mz;
      vSum += dx * dx + dy * dy + dz * dz;
    }
    const rmsDps = Math.sqrt(vSum / (3 * calN)) * RAD_TO_DEG;
    const biasDps = Math.hypot(mx, my, mz) * RAD_TO_DEG;
    const moved = rmsDps >= 1.5;

    // Only apply explicit bias subtraction for raw gyro paths (RelativeOrientationSensor is OS-fused)
    if (!moved && source !== 'RelativeOrientationSensor') {
      biasX = mx;
      biasY = my;
      biasZ = mz;
      biasCalibrated = true;
    } else if (!moved) {
      biasCalibrated = true;
    }
    lastBiasRmsDps = rmsDps;
    if (targetQuat) zeroToQuaternion(targetQuat);
    else zeroNow();

    return {
      ok: !moved,
      n: calN,
      rmsDps: Math.round(rmsDps * 100) / 100,
      biasDps: Math.round(biasDps * 100) / 100,
      moved,
    };
  }

  /**
   * Looks up the interpolated relative quaternion at timestamp `targetTsMs` into `outQuat`.
   */
  function getQuaternionAt(targetTsMs, outQuat) {
    if (ringCount === 0) {
      outQuat[0] = qRel[0]; outQuat[1] = qRel[1]; outQuat[2] = qRel[2]; outQuat[3] = qRel[3];
      return outQuat;
    }
    // Walk newest-to-oldest to bracket targetTsMs
    let newestIdx = (ringHead - 1) & RING_MASK;
    if (ringCount === 1 || targetTsMs >= ring[newestIdx * STRIDE]) {
      const off = newestIdx * STRIDE;
      outQuat[0] = ring[off + 1]; outQuat[1] = ring[off + 2];
      outQuat[2] = ring[off + 3]; outQuat[3] = ring[off + 4];
      return outQuat;
    }

    let curIdx = newestIdx;
    for (let i = 1; i < ringCount; i++) {
      const prevIdx = (curIdx - 1) & RING_MASK;
      const tCur = ring[curIdx * STRIDE];
      const tPrev = ring[prevIdx * STRIDE];
      if (targetTsMs >= tPrev && targetTsMs <= tCur) {
        const dt = tCur - tPrev;
        const alpha = dt > 1e-4 ? (targetTsMs - tPrev) / dt : 1;
        const o0 = prevIdx * STRIDE;
        const o1 = curIdx * STRIDE;
        let dot =
          ring[o0 + 1] * ring[o1 + 1] +
          ring[o0 + 2] * ring[o1 + 2] +
          ring[o0 + 3] * ring[o1 + 3] +
          ring[o0 + 4] * ring[o1 + 4];
        const sign = dot < 0 ? -1 : 1;
        // NLerp (accurate to <0.001 deg for <10 deg inter-sample steps, zero trig)
        outQuat[0] = ring[o0 + 1] * (1 - alpha) + sign * ring[o1 + 1] * alpha;
        outQuat[1] = ring[o0 + 2] * (1 - alpha) + sign * ring[o1 + 2] * alpha;
        outQuat[2] = ring[o0 + 3] * (1 - alpha) + sign * ring[o1 + 3] * alpha;
        outQuat[3] = ring[o0 + 4] * (1 - alpha) + sign * ring[o1 + 4] * alpha;
        return quatNormalize(outQuat, outQuat);
      }
      curIdx = prevIdx;
    }

    // Older than ring history -> clamp to oldest sample
    const off = curIdx * STRIDE;
    outQuat[0] = ring[off + 1]; outQuat[1] = ring[off + 2];
    outQuat[2] = ring[off + 3]; outQuat[3] = ring[off + 4];
    return outQuat;
  }

  return {
    start,
    stop,
    zeroNow,
    zeroToQuaternion,
    zeroYawOnly,
    setScreenAngle,
    setDeviceQuaternion,
    getSetupInfo,
    calibrateZero,
    setManualPanTilt,
    getQuaternionAt,
    getRelativeQuaternion: () => qRel,
    getStatus: () => ({
      active,
      source,
      measuredHz,
      sampleCount,
      biasCalibrated,
      lastBiasRmsDps,
      wPanDps,
      wPitchDps,
      wTotalDps,
    }),
    _vecTmp: vecTmp,
  };
}
