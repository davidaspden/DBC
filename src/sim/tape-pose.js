/**
 * T1 — Tape-driven camera pose (`src/sim/tape-pose.js`), flag `simTapePose` (default OFF).
 *
 * A sim path `tape:<name>` whose camera ORIENTATION comes from the motion sensors recorded in a
 * `.dbct` tape (`src/tape/record.js`, `tools/tape-format.md`). The IMU gives rotation only, so the
 * camera POSITION comes from a stance model:
 *   - `fixed`  (default): standing distance `D` (the scenario's `distanceIn`) from the wall at the
 *                         wall origin, optionally plus a slow sway from the accelerometer's low-pass
 *                         (`swayInPerMs2`, default 0 = no sway);
 *   - `log`:   the tape's own pose log (`sensorSample.simPose`, written by the sim exporter / the
 *                         A10 slide-map log) when it has one.
 *
 * Orientation sources (`opts.source`):
 *   - `integrated` (default): integrates the recorded angular rates (`wPanDps`, `wPitchDps`, and
 *                         `wRollDps` when present) from the first sample's orientation. This is the
 *                         "replay the gyro" path, and the one a gyro-only tape needs;
 *   - `recorded`:         the tape's own quaternion `q` per frame (what the tracker reported);
 *   - `simPose`:          the exact sim pose from `sensorSample.simPose` (sim-exported tapes).
 *
 * Angles use the sim/array convention: pan right +, tilt up +, roll CCW +, wall normal = -Z
 * (`quatFromPanTiltRollDeg`). Times honour the tape clock (`tFrameMs`), so frame times and sensor
 * times stay locked.
 *
 * Browser-safe: `readTapeSensors` parses only the header and per-frame meta and never touches the
 * (gzipped) luma bytes, so it needs neither zlib nor DecompressionStream.
 */

import { quatFromPanTiltRollDeg, quatRotateVec } from '../array/orient.js';
import { registerExtraPath, unregisterExtraPath } from './paths.js';
import { isSimOn } from './simflags.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
const G = 9.80665;

/**
 * Exact inverse of `quatFromPanTiltRollDeg` (q = Yaw * Pitch * Roll): returns pan/tilt/roll in deg.
 * (`orient.js: extractPanTiltRollDeg` is only approximate for roll when tilted.)
 */
export function quatToPanTiltRollDeg(q, out = { panDeg: 0, tiltDeg: 0, rollDeg: 0 }) {
  const f = quatRotateVec(q, 0, 0, -1, new Float64Array(3));
  const r = quatRotateVec(q, 1, 0, 0, new Float64Array(3));
  const u = quatRotateVec(q, 0, 1, 0, new Float64Array(3));
  out.panDeg = Math.atan2(f[0], -f[2]) * RAD2DEG;
  out.tiltDeg = Math.atan2(f[1], Math.hypot(f[0], f[2])) * RAD2DEG;
  out.rollDeg = Math.atan2(r[1], u[1]) * RAD2DEG;
  return out;
}

/** Angle in degrees between two unit quaternions. */
export function quatAngleDeg(a, b) {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * RAD2DEG;
}

/**
 * Reads header + per-frame meta of a `.dbct` v1 tape (any codec) without decoding luma.
 * @returns {{ header: object, samples: Array<object>, durationSec: number }}
 */
