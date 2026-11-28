/**
 * R7 — Array mapper in the loop (`src/sim/array-loop.js`).
 *
 * Feeds the REAL decoder (`processFrameMulti`) detections from CPU-rendered sim frames, plus
 * synthesised 60 Hz orientation sensors, into the REAL array modules (`createOrientationTracker`,
 * `createPanArrayMapper`, `createAutoZeroStateMachine`, `solveAxisRemap`, `createSlideWallMapper`)
 * wired the way `array.html` wires them, and scores the result against the sim's ground truth:
 *
 *  - cell attribution accuracy (every placed read vs the true cell of that payload),
 *  - drift in inches (mapped aim point vs the true aim point on the wall) over time,
 *  - time to a correct zero,
 *  - conflicts raised vs truth (the sim has no genuine duplicate payloads, so any CONFLICT is false),
 *  - behaviour from each start orientation (upright, rotated 90/180/270, tilted) and a mis-set standoff.
 *
 * Two stages so the expensive part (render + decode) is done once and reused for every flag set:
 *   1. `recordStandbackRun()` / `recordSlideRun()` -> frames + detections + truth (flag independent).
 *   2. `runArrayLoop()` / `runSlideLoop()` -> replays them through the array modules for one flag set.
 *
 * Test/tool code only: never imported by the app or the worker, so the worker hot-loop rules in
 * AGENTS.md (zero allocations, integer maths) do not apply here. Nothing in `src/array` or
 * `src/wallmap.js` is modified by R7; this file only drives them.
 *
 * Synthetic parts (stated so the scores are read correctly): the sensor stream is generated from the
 * sim pose, not from a real phone, so bias/drift/noise are parameters, not measurements; the optical
 * flow used by slide mode is derived from the pose delta (flow quality has its own test, flow.test.js);
 * `wTotalDps` for auto-zero is the synthetic gyro magnitude (the headless tracker has no gyro events).
 */

import { sampleCameraPose, PATH_DEFINITIONS } from './paths.js';
import { getPreset, createSceneForPreset } from './presets.js';
import { createCpuRenderContext, renderFrame, mulberry32 } from './cpu-render.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../worker/scanner.worker.js';
import {
  createOrientationTracker,
  quatFromPanTiltRollDeg,
  quatMultiply,
} from '../array/orient.js';
import { createPanArrayMapper } from '../array/pan-mapper.js';
import { createAutoZeroStateMachine } from '../array/autozero.js';
import { classifyHold, solveAxisRemap, AXIS_REMAPS } from '../array/setup.js';
import { createSlideWallMapper } from '../wallmap.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Simulated clock starts here so no timestamp is ever 0 (the page uses `obs.tFrameMs || now`). */
export const LOOP_T0_MS = 1000;

/** Mapped aim point within this fraction of the smaller tote pitch counts as a correct zero. */
export const ZERO_OK_FRAC = 0.3;

/** Stand-back rig used for presets that are not natively stand-back (30 in, 26 deg tele). */
export const STANDBACK_RIG = Object.freeze({ distanceIn: 30, hfovDeg: 26 });

/** F3 start-orientation selector values applied to the SENSOR stream (plan section R7 / 10.1 S12). */
export const START_ORIENTATIONS = Object.freeze([
  Object.freeze({ id: 'upright', alphaDeg: 0, rollOffsetDeg: 0 }),
  Object.freeze({ id: 'rot90', alphaDeg: 90, rollOffsetDeg: 0 }),
  Object.freeze({ id: 'rot180', alphaDeg: 180, rollOffsetDeg: 0 }),
  Object.freeze({ id: 'rot270', alphaDeg: 270, rollOffsetDeg: 0 }),
  // Held tilted: the camera itself is rolled 25 deg for the whole run (image and sensors agree).
  Object.freeze({ id: 'tilted', alphaDeg: 0, rollOffsetDeg: 25 }),
]);

export const ARRAY_FLAG_NAMES = Object.freeze([
  'fcLabelDefaults',
  'conflictHysteresis',
  'dupCheck',
  'nudgeDamp',
  'driftFromLabel',
  'autoZeroFromLabel',
  'orientGravityZero',
  'axisRemapAuto',
  'panKalman',
  'allocCleanup',
  'slideMap',
]);

/** `A-all` for the stand-back loop: every A flag except `slideMap` (a different mode, see runSlideLoop). */
export const A_ALL_STANDBACK = Object.freeze(ARRAY_FLAG_NAMES.filter((n) => n !== 'slideMap'));

export function flagsFromNames(names) {
  const f = {};
  for (let i = 0; i < ARRAY_FLAG_NAMES.length; i++) f[ARRAY_FLAG_NAMES[i]] = false;
  for (let i = 0; i < names.length; i++) f[names[i]] = true;
  return f;
}

// ---------------------------------------------------------------------------------------------
// Small quaternion helpers (allocation is fine here: tool code)
// ---------------------------------------------------------------------------------------------

function qAxis(ax, ay, az, deg) {
  const h = deg * DEG * 0.5;
  const s = Math.sin(h);
  return new Float64Array([ax * s, ay * s, az * s, Math.cos(h)]);
}

