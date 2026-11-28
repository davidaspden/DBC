/**
 * Motion & orientation sensor diagnostics:
 *  - Probes Generic Sensor APIs (Gyroscope, Accelerometer, GravitySensor,
 *    RelativeOrientationSensor, AbsoluteOrientationSensor) at 100 Hz
 *  - Checks DeviceMotionEvent / DeviceOrientationEvent fallback (including iOS permission)
 *  - Runs a 2-second stationary gyro bias & RMS noise measurement
 */

const RAD_TO_DEG = 180 / Math.PI;

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * PP4: Classifies the actual motion permission path accurately without mislabelling
 * Android Chrome as `devicemotion-ios`.
 * Returns `'generic-sensor' | 'devicemotion-ios' | 'devicemotion-android' | 'devicemotion' | 'none'`.
 */
export function classifyMotionPermissionPath({
  hasGenericGyro = false,
  hasDeviceMotion = false,
  hasDeviceOrientation = false,
  hasRequestPermission = false,
  userAgent = '',
  platform = '',
} = {}) {
  const ua = `${userAgent || ''} ${platform || ''}`;
  const isIos = /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(ua) && hasRequestPermission && !hasGenericGyro);
  const isAndroid = /Android/i.test(ua);

  if (isIos && hasDeviceMotion && hasRequestPermission) {
    return 'devicemotion-ios';
  }
  if (hasGenericGyro) {
    return 'generic-sensor';
  }
  if (hasDeviceMotion || hasDeviceOrientation) {
    return isAndroid ? 'devicemotion-android' : 'devicemotion';
  }
  return 'none';
}

/**
 * Requests motion sensor permission inside a user-gesture handler (required on iOS Safari).
 * PP4: Labels the path accurately (`generic-sensor`, `devicemotion-android`, or `devicemotion-ios`).
 */
export async function requestMotionAccess() {
  const hasGenericGyro = typeof globalThis.Gyroscope === 'function';
  const hasDM = typeof globalThis.DeviceMotionEvent !== 'undefined';
  const hasDO = typeof globalThis.DeviceOrientationEvent !== 'undefined';
  const hasReqPerm = hasDM && typeof DeviceMotionEvent.requestPermission === 'function';
  const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
  const platform = typeof navigator !== 'undefined' && navigator.userAgentData
    ? (navigator.userAgentData.platform || '')
    : (typeof navigator !== 'undefined' ? (navigator.platform || '') : '');

  const path = classifyMotionPermissionPath({
    hasGenericGyro,
    hasDeviceMotion: hasDM,
    hasDeviceOrientation: hasDO,
    hasRequestPermission: hasReqPerm,
    userAgent: ua,
    platform,
  });

  if (hasReqPerm && path === 'devicemotion-ios') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (hasDO && typeof DeviceOrientationEvent.requestPermission === 'function') {
        try { await DeviceOrientationEvent.requestPermission(); } catch {}
      }
      return {
        granted: res === 'granted',
        path: 'devicemotion-ios',
        error: res === 'granted' ? null : res,
      };
    } catch (err) {
      return {
        granted: false,
        path: 'devicemotion-ios',
        error: err && err.name ? err.name : String(err),
      };
    }
  }

  // On Android/desktop Chrome if requestPermission is somehow exposed, invoke safely without mislabelling iOS
  if (hasReqPerm && !hasGenericGyro) {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      return { granted: res === 'granted', path, error: res === 'granted' ? null : res };
    } catch {
      return { granted: true, path, error: null };
    }
  }

  if (path !== 'none') {
    return { granted: true, path, error: null };
  }
  return { granted: false, path: 'none', error: 'NoMotionAPIs' };
}