export function readTapeSensors(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 12) throw new Error('Tape too short');
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'DBCT') throw new Error('Not a .dbct tape (bad magic)');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(4, true) !== 1) throw new Error(`Unsupported tape version: ${dv.getUint32(4, true)}`);
  const td = new TextDecoder();
  const hLen = dv.getUint32(8, true);
  const header = JSON.parse(td.decode(u8.subarray(12, 12 + hLen)));
  const samples = [];
  let off = 12 + hLen;
  while (off + 8 <= u8.byteLength) {
    const mLen = dv.getUint32(off, true);
    const dLen = dv.getUint32(off + 4, true);
    off += 8;
    const meta = JSON.parse(td.decode(u8.subarray(off, off + mLen)));
    off += mLen + dLen;
    samples.push({
      frameId: meta.frameId,
      tMs: Number.isFinite(meta.tFrameMs) ? meta.tFrameMs : NaN,
      fps: meta.fps ?? null,
      sensor: meta.sensorSample || null,
    });
  }
  // repair the clock if the tape has no usable tFrameMs: frame index at the header/meta fps (30 default)
  const fps = (header.meta && header.meta.fps) || 30;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i].tMs)) samples[i].tMs = (i * 1000) / fps;
  }
  const t0 = samples.length ? samples[0].tMs : 0;
  for (const s of samples) s.tMs -= t0;
  const durationSec = samples.length ? samples[samples.length - 1].tMs / 1000 : 0;
  return { header, samples, durationSec };
}

function lowPass(values, tMs, fcHz) {
  const out = new Float64Array(values.length);
  if (!values.length) return out;
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i];
  mean /= values.length;
  let y = 0;
  for (let i = 0; i < values.length; i++) {
    const dt = i > 0 ? Math.max(1e-4, (tMs[i] - tMs[i - 1]) / 1000) : 0;
    const a = dt > 0 ? dt / (dt + 1 / (2 * Math.PI * fcHz)) : 1;
    y += a * (values[i] - mean - y);
    out[i] = y;
  }
  return out;
}

/**
 * Builds per-sample orientation arrays (deg) from a tape's sensors.
 * @param {{samples: Array<object>}} tape
 * @param {{ source?: 'integrated'|'recorded'|'simPose', rollSign?: number }} [opts]
 */
export function buildOrientationTrack(tape, opts = {}) {
  const source = opts.source || 'integrated';
  const n = tape.samples.length;
  const t = new Float64Array(n);
  const pan = new Float64Array(n);
  const tilt = new Float64Array(n);
  const roll = new Float64Array(n);
  const sim = { x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), has: false };
  const tmp = { panDeg: 0, tiltDeg: 0, rollDeg: 0 };
  for (let i = 0; i < n; i++) {
    t[i] = tape.samples[i].tMs;
    const s = tape.samples[i].sensor;
    if (s && s.simPose) {
      sim.x[i] = s.simPose.x;
      sim.y[i] = s.simPose.y;
      sim.z[i] = s.simPose.z;
      sim.has = true;
    }
  }
  const first = n ? tape.samples[0].sensor : null;
  if (source === 'simPose') {
    for (let i = 0; i < n; i++) {
      const sp = tape.samples[i].sensor && tape.samples[i].sensor.simPose;
      if (!sp) throw new Error(`tape sample ${i} has no sensorSample.simPose (not a sim-exported tape)`);
      pan[i] = sp.yawDeg;
      tilt[i] = sp.pitchDeg;
      roll[i] = sp.rollDeg;
    }
  } else if (source === 'recorded') {
    for (let i = 0; i < n; i++) {
      const q = tape.samples[i].sensor && tape.samples[i].sensor.q;
      if (!q || q.length !== 4) throw new Error(`tape sample ${i} has no sensorSample.q`);
      quatToPanTiltRollDeg(q, tmp);
      pan[i] = tmp.panDeg;
      tilt[i] = tmp.tiltDeg;
      roll[i] = tmp.rollDeg;
    }
  } else {
    // integrated: start from the first recorded orientation if there is one (else 0, 0, 0),
    // then trapezoid-integrate the angular rates
    if (first && first.q && first.q.length === 4) {
      quatToPanTiltRollDeg(first.q, tmp);
      pan[0] = tmp.panDeg;
      tilt[0] = tmp.tiltDeg;
      roll[0] = tmp.rollDeg;
    }
    const rollSign = opts.rollSign || 0;
    const rates = (s) => {
      if (!s) return [0, 0, 0];
      const wp = Number.isFinite(s.wPanDps) ? s.wPanDps : 0;
      const wt = Number.isFinite(s.wPitchDps) ? s.wPitchDps : 0;
      let wr = 0;
      if (Number.isFinite(s.wRollDps)) wr = s.wRollDps;
      else if (rollSign !== 0 && s.rotRate && Number.isFinite(s.rotRate.alpha)) wr = rollSign * s.rotRate.alpha;
      return [wp, wt, wr];
    };
    for (let i = 1; i < n; i++) {
      const dt = (t[i] - t[i - 1]) / 1000;
      const a = rates(tape.samples[i - 1].sensor);
      const b = rates(tape.samples[i].sensor);
      pan[i] = pan[i - 1] + 0.5 * (a[0] + b[0]) * dt;
      tilt[i] = tilt[i - 1] + 0.5 * (a[1] + b[1]) * dt;
      roll[i] = roll[i - 1] + 0.5 * (a[2] + b[2]) * dt;
    }
  }
  return { t, pan, tilt, roll, sim, n };
}