function qMul(a, b) {
  return quatMultiply(a, b, new Float64Array(4));
}

function qAngleDeg(a, b) {
  // angle of the relative rotation a^-1 * b
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) * RAD;
}

function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------------------------------------------------------------------------------------------
// Stage 1a — stand-back run (pan/tilt from a fixed stance)
// ---------------------------------------------------------------------------------------------

/**
 * Builds the aim-target trajectory: dwell on R1C1, then straight snake hops through every cell
 * centre (row 0 left->right, row 1 right->left, ...) at `speedInPerSec` on the wall plane.
 */
function buildAimPath(scene, speedInPerSec, dwellSec) {
  const cells = scene.cells;
  const cols = scene.cols;
  const rows = scene.rows;
  const seq = [];
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const c = r % 2 === 0 ? k : cols - 1 - k;
      seq.push(cells[r * cols + c]);
    }
  }
  const legs = [];
  let total = 0;
  for (let i = 1; i < seq.length; i++) {
    const len = Math.hypot(seq[i].cx - seq[i - 1].cx, seq[i].cy - seq[i - 1].cy);
    legs.push({ a: seq[i - 1], b: seq[i], t0: total, len });
    total += len / speedInPerSec;
  }
  return {
    durationSec: dwellSec + total,
    at(t) {
      const tp = t - dwellSec;
      if (tp <= 0) return { x: seq[0].cx, y: seq[0].cy, cell: seq[0].index };
      if (tp >= total) {
        const l = seq[seq.length - 1];
        return { x: l.cx, y: l.cy, cell: l.index };
      }
      for (let i = 0; i < legs.length; i++) {
        const g = legs[i];
        const dt = g.len / speedInPerSec;
        if (tp < g.t0 + dt) {
          const u = (tp - g.t0) / dt;
          return { x: g.a.cx + (g.b.cx - g.a.cx) * u, y: g.a.cy + (g.b.cy - g.a.cy) * u, cell: -1 };
        }
      }
      const l = seq[seq.length - 1];
      return { x: l.cx, y: l.cy, cell: l.index };
    },
  };
}

/**
 * Records one stand-back run: renders frames while the camera pans/tilts from a fixed stance to
 * every cell centre, decodes each with the real worker pipeline and stores detections + truth.
 *
 * @param {{
 *   presetId?: string, scene?: object, seed?: number, width?: number, height?: number,
 *   fps?: number, trueDistanceIn?: number, hfovDeg?: number, speedInPerSec?: number, jitter?: number,
 *   stance?: 'centre' | 'in-front', rollOffsetDeg?: number, dwellSec?: number, workerMask?: number
 * }} o
 */
