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
 * Requests motion sensor permission inside a user-gesture handler (required on iOS Safari).
 */
export async function requestMotionAccess() {
  const hasGenericGyro = typeof globalThis.Gyroscope === 'function';
  const hasDM = typeof globalThis.DeviceMotionEvent !== 'undefined';
  const hasDO = typeof globalThis.DeviceOrientationEvent !== 'undefined';

  if (hasDM && typeof DeviceMotionEvent.requestPermission === 'function') {
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

  if (hasGenericGyro) {
    return { granted: true, path: 'generic-sensor', error: null };
  }
  if (hasDM || hasDO) {
    return { granted: true, path: 'devicemotion', error: null };
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

  const [results, dmRes] = await Promise.all([
    Promise.all(names.map((n) => probeSingleGenericSensor(n, 1000))),
    probeDeviceMotionFallback(1000),
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