function probeSingleGenericSensor(name, durationMs = 1000) {
  const Ctor = globalThis[name];
  if (typeof Ctor !== 'function') {
    return Promise.resolve({
      name,
      present: false,
      constructed: false,
      measuredHz: 0,
      sampleCount: 0,
      error: 'NotPresent',
    });
  }

  return new Promise((resolve) => {
    let sensor = null;
    let count = 0;
    let firstTs = 0;
    let lastTs = 0;
    let firstError = null;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sensor) {
        try { sensor.stop(); } catch {}
      }
      const elapsed = lastTs - firstTs;
      const hz = count > 1 && elapsed > 0
        ? Math.round(((count - 1) * 10000) / elapsed) / 10
        : (count > 0 ? count : 0);
      resolve({
        name,
        present: true,
        constructed: Boolean(sensor),
        measuredHz: hz,
        sampleCount: count,
        error: firstError,
      });
    };

    const timer = setTimeout(finish, durationMs);

    try {
      sensor = new Ctor({ frequency: 100 });
      sensor.addEventListener('reading', () => {
        const ts = typeof sensor.timestamp === 'number' && sensor.timestamp > 0
          ? sensor.timestamp
          : performance.now();
        if (count === 0) firstTs = ts;
        lastTs = ts;
        count++;
      });
      sensor.addEventListener('error', (ev) => {
        if (!firstError) {
          firstError = ev && ev.error && ev.error.name ? ev.error.name : 'SensorError';
        }
        finish();
      });
      sensor.start();
    } catch (err) {
      firstError = err && err.name ? err.name : String(err);
      finish();
    }
  });
}

function probeDeviceMotionFallback(durationMs = 1000) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return Promise.resolve({ present: false, measuredHz: 0, hasRotationRate: false, sampleCount: 0 });
  }
  const present = 'DeviceMotionEvent' in window;
  if (!present) {
    return Promise.resolve({ present: false, measuredHz: 0, hasRotationRate: false, sampleCount: 0 });
  }

  return new Promise((resolve) => {
    let count = 0;
    let hasRot = false;
    let firstTs = 0;
    let lastTs = 0;

    const onMotion = (ev) => {
      const ts = ev.timeStamp || performance.now();
      if (count === 0) firstTs = ts;
      lastTs = ts;
      count++;
      const rr = ev.rotationRate;
      if (rr && (rr.alpha !== null || rr.beta !== null || rr.gamma !== null)) {
        hasRot = true;
      }
    };

    window.addEventListener('devicemotion', onMotion);
    setTimeout(() => {
      window.removeEventListener('devicemotion', onMotion);
      const elapsed = lastTs - firstTs;
      const hz = count > 1 && elapsed > 0 ? Math.round(((count - 1) * 10000) / elapsed) / 10 : 0;
      resolve({ present: true, measuredHz: hz, hasRotationRate: hasRot, sampleCount: count });
    }, durationMs);
  });
}

/**
 * Probes D1 orientation extras: Gravity vector pitch/roll + RelativeOrientationSensor
 * referenceFrame ('screen' vs 'device') comparison.
 */
export async function probeOrientationFrames(durationMs = 600) {
  const out = {
    relScreenOk: false,
    relDeviceOk: false,
    framesDiffer: null,
    gravityAvailable: false,
    gravityVec: null,
    gravityPitchDeg: null,
    gravityRollDeg: null,
  };

  async function sampleQuat(refFrame) {
    if (typeof globalThis.RelativeOrientationSensor !== 'function') return null;
    return new Promise((resolve) => {
      let s = null;
      let done = false;
      const fin = (q) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (s) { try { s.stop(); } catch {} }
        resolve(q);
      };
      const t = setTimeout(() => fin(null), durationMs);
      try {
        s = new globalThis.RelativeOrientationSensor({ frequency: 60, referenceFrame: refFrame });
        s.addEventListener('reading', () => {
          if (s.quaternion && s.quaternion.length >= 4) fin(Array.from(s.quaternion));
        });
        s.addEventListener('error', () => fin(null));
        s.start();
      } catch {
        fin(null);
      }
    });
  }

  async function sampleGravity() {
    const Ctor = typeof globalThis.GravitySensor === 'function'
      ? globalThis.GravitySensor
      : (typeof globalThis.Accelerometer === 'function' ? globalThis.Accelerometer : null);
    if (!Ctor) return null;
    return new Promise((resolve) => {
      let s = null;
      let done = false;
      const fin = (g) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (s) { try { s.stop(); } catch {} }
        resolve(g);
      };
      const t = setTimeout(() => fin(null), durationMs);
      try {
        s = new Ctor({ frequency: 60 });
        s.addEventListener('reading', () => {
          if (typeof s.x === 'number' && typeof s.y === 'number' && typeof s.z === 'number') {
            fin({ x: round3(s.x), y: round3(s.y), z: round3(s.z) });
          }
        });
        s.addEventListener('error', () => fin(null));
        s.start();
      } catch {
        fin(null);
      }
    });
  }

  const [qScr, qDev, grav] = await Promise.all([
    sampleQuat('screen'),
    sampleQuat('device'),
    sampleGravity(),
  ]);

  out.relScreenOk = Boolean(qScr);
  out.relDeviceOk = Boolean(qDev);
  if (qScr && qDev) {
    const dot = Math.abs(qScr[0] * qDev[0] + qScr[1] * qDev[1] + qScr[2] * qDev[2] + qScr[3] * qDev[3]);
    out.framesDiffer = dot < 0.999;
  }
  if (grav) {
    out.gravityAvailable = true;
    out.gravityVec = grav;
    const mag = Math.hypot(grav.x, grav.y, grav.z) || 1;
    // Upright phone facing wall: gravity points down (-Y in screen/device), so +Y ~ +9.8
    out.gravityRollDeg = round3(Math.atan2(grav.x, grav.y) * RAD_TO_DEG);
    out.gravityPitchDeg = round3(Math.asin(Math.max(-1, Math.min(1, grav.z / mag))) * RAD_TO_DEG);
  }
  return out;
}