export function recordStandbackRun(o = {}) {
  const presetId = o.presetId || 'tele-30';
  const preset = getPreset(presetId);
  const scene = o.scene || createSceneForPreset(presetId);
  const native = preset.pathId === 'pan-snake';
  const width = o.width ?? preset.width;
  const height = o.height ?? preset.height;
  const fps = o.fps ?? preset.fpsCap;
  const D = o.trueDistanceIn ?? (native ? preset.distanceIn : STANDBACK_RIG.distanceIn);
  const hfovDeg = o.hfovDeg ?? (native ? preset.hfovDeg : STANDBACK_RIG.hfovDeg);
  const speed = o.speedInPerSec ?? preset.speedInPerSec;
  const jitter = o.jitter ?? preset.jitter;
  const seed = o.seed ?? 1;
  const dwellSec = o.dwellSec ?? 1.5;
  const rollOffsetDeg = o.rollOffsetDeg || 0;
  const stanceKind = o.stance || 'centre';
  const workerMask = o.workerMask | 0;

  const c00 = scene.cells[0];
  // 'in-front': standing square in front of R1C1 (A7 `orientGravityZero` stance), phone held so the
  // start pitch is ~20 deg; 'centre': standing at the wall centre at mid height.
  const sx = stanceKind === 'in-front' ? c00.cx : 0;
  const sy = o.stanceYIn ?? (stanceKind === 'in-front' ? c00.cy - D * Math.tan(20 * DEG) : 0);
  const aim = buildAimPath(scene, speed, dwellSec);
  const jitCfg = { distanceIn: D, speedInPerSec: speed, jitter, loop: false };
  const noJitCfg = { distanceIn: D, speedInPerSec: speed, jitter: 0, loop: false };

  function poseAt(tSec) {
    const t = Math.max(0, tSec);
    const tg = aim.at(t);
    const baseYaw = Math.atan2(tg.x - sx, D) * RAD;
    const basePitch = Math.atan2(tg.y - sy, Math.hypot(tg.x - sx, D)) * RAD;
    // Hand-shake deltas come from the shared sim jitter model (same function the presets use)
    const tj = Math.max(0, t - dwellSec);
    const jp = jitter > 0 ? sampleCameraPose('pan-snake', tj, jitCfg) : null;
    const bp = jitter > 0 ? sampleCameraPose('pan-snake', tj, noJitCfg) : null;
    return {
      x: sx,
      y: sy,
      z: Math.max(4, D + (jp ? jp.z - bp.z : 0)),
      yawDeg: baseYaw + (jp ? jp.yawDeg - bp.yawDeg : 0),
      pitchDeg: basePitch + (jp ? jp.pitchDeg - bp.pitchDeg : 0),
      rollDeg: rollOffsetDeg + (jp ? jp.rollDeg - bp.rollDeg : 0),
      targetX: tg.x,
      targetY: tg.y,
      targetCell: tg.cell,
    };
  }

  function aimOnWall(p) {
    const cy = Math.cos(p.yawDeg * DEG);
    const sy2 = Math.sin(p.yawDeg * DEG);
    const cp = Math.cos(p.pitchDeg * DEG);
    const sp = Math.sin(p.pitchDeg * DEG);
    const fx = sy2 * cp;
    const fy = sp;
    const fz = -cy * cp;
    const t = p.z / -fz;
    return { x: p.x + fx * t, y: p.y + fy * t };
  }

  const payloadToCell = new Map();
  for (let i = 0; i < scene.cells.length; i++) payloadToCell.set(scene.cells[i].payload, i);

  const durationSec = aim.durationSec + 0.4;
  const frameCount = Math.max(1, Math.floor(durationSec * fps));
  const ctx = createCpuRenderContext(scene.cells.length);
  const luma = new Uint8Array(width * height);
  const ws = createPipelineState(width, height);
  ws.flags = workerMask;
  const wr = createPipelineResult();
  const renderOpts = {
    width,
    height,
    hfovDeg,
    shadowStrength: scene.shadowStrength,
    noiseStrength: scene.noiseStrength,
    glareStrength: scene.glareStrength,
    frameSeed: 0,
    ctx,
  };

  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    const pose = poseAt(t);
    renderOpts.frameSeed = seed * 100003 + f * 0.71;
    renderFrame(scene, [pose], renderOpts, luma);
    ws.flags = workerMask;
    processFrameMulti(luma, width, height, ws, wr, false);
    const raw = extractMultiDetections(ws);
    const dets = [];
    for (let i = 0; i < raw.length; i++) {
      const d = raw[i];
      if (!d.payload) continue;
      dets.push({
        payload: d.payload,
        cx: d.roiCenterX,
        cy: d.roiCenterY,
        lenPx: d.roiMajorLen,
        thetaDeg: d.thetaDeg,
        prefixOk: d.prefixOk,
        consensusCount: d.consensusCount,
        truthCell: payloadToCell.has(d.payload) ? payloadToCell.get(d.payload) : -1,
      });
    }
    const aimW = aimOnWall(pose);
    frames[f] = { f, tSec: t, pose, aimX: aimW.x, aimY: aimW.y, dets };
  }

  return {
    kind: 'standback',
    presetId,
    scene,
    seed,
    width,
    height,
    fps,
    hfovDeg,
    trueDistanceIn: D,
    stance: stanceKind,
    dwellSec,
    rollOffsetDeg,
    durationSec,
    workerMask,
    frames,
    poseAt,
    aimOnWall,
  };
}

// ---------------------------------------------------------------------------------------------
// Stage 1b — synthesised 60 Hz orientation sensors
// ---------------------------------------------------------------------------------------------

/**
 * Synthesises the orientation-sensor stream a phone would deliver for `run`.
 *
 * `qCur(t) = drift(t) * [Rx(+90)] * qTrue(t) * Rz(alpha)`: `qTrue` is the camera orientation from the
 * sim pose (the same quaternion convention as `quatFromPanTiltRollDeg`), `Rz(alpha)` is the
 * sensor-frame vs image-frame mismatch of a rotated start (what `screen.orientation.angle` reports),
 * `Rx(+90)` is the world(+Z up) frame the gravity-referenced mode expects, and `drift` is a yaw drift
 * about the vertical plus small white tilt noise.
 *
 * @param {object} run
 * @param {{ seed?: number, rateHz?: number, alphaDeg?: number, gravityFrame?: boolean,
 *           driftDegPerMin?: number, noiseDeg?: number, rateNoiseDps?: number }} [o]
 */