/**
 * Creates a pose sampler for a tape.
 *
 * @param {{ samples: Array<object>, durationSec: number }} tape from `readTapeSensors`
 * @param {{
 *   source?: 'integrated'|'recorded'|'simPose', stance?: 'fixed'|'log',
 *   distanceIn?: number, panOffsetDeg?: number, tiltOffsetDeg?: number,
 *   swayInPerMs2?: number, swayCutoffHz?: number, rollSign?: number, loop?: boolean,
 *   originSec?: number|'header'
 * }} [opts] `originSec`: sim time at which the tape's first frame plays (default 0; `'header'` uses a
 *   sim-exported tape's `meta.phaseOffsetSec`, which makes a sim->tape->sim run reproduce exactly).
 *   `distanceIn` here is the default; the scenario's `cfg.distanceIn` wins when given.
 */
export function createTapePose(tape, opts = {}) {
  const track = buildOrientationTrack(tape, opts);
  const n = track.n;
  if (n < 2) throw new Error('tape needs at least 2 frames with timestamps');
  const stance = opts.stance || 'fixed';
  if (stance === 'log' && !track.sim.has) throw new Error('stance "log" needs sensorSample.simPose in the tape');
  const durationSec = track.t[n - 1] / 1000;
  const origin = opts.originSec === 'header' ? Number(tape.header?.meta?.phaseOffsetSec) || 0 : Number(opts.originSec) || 0;
  const panOff = opts.panOffsetDeg || 0;
  const tiltOff = opts.tiltOffsetDeg || 0;

  const k = opts.swayInPerMs2 || 0;
  let swayX = null;
  let swayY = null;
  if (k !== 0) {
    const ax = new Float64Array(n);
    const ay = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = tape.samples[i].sensor && tape.samples[i].sensor.accel;
      ax[i] = a && Number.isFinite(a.x) ? a.x : 0;
      ay[i] = a && Number.isFinite(a.y) ? a.y : 0;
    }
    swayX = lowPass(ax, track.t, opts.swayCutoffHz || 0.5);
    swayY = lowPass(ay, track.t, opts.swayCutoffHz || 0.5);
  }

  let cursor = 0;
  function sample(tSec, cfg = {}) {
    const loop = (cfg.loop ?? opts.loop) === true;
    let tt = tSec - origin;
    let finished = false;
    if (loop && durationSec > 0) tt = ((tt % durationSec) + durationSec) % durationSec;
    else if (tt >= durationSec) { tt = durationSec; finished = true; }
    else if (tt < 0) tt = 0;
    const tm = tt * 1000;
    if (cursor >= n - 1 || track.t[cursor] > tm) cursor = 0;
    while (cursor < n - 2 && track.t[cursor + 1] <= tm) cursor++;
    const i = cursor;
    const span = track.t[i + 1] - track.t[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (tm - track.t[i]) / span)) : 0;
    const lerp = (a) => a[i] + (a[i + 1] - a[i]) * f;
    const yawDeg = lerp(track.pan) + panOff;
    const pitchDeg = lerp(track.tilt) + tiltOff;
    const rollDeg = lerp(track.roll);
    const dist = Math.max(4, cfg.distanceIn || opts.distanceIn || 10);

    let x = 0;
    let y = 0;
    let z = dist;
    if (stance === 'log') {
      x = lerp(track.sim.x);
      y = lerp(track.sim.y);
      z = lerp(track.sim.z);
    } else if (swayX) {
      x += k * lerp(swayX);
      y += k * lerp(swayY);
    }
    // angular rate (deg/s) over the bracket -> sweep speed on the wall at the aim point
    const dtS = span / 1000 || 1e-3;
    const wPan = (track.pan[i + 1] - track.pan[i]) / dtS;
    const wTilt = (track.tilt[i + 1] - track.tilt[i]) / dtS;
    const cy = Math.cos(yawDeg * DEG2RAD);
    const cp = Math.cos(pitchDeg * DEG2RAD);
    const reach = z / Math.max(0.2, cy * cp);
    const vx = wPan * DEG2RAD * reach / Math.max(0.2, cy);
    const vy = wTilt * DEG2RAD * reach / Math.max(0.2, cp);
    // wall point the optical axis hits (z = 0 plane)
    const fx = Math.sin(yawDeg * DEG2RAD) * cp;
    const fy = Math.sin(pitchDeg * DEG2RAD);
    const tHit = reach;
    return {
      x,
      y,
      z: Math.max(4, z),
      yawDeg,
      pitchDeg,
      rollDeg,
      targetX: x + fx * tHit,
      targetY: y + fy * tHit,
      speedInPerSec: finished ? 0 : Math.hypot(vx, vy),
      vxInPerSec: finished ? 0 : vx,
      vyInPerSec: finished ? 0 : vy,
      alongScanSpeedInPerSec: finished ? 0 : Math.abs(vy),
      progress: durationSec > 0 ? tt / durationSec : 0,
      durationSec,
      finished,
    };
  }
  return { sample, durationSec, frames: n, track, source: opts.source || 'integrated', stance };
}