/**
 * Probes Generic Sensor APIs in parallel plus DeviceMotion / DeviceOrientation fallback.
 */
export async function probeSensors() {
  const names = [
    'Gyroscope',
    'Accelerometer',
    'GravitySensor',
    'RelativeOrientationSensor',
    'AbsoluteOrientationSensor',
  ];

  const [results, dmRes, orientFrames] = await Promise.all([
    Promise.all(names.map((n) => probeSingleGenericSensor(n, 1000))),
    probeDeviceMotionFallback(1000),
    probeOrientationFrames(600),
  ]);

  const generic = {};
  for (const r of results) generic[r.name] = r;

  const genericGyroOk = generic.Gyroscope && generic.Gyroscope.sampleCount > 0;
  const dmGyroOk = dmRes.hasRotationRate && dmRes.sampleCount > 0;
  const gyroAvailable = genericGyroOk || dmGyroOk;
  const gyroSource = genericGyroOk ? 'Gyroscope' : (dmGyroOk ? 'devicemotion' : 'none');
  const gyroHz = genericGyroOk ? generic.Gyroscope.measuredHz : (dmGyroOk ? dmRes.measuredHz : 0);

  return {
    generic,
    deviceMotion: dmRes,
    deviceOrientationPresent: typeof window !== 'undefined' && 'DeviceOrientationEvent' in window,
    gyroAvailable,
    gyroSource,
    gyroHz,
    orientFrames,
    atRest: null,
  };
}

/**
 * Measures stationary gyroscope bias (deg/s) and RMS noise over `ms` milliseconds.
 * Pre-allocates Float32Array sample buffers.
 *
 * @param {number} [ms=2000]
 */