export function synthSensors(run, o = {}) {
  const rateHz = o.rateHz || 60;
  const alpha = o.alphaDeg || 0;
  const gravityFrame = Boolean(o.gravityFrame);
  const driftPerSec = (o.driftDegPerMin ?? 2) / 60;
  const noiseDeg = o.noiseDeg ?? 0.03;
  const rateNoise = o.rateNoiseDps ?? 0.05;
  const rng = mulberry32((Math.imul((o.seed ?? 1) | 0, 0x9e3779b1) ^ 0x2468ace1) >>> 0);
  const tStart = -1.0;
  const tEnd = run.durationSec + 0.3;
  const n = Math.floor((tEnd - tStart) * rateHz) + 1;
  const tMs = new Float64Array(n);
  const q = new Float64Array(n * 4);
  const rateDps = new Float32Array(n);
  const qA = qAxis(0, 0, 1, alpha);
  const qW = gravityFrame ? qAxis(1, 0, 0, 90) : null;
  let prevTrue = null;
  for (let k = 0; k < n; k++) {
    const t = tStart + k / rateHz;
    const p = run.poseAt(t);
    const qTrue = quatFromPanTiltRollDeg(p.yawDeg, p.pitchDeg, p.rollDeg);
    const driftDeg = driftPerSec * (t - tStart);
    // yaw about the vertical: wall frame +Y up (legacy frame) or world +Z up (gravity frame)
    const qDrift = gravityFrame ? qAxis(0, 0, 1, driftDeg) : qAxis(0, 1, 0, driftDeg);
    let qc = qMul(qTrue, qA);
    if (qW) qc = qMul(qW, qc);
    qc = qMul(qDrift, qc);
    if (noiseDeg > 0) {
      // small random rotation of std `noiseDeg` per axis (first order)
      const qn = new Float64Array([
        gauss(rng) * noiseDeg * DEG * 0.5,
        gauss(rng) * noiseDeg * DEG * 0.5,
        gauss(rng) * noiseDeg * DEG * 0.5,
        1,
      ]);
      const nrm = Math.hypot(qn[0], qn[1], qn[2], qn[3]);
      for (let i = 0; i < 4; i++) qn[i] /= nrm;
      qc = qMul(qn, qc);
    }
    tMs[k] = LOOP_T0_MS + t * 1000;
    q[k * 4] = qc[0];
    q[k * 4 + 1] = qc[1];
    q[k * 4 + 2] = qc[2];
    q[k * 4 + 3] = qc[3];
    rateDps[k] = prevTrue ? qAngleDeg(prevTrue, qTrue) * rateHz + Math.abs(gauss(rng)) * rateNoise : 0;
    prevTrue = qTrue;
  }
  return { n, rateHz, tMs, q, rateDps, alphaDeg: alpha, gravityFrame, driftDegPerMin: driftPerSec * 60 };
}

// ---------------------------------------------------------------------------------------------
// Stage 2 — drive the real array modules the way array.html does, score vs truth
// ---------------------------------------------------------------------------------------------

function withSimClock(fn) {
  // orient.js stamps its ring with performance.now() inside zero*(); make that the sim clock so the
  // ring stays monotonic. Restored in all cases.
  const real = performance.now;
  let simNow = LOOP_T0_MS;
  performance.now = () => simNow;
  try {
    return fn((t) => { simNow = t; });
  } finally {
    performance.now = real;
  }
}

/**
 * Replays a recorded stand-back run through the real array modules for one flag set.
 *
 * @param {object} run     `recordStandbackRun()` result
 * @param {object} sensors `synthSensors()` result
 * @param {{
 *   flags?: Record<string, boolean>,
 *   startCorner?: 'top-left' | 'top-right' | 'center',
 *   userDistanceIn?: number,        // standoff the user dials in (defaults to the true one)
 *   frameLatencyMs?: number,        // page frame timestamp minus capture time (default 50 = camSensorOffsetMs)
 *   remapObsFormat?: 'page' | 'solver',
 *   modules?: object                // override array modules (used by the d917944 comparison)
 * }} [o]
 */