/** Registered tape path ids (so tests and the page can list/clean them up). */
const registered = new Set();

/**
 * Registers `tape:<name>` as a sim path (listed in `PATH_DEFINITIONS`, sampled by `sampleCameraPose`).
 * Does nothing and returns `null` unless the `simTapePose` sim flag is on (or `opts.enabled === true`
 * for headless runs), so with the flag off the path is never listed.
 *
 * @returns {string|null} the path id
 */
export function registerTapePath(name, tape, opts = {}) {
  const enabled = opts.enabled === undefined ? isSimOn('simTapePose') : Boolean(opts.enabled);
  if (!enabled) return null;
  const pose = createTapePose(tape, opts);
  const id = `tape:${name}`;
  registerExtraPath(
    {
      id,
      label: `Tape: ${name} (${pose.durationSec.toFixed(1)} s, ${pose.source})`,
      lengthIn: 0,
      fixedDurationSec: pose.durationSec,
      tape: true,
    },
    (tSec, cfg) => pose.sample(tSec, cfg)
  );
  registered.add(id);
  return id;
}

export function unregisterTapePath(idOrName) {
  const id = idOrName.startsWith('tape:') ? idOrName : `tape:${idOrName}`;
  unregisterExtraPath(id);
  registered.delete(id);
}

export function listRegisteredTapePaths() {
  return [...registered];
}

/** Convenience for tests/tools: a quaternion for the sensor orientation at pan/tilt/roll deg. */
export function quatForPose(panDeg, tiltDeg, rollDeg) {
  return quatFromPanTiltRollDeg(panDeg, tiltDeg, rollDeg, new Float64Array(4));
}

export { G as GRAVITY_MS2 };