export async function measureGyroAtRest(ms = 2000) {
  const maxSamples = 600;
  const xs = new Float32Array(maxSamples);
  const ys = new Float32Array(maxSamples);
  const zs = new Float32Array(maxSamples);
  let n = 0;
  let source = 'none';
  let error = null;

  const computeStats = () => {
    if (n === 0) {
      return {
        source,
        durationMs: ms,
        n: 0,
        biasDps: { x: 0, y: 0, z: 0 },
        maxAbsBiasDps: 0,
        rmsDps: 0,
        pass: false,
        movedDuringTest: false,
        error: error || 'NoGyroSamples',
      };
    }
    let sx = 0; let sy = 0; let sz = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i]; sz += zs[i];
    }
    const mx = sx / n;
    const my = sy / n;
    const mz = sz / n;

    let vSum = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx;
      const dy = ys[i] - my;
      const dz = zs[i] - mz;
      vSum += dx * dx + dy * dy + dz * dz;
    }
    const rms = Math.sqrt(vSum / (3 * n));
    const maxAbsBias = Math.max(Math.abs(mx), Math.abs(my), Math.abs(mz));
    const movedDuringTest = rms >= 0.35;
    const pass = n >= 10 && !movedDuringTest && maxAbsBias < 0.3;

    return {
      source,
      durationMs: ms,
      n,
      biasDps: { x: round3(mx), y: round3(my), z: round3(mz) },
      maxAbsBiasDps: round3(maxAbsBias),
      rmsDps: round3(rms),
      pass,
      movedDuringTest,
      error,
    };
  };

  // Prefer Generic Sensor Gyroscope (rad/s -> deg/s)
  if (typeof globalThis.Gyroscope === 'function') {
    const genericDone = await new Promise((resolve) => {
      let sensor = null;
      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (sensor) {
          try { sensor.stop(); } catch {}
        }
        resolve(ok);
      };
      const timer = setTimeout(() => done(n > 0), ms);
      try {
        source = 'Gyroscope';
        sensor = new globalThis.Gyroscope({ frequency: 100 });
        sensor.addEventListener('reading', () => {
          if (n >= maxSamples) return;
          xs[n] = (sensor.x || 0) * RAD_TO_DEG;
          ys[n] = (sensor.y || 0) * RAD_TO_DEG;
          zs[n] = (sensor.z || 0) * RAD_TO_DEG;
          n++;
        });
        sensor.addEventListener('error', (ev) => {
          error = ev && ev.error && ev.error.name ? ev.error.name : 'GyroError';
          done(false);
        });
        sensor.start();
      } catch (err) {
        error = err && err.name ? err.name : String(err);
        done(false);
      }
    });
    if (genericDone) return computeStats();
  }

  // Fallback to devicemotion rotationRate (already deg/s on Android Chrome / Safari)
  if (typeof window !== 'undefined' && 'DeviceMotionEvent' in window) {
    n = 0;
    source = 'devicemotion';
    error = null;
    await new Promise((resolve) => {
      const onMotion = (ev) => {
        const rr = ev.rotationRate;
        if (!rr || n >= maxSamples) return;
        if (rr.alpha === null && rr.beta === null && rr.gamma === null) return;
        xs[n] = rr.beta || 0;
        ys[n] = rr.gamma || 0;
        zs[n] = rr.alpha || 0;
        n++;
      };
      window.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        window.removeEventListener('devicemotion', onMotion);
        resolve();
      }, ms);
    });
  }

  return computeStats();
}

/**
 * PP6: Stationary gyro check UX with "place phone flat/still" countdown, one automatic retry
 * on movement (rms >= 0.35 dps), and strict rule: ONLY record `biasDps` from a passing still window.
 */
export async function measureGyroAtRestWithRetry({
  durationMs = 2000,
  countdownSec = 2,
  maxRetries = 1,
  onStatus = () => {},
  sampleFn = measureGyroAtRest,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastRes = null;
  const maxAttempts = 1 + Math.max(0, maxRetries | 0);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (let s = countdownSec; s > 0; s--) {
      if (attempt === 1) {
        onStatus(`Place phone flat/still — starting in ${s}s…`);
      } else {
        onStatus(`Movement detected (rms ${lastRes.rmsDps} dps) — place phone flat/still, retry ${attempt}/${maxAttempts} in ${s}s…`);
      }
      await sleepFn(1000);
    }

    onStatus(`Place phone flat/still — measuring gyro (${(durationMs / 1000).toFixed(1)} s, attempt ${attempt}/${maxAttempts})…`);
    const res = await sampleFn(durationMs);
    lastRes = res;

    if (res && !res.movedDuringTest && res.n >= 10) {
      return {
        ...res,
        attempts: attempt,
        biasRecorded: true,
      };
    }
  }

  // All attempts detected movement or lacked samples -> do NOT record unreliable bias!
  return {
    ...(lastRes || {
      source: 'none',
      durationMs,
      n: 0,
      rmsDps: 0,
      pass: false,
      movedDuringTest: true,
      error: 'MovedDuringTest',
    }),
    biasDps: null,
    maxAbsBiasDps: null,
    pass: false,
    biasRecorded: false,
    attempts: maxAttempts,
  };
}