export function runArrayLoop(run, sensors, o = {}) {
  const flags = { ...flagsFromNames([]), ...(o.flags || {}) };
  const mods = {
    createPanArrayMapper,
    createOrientationTracker,
    createAutoZeroStateMachine,
    ...(o.modules || {}),
  };
  const scene = run.scene;
  const startCorner = o.startCorner || 'top-left';
  const userD = o.userDistanceIn ?? run.trueDistanceIn;
  const latency = o.frameLatencyMs ?? 50;
  const remapObsFormat = o.remapObsFormat || 'page';
  const isFc = Boolean(scene.fcMode);
  const useFcDefaults = flags.fcLabelDefaults && isFc;
  const frameW = run.width;
  const frameH = run.height;

  return withSimClock((setNow) => {
    const orient = mods.createOrientationTracker({ gravityZero: Boolean(flags.orientGravityZero) });
    const mapperOpts = {
      cols: scene.cols,
      rows: scene.rows,
      toteOrientation: scene.pitchXIn > scene.pitchYIn ? '16Wx14H' : '14Wx16H',
      pitchXIn: scene.pitchXIn,
      pitchYIn: scene.pitchYIn,
      distanceIn: userD,
      hfovDeg: run.hfovDeg,
      labelLenIn: scene.label.heightIn,
      conflictHysteresis: flags.conflictHysteresis,
      dupCheck: flags.dupCheck,
      nudgeDamp: flags.nudgeDamp,
      driftFromLabel: flags.driftFromLabel,
      panKalman: flags.panKalman,
      allocCleanup: flags.allocCleanup,
    };
    if (useFcDefaults) mapperOpts.fcLabelDefaults = true;
    const mapper = mods.createPanArrayMapper(mapperOpts);
    if (useFcDefaults) mapper.updateConfig({ distanceIn: userD });
    const autoZero = mods.createAutoZeroStateMachine({
      expectedScanDeg: mapper.cfg.labelOrientation === 'picket' ? 0 : 90,
      labelLenIn: mapper.cfg.labelLenIn,
    });

    // ---- sensor feed ---------------------------------------------------------------------
    let sIdx = 0;
    const qTmp = new Float64Array(4);
    function feedSensorsUpTo(tMs) {
      while (sIdx < sensors.n && sensors.tMs[sIdx] <= tMs) {
        qTmp[0] = sensors.q[sIdx * 4];
        qTmp[1] = sensors.q[sIdx * 4 + 1];
        qTmp[2] = sensors.q[sIdx * 4 + 2];
        qTmp[3] = sensors.q[sIdx * 4 + 3];
        setNow(sensors.tMs[sIdx]);
        orient.setDeviceQuaternion(qTmp, sensors.tMs[sIdx]);
        sIdx++;
      }
    }
    function rateAt(tMs) {
      let i = Math.min(sensors.n - 1, Math.max(0, Math.round(((tMs - sensors.tMs[0]) / 1000) * sensors.rateHz)));
      return sensors.rateDps[i];
    }

    // ---- zero (array.html handleStartStop / applyZeroAtCorner) -----------------------------
    const standInFront = Boolean(flags.orientGravityZero); // page: standMode = in-front when gravityZero
    let zeroEvents = 0;
    let lastHold = null;
    function applyZeroAtCorner(corner) {
      const aim = mapper.getStartCornerAim(corner);
      mapper.stance.px = 0;
      mapper.stance.py = 0;
      mapper.stance.stanceWarning = false;
      if (flags.orientGravityZero && standInFront) {
        const setup = orient.getSetupInfo();
        const row = corner === 'center' ? null : 0;
        const col = corner === 'top-left' ? 0 : (corner === 'top-right' ? mapper.cfg.cols - 1 : null);
        orient.zeroYawOnly(0);
        mapper.setInFrontStanceForCell(row, col, setup.pitchDeg);
        lastHold = classifyHold({
          rollDeg: setup.rollDeg,
          pitchDeg: setup.pitchDeg,
          frameW,
          frameH,
          labelOrientation: mapper.cfg.labelOrientation,
        });
      } else {
        orient.zeroToQuaternion(aim.quat);
      }
      zeroEvents++;
    }

    const tFirst = LOOP_T0_MS; // start-of-run instant (sensor pre-roll is t < LOOP_T0_MS)
    feedSensorsUpTo(tFirst);
    // tracker constructor reads screen.orientation.angle on the page; headless has no `screen`
    orient.setScreenAngle(sensors.alphaDeg || 0);
    applyZeroAtCorner(startCorner);
    const zeroedAtMs = tFirst;
    if (flags.autoZeroFromLabel) autoZero.arm();

    // ---- scoring state ---------------------------------------------------------------------
    const nCells = mapper.getCells().length;
    const qFrame = new Float64Array(4);
    const recentRemapObs = [];
    let remapFixes = 0;
    const remapLog = [];
    let autoZeroFiredAtMs = null;
    let autoZeroDist = null;
    const m = {
      detections: 0,
      truthKnown: 0,
      placed: 0,
      correct: 0,
      wrong: 0,
      unplaced: 0,
    };
    const aimErr = new Float64Array(run.frames.length);
    const aimErrOk = new Uint8Array(run.frames.length);
    const wrongLog = [];

    for (let fi = 0; fi < run.frames.length; fi++) {
      const fr = run.frames[fi];
      const tCapMs = LOOP_T0_MS + fr.tSec * 1000;
      const tFrameMs = tCapMs + latency;
      feedSensorsUpTo(tFrameMs);
      setNow(tFrameMs);
      orient.getQuaternionAt(tFrameMs - mapper.cfg.camSensorOffsetMs, qFrame);

      // truth-vs-mapped aim point (drift in inches): where the mapper thinks the optical axis points
      const pr = mapper.projectPixelToWall(qFrame, frameW * 0.5, frameH * 0.5, frameW, frameH);
      if (pr.ok) {
        aimErr[fi] = Math.hypot(pr.wx - fr.aimX, pr.wy - fr.aimY);
        aimErrOk[fi] = 1;
      }

      for (let di = 0; di < fr.dets.length; di++) {
        const d = fr.dets[di];
        m.detections++;
        if (d.truthCell >= 0) m.truthKnown++;

        if (flags.autoZeroFromLabel && autoZero.isArmed()) {
          const setup = orient.getSetupInfo();
          const az = autoZero.evaluate({
            payload: d.payload,
            cx: d.cx,
            cy: d.cy,
            lenPx: d.lenPx,
            thetaDeg: d.thetaDeg,
            frameW,
            frameH,
            focalLengthPx: mapper.getFocalLengthPx(frameW, frameH),
            currentDistanceIn: mapper.stance.d,
            wTotalDps: rateAt(tFrameMs),
            rollDeg: setup.rollDeg || 0,
          });
          if (az.triggered) {
            mapper.stance.d = az.estimatedDistanceIn;
            applyZeroAtCorner(startCorner);
            autoZeroFiredAtMs = tFrameMs;
            autoZeroDist = az.estimatedDistanceIn;
          }
        }

        const res = mapper.addObservation(
          {
            payload: d.payload,
            cx: d.cx,
            cy: d.cy,
            lenPx: d.lenPx,
            consensus: d.consensusCount,
            prefixOk: d.prefixOk,
            tFrameMs,
          },
          qFrame,
          frameW,
          frameH
        );
        if (res.placed) {
          m.placed++;
          if (d.truthCell >= 0) {
            if (res.cell.index === d.truthCell) m.correct++;
            else {
              m.wrong++;
              if (wrongLog.length < 8) wrongLog.push({ f: fr.f, payload: d.payload, truth: d.truthCell, mapped: res.cell.index });
            }
          }
        } else {
          m.unplaced++;
        }

        if (flags.axisRemapAuto && res.proj && res.proj.ok) {
          const dEff = Math.max(4, mapper.stance.d);
          if (remapObsFormat === 'page') {
            // exactly what array.html pushes (keys the solver does not read)
            recentRemapObs.push({ rx: (res.proj.wx - mapper.stance.px) / dEff, ry: (res.proj.wy - mapper.stance.py) / dEff, wz: res.proj.wzIn });
          } else {
            const cell = res.cell || null;
            recentRemapObs.push({
              tx: (res.proj.wx - mapper.stance.px) / dEff,
              ty: (res.proj.wy - mapper.stance.py) / dEff,
              expectedX: cell ? cell.cx - mapper.stance.px : 0,
              expectedY: cell ? cell.cy - mapper.stance.py : 0,
            });
          }
          if (recentRemapObs.length > 8) recentRemapObs.shift();
          if (mapper.stance.stanceWarning && recentRemapObs.length >= 3) {
            const sol = remapObsFormat === 'page'
              ? solveAxisRemap(recentRemapObs, {
                dIn: mapper.stance.d,
                pitchXIn: mapper.cfg.pitchXIn,
                pitchYIn: mapper.cfg.pitchYIn,
                currentRemapId: mapper.cfg.axisRemapId || 0,
              })
              : solveAxisRemap(recentRemapObs, {
                distanceIn: mapper.stance.d,
                pitchXIn: mapper.cfg.pitchXIn,
                pitchYIn: mapper.cfg.pitchYIn,
                currentRemapId: mapper.cfg.axisRemapId || 0,
              });
            if (sol.improved) {
              mapper.updateConfig({ axisRemapId: sol.remap.id });
              mapper.stance.stanceWarning = false;
              remapFixes++;
              remapLog.push({ f: fr.f, id: sol.remap.id });
            }
          }
        }
      }
    }

    // ---- final scoring -----------------------------------------------------------------------
    const cells = mapper.getCells();
    let readCells = 0;
    let correctCells = 0;
    let wrongCells = 0;
    let conflictCells = 0;
    const table = new Array(nCells);
    for (let i = 0; i < nCells; i++) {
      const c = cells[i];
      table[i] = `${c.state}|${c.payload}|${c.readCount}|${c.lastErrIn}`;
      if (c.state === 'READ') {
        readCells++;
        if (c.payload === scene.cells[i].payload) correctCells++;
        else wrongCells++;
      } else if (c.state === 'CONFLICT') {
        conflictCells++;
      }
    }

    // drift (inches): mapped aim vs true aim, after the zero
    const errs = [];
    for (let i = 0; i < aimErr.length; i++) if (aimErrOk[i]) errs.push(aimErr[i]);
    const sorted = errs.slice().sort((a, b) => a - b);
    const pick = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null);
    const meanErr = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
    const minPitch = Math.min(scene.pitchXIn, scene.pitchYIn);
    const okThresh = ZERO_OK_FRAC * minPitch;
    // time to correct zero: first frame from which the mapped aim point stays within the threshold
    // for the rest of the run (null if it never settles or is out again at the end)
    let timeToZeroSec = null;
    {
      let lastBad = -1;
      for (let i = 0; i < aimErr.length; i++) if (aimErrOk[i] !== 1 || aimErr[i] > okThresh) lastBad = i;
      if (lastBad < aimErr.length - 1) timeToZeroSec = lastBad < 0 ? 0 : run.frames[lastBad + 1].tSec;
    }
    const finalErr = aimErrOk[aimErr.length - 1] ? aimErr[aimErr.length - 1] : null;

    const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
    return {
      flags: Object.keys(flags).filter((k) => flags[k]),
      detections: m.detections,
      placed: m.placed,
      correct: m.correct,
      wrong: m.wrong,
      unplaced: m.unplaced,
      attribution: m.placed > 0 ? Math.round((m.correct / Math.max(1, m.correct + m.wrong)) * 1000) / 1000 : null,
      readCells,
      correctCells,
      wrongCells,
      conflictCells,
      falseConflicts: conflictCells, // the sim has no genuine duplicate payloads
      coverage: Math.round((correctCells / nCells) * 1000) / 1000,
      driftIn: { mean: r1(meanErr), p95: r1(pick(0.95)), max: r1(sorted.length ? sorted[sorted.length - 1] : null), final: r1(finalErr) },
      timeToZeroSec: timeToZeroSec === null ? null : Math.round(timeToZeroSec * 100) / 100,
      zeroEvents,
      autoZero: autoZeroFiredAtMs === null ? null : { atSec: Math.round(((autoZeroFiredAtMs - LOOP_T0_MS) / 1000) * 100) / 100, distanceIn: autoZeroDist },
      standDistanceIn: Math.round(mapper.stance.d * 10) / 10,
      remapFixes,
      remapLog,
      axisRemapId: mapper.cfg.axisRemapId || 0,
      hold: lastHold ? lastHold.verdict : null,
      wrongLog,
      table,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Slide mode (S07): close-range translation pass scored through createSlideWallMapper
// ---------------------------------------------------------------------------------------------

/**
 * Records a close-range slide pass (native preset path, e.g. `snake-h` at 8 in): renders + decodes
 * frames and stores detections, the true camera pose and the truth cell of every payload.
 */
export function recordSlideRun(o = {}) {
  const presetId = o.presetId || 'fc-8-3p5';
  const preset = getPreset(presetId);
  const scene = o.scene || createSceneForPreset(presetId);
  const width = o.width ?? preset.width;
  const height = o.height ?? preset.height;
  const fps = o.fps ?? preset.fpsCap;
  const seed = o.seed ?? 1;
  const workerMask = o.workerMask | 0;
  const poseCfg = {
    distanceIn: preset.distanceIn,
    speedInPerSec: o.speedInPerSec ?? preset.speedInPerSec,
    jitter: o.jitter ?? preset.jitter,
    loop: false,
  };
  const pathDef = PATH_DEFINITIONS.find((p) => p.id === preset.pathId);
  const durationSec = (pathDef ? pathDef.lengthIn : 100) / Math.max(0.5, poseCfg.speedInPerSec) + 0.3;
  const frameCount = Math.max(1, Math.floor(durationSec * fps));
  const payloadToCell = new Map();
  for (let i = 0; i < scene.cells.length; i++) payloadToCell.set(scene.cells[i].payload, i);

  const ctx = createCpuRenderContext(scene.cells.length);
  const luma = new Uint8Array(width * height);
  const ws = createPipelineState(width, height);
  ws.flags = workerMask;
  const wr = createPipelineResult();
  const renderOpts = {
    width,
    height,
    hfovDeg: preset.hfovDeg,
    shadowStrength: scene.shadowStrength,
    noiseStrength: scene.noiseStrength,
    glareStrength: scene.glareStrength,
    frameSeed: 0,
    ctx,
  };
  const frames = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    const pose = sampleCameraPose(preset.pathId, t, poseCfg);
    renderOpts.frameSeed = seed * 100003 + f * 0.71;
    renderFrame(scene, [pose], renderOpts, luma);
    ws.flags = workerMask;
    processFrameMulti(luma, width, height, ws, wr, false);
    const raw = extractMultiDetections(ws);
    const dets = [];
    for (let i = 0; i < raw.length; i++) {
      const d = raw[i];
      if (!d.payload) continue;
      dets.push({
        payload: d.payload,
        cx: d.roiCenterX,
        cy: d.roiCenterY,
        lenPx: d.roiMajorLen,
        prefixOk: d.prefixOk,
        truthCell: payloadToCell.has(d.payload) ? payloadToCell.get(d.payload) : -1,
      });
    }
    frames[f] = {
      f,
      tSec: t,
      pose: { x: pose.x, y: pose.y, z: pose.z, yawDeg: pose.yawDeg, pitchDeg: pose.pitchDeg, rollDeg: pose.rollDeg },
      dets,
    };
  }
  return { kind: 'slide', presetId, scene, seed, width, height, fps, hfovDeg: preset.hfovDeg, durationSec, workerMask, frames };
}

/**
 * Replays a slide run through `createSlideWallMapper` exactly as array.html does (anchor on R1C1, then
 * per frame `stepMotion` + one `addDetection` per decoded label). Optical flow and gyro are
 * synthesised from the true pose delta (flow quality is covered by flow.test.js).
 *
 * @param {object} run  `recordSlideRun()` result
 * @param {{ flowNoisePx?: number, gyroNoiseRadPerSec?: number, seed?: number,
 *           dropFlowFromSec?: number, dropFlowToSec?: number, flowConf?: number }} [o]
 */
export function runSlideLoop(run, o = {}) {
  const scene = run.scene;
  const rng = mulberry32((Math.imul((o.seed ?? run.seed ?? 1) | 0, 0x9e3779b1) ^ 0x51ed270b) >>> 0);
  const flowNoise = o.flowNoisePx ?? 1.5;
  const gyroNoise = o.gyroNoiseRadPerSec ?? 0.004;
  const frameW = run.width;
  const frameH = run.height;
  const fPx = (Math.max(frameW, frameH) * 0.5) / Math.tan(run.hfovDeg * 0.5 * DEG);

  return withSimClock((setNow) => {
    const mapper = createSlideWallMapper({
      cols: scene.cols,
      rows: scene.rows,
      toteOrientation: scene.pitchXIn > scene.pitchYIn ? '16Wx14H' : '14Wx16H',
      pitchXIn: scene.pitchXIn,
      pitchYIn: scene.pitchYIn,
      labelLenIn: scene.label.heightIn,
      hfovDeg: run.hfovDeg,
      distanceIn: 10,
      startCorner: 'top-left',
    });
    mapper.anchorPoseToCell(0, 0);
    // the slide mapper works in its own lattice frame (its R1C1 centre), not scene coordinates
    const c00 = mapper.getCells()[0];
    const m = { detections: 0, placed: 0, correct: 0, wrong: 0, unplaced: 0 };
    const drift = [];
    let prev = null;
    const trackingCounts = {};
    for (let fi = 0; fi < run.frames.length; fi++) {
      const fr = run.frames[fi];
      const tMs = LOOP_T0_MS + fr.tSec * 1000;
      setNow(tMs);
      if (prev) {
        const dt = fr.tSec - prev.tSec;
        const dxIn = fr.pose.x - prev.pose.x;
        const dyIn = fr.pose.y - prev.pose.y;
        const dYaw = (fr.pose.yawDeg - prev.pose.yawDeg) * DEG;
        const dPitch = (fr.pose.pitchDeg - prev.pose.pitchDeg) * DEG;
        const gyroRadY = -dYaw / dt + gauss(rng) * gyroNoise;
        const gyroRadX = dPitch / dt + gauss(rng) * gyroNoise;
        const pxPerIn = fPx / Math.max(4, fr.pose.z);
        const flowDx = -dxIn * pxPerIn + fPx * Math.tan(gyroRadY * dt) + gauss(rng) * flowNoise;
        const flowDy = dyIn * pxPerIn + fPx * Math.tan(gyroRadX * dt) + gauss(rng) * flowNoise;
        const dropped = o.dropFlowFromSec !== undefined && fr.tSec >= o.dropFlowFromSec && fr.tSec < (o.dropFlowToSec ?? Infinity);
        const st = mapper.stepMotion({
          dtMs: dt * 1000,
          flowDx,
          flowDy,
          flowConf: dropped ? 0.05 : (o.flowConf ?? 0.75),
          gyroRadX,
          gyroRadY,
          frameW,
          frameH,
        });
        trackingCounts[st.trackingState] = (trackingCounts[st.trackingState] || 0) + 1;
      }
      prev = fr;
      // pose drift: mapper pose vs true camera position, both relative to the R1C1 anchor
      const p0 = run.frames[0].pose;
      const truthX = c00.cx + (fr.pose.x - p0.x);
      const truthY = c00.cy + (fr.pose.y - p0.y);
      drift.push(Math.hypot(mapper.pose.x - truthX, mapper.pose.y - truthY));

      for (let di = 0; di < fr.dets.length; di++) {
        const d = fr.dets[di];
        m.detections++;
        const res = mapper.addDetection({
          payload: d.payload,
          cx: d.cx,
          cy: d.cy,
          lenPx: d.lenPx,
          frameW,
          frameH,
          prefixOk: d.prefixOk,
          tFrameMs: tMs,
        });
        if (res.placed) {
          m.placed++;
          if (d.truthCell >= 0) {
            if (res.cell.index === d.truthCell) m.correct++;
            else m.wrong++;
          }
        } else {
          m.unplaced++;
        }
      }
    }
    const cells = mapper.getCells();
    let readCells = 0;
    let correctCells = 0;
    let silentWrongCells = 0;
    let missingCells = 0;
    let conflictCells = 0;
    const table = new Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      table[i] = `${c.state}|${c.payload}|${c.readCount}`;
      if (c.state === 'READ') {
        readCells++;
        if (c.payload === scene.cells[i].payload) correctCells++;
        else silentWrongCells++;
      } else if (c.state === 'MISSING') missingCells++;
      else if (c.state === 'CONFLICT') conflictCells++;
    }
    const sorted = drift.slice().sort((a, b) => a - b);
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      detections: m.detections,
      placed: m.placed,
      correct: m.correct,
      wrong: m.wrong,
      unplaced: m.unplaced,
      attribution: m.correct + m.wrong > 0 ? Math.round((m.correct / (m.correct + m.wrong)) * 1000) / 1000 : null,
      readCells,
      correctCells,
      silentWrongCells,
      missingCells,
      conflictCells,
      coverage: Math.round((correctCells / cells.length) * 1000) / 1000,
      driftIn: {
        mean: r1(drift.reduce((a, b) => a + b, 0) / drift.length),
        p95: r1(sorted[Math.floor((sorted.length - 1) * 0.95)]),
        max: r1(sorted[sorted.length - 1]),
        final: r1(drift[drift.length - 1]),
      },
      trackingCounts,
      startOffsetIn: r1(Math.hypot(run.frames[0].pose.x - scene.cells[0].cx, run.frames[0].pose.y - scene.cells[0].cy)),
      table,
    };
  });
}

/** Stable digest of a loop result table for bit-identical comparisons. */
export function tableKey(result) {
  return result.table.join('\n');
}
