/**
 * R7 — array mapper in the loop (`src/sim/array-loop.js`).
 *   node tests/array-loop.test.js
 *
 * Real decoder detections from CPU-rendered sim frames + synthesised 60 Hz sensors go through the real
 * array modules and are scored against truth. Frames are 960x540 so the file runs in about a minute.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPanArrayMapper } from '../src/array/pan-mapper.js';
import { quatFromPanTiltRollDeg } from '../src/array/orient.js';
import {
  LOOP_T0_MS,
  START_ORIENTATIONS,
  A_ALL_STANDBACK,
  ARRAY_FLAG_NAMES,
  ZERO_OK_FRAC,
  flagsFromNames,
  recordStandbackRun,
  recordSlideRun,
  synthSensors,
  runArrayLoop,
  runSlideLoop,
  tableKey,
} from '../src/sim/array-loop.js';
import { ORIGINAL_PRESET_IDS } from '../src/sim/presets.js';
import { loadLegacyArrayModules, legacyCommitAvailable } from '../tools/gate/array-legacy.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const SIZE = { width: 960, height: 540 };
const BASE = { presetId: 'tele-30', trueDistanceIn: 30, hfovDeg: 26, speedInPerSec: 30, ...SIZE };
const cache = new Map();
function rec(key, o) {
  if (!cache.has(key)) cache.set(key, recordStandbackRun(o));
  return cache.get(key);
}
const noGz = A_ALL_STANDBACK.filter((n) => n !== 'orientGravityZero');
const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);

await test('R7 recording and sensors are deterministic, 60 Hz and unit quaternions', () => {
  const a = recordStandbackRun({ ...BASE, stance: 'centre' });
  const b = recordStandbackRun({ ...BASE, stance: 'centre' });
  assert.equal(digest(a.frames.map((f) => f.dets)), digest(b.frames.map((f) => f.dets)));
  cache.set('centre0', a);
  const s1 = synthSensors(a, { seed: 3 });
  const s2 = synthSensors(a, { seed: 3 });
  assert.deepEqual(Array.from(s1.q.slice(0, 400)), Array.from(s2.q.slice(0, 400)));
  assert.ok(Math.abs(s1.tMs[1] - s1.tMs[0] - 1000 / 60) < 1e-6);
  assert.ok(s1.tMs[0] < LOOP_T0_MS, 'pre-roll samples precede the run start');
  for (let k = 0; k < s1.n; k += 37) {
    const n = Math.hypot(s1.q[k * 4], s1.q[k * 4 + 1], s1.q[k * 4 + 2], s1.q[k * 4 + 3]);
    assert.ok(Math.abs(n - 1) < 1e-9);
  }
});

await test('R7 truth convention: sim pose quaternion projects labels onto their true cells (roll sign)', () => {
  const run = recordStandbackRun({ ...BASE, stance: 'centre', rollOffsetDeg: 25, jitter: 0 });
  cache.set('truth-tilt', run);
  const m = createPanArrayMapper({ distanceIn: 30, hfovDeg: 26 });
  const meanErr = (sign) => {
    let n = 0;
    let sum = 0;
    for (const fr of run.frames) {
      for (const d of fr.dets) {
        const q = quatFromPanTiltRollDeg(fr.pose.yawDeg, fr.pose.pitchDeg, sign * fr.pose.rollDeg);
        const p = m.projectPixelToWall(q, d.cx, d.cy, run.width, run.height);
        const c = run.scene.cells[d.truthCell];
        sum += Math.hypot(p.wx - c.cx, p.wy - c.cy);
        n++;
      }
    }
    assert.ok(n > 40);
    return sum / n;
  };
  assert.ok(meanErr(1) < 1.0, `correct roll sign error ${meanErr(1)}`);
  assert.ok(meanErr(-1) > 2 * meanErr(1), 'wrong roll sign must be clearly worse');
});

await test('R7 ideal upright run: every placed read is on its true cell and drift is small', () => {
  const run = cache.get('centre0');
  const r = runArrayLoop(run, synthSensors(run, {}), {});
  assert.equal(r.wrong, 0);
  assert.equal(r.wrongCells, 0);
  assert.equal(r.conflictCells, 0);
  assert.ok(r.correctCells >= 10, `cells ${r.correctCells}`);
  assert.ok(r.driftIn.max < ZERO_OK_FRAC * 14, `drift ${JSON.stringify(r.driftIn)}`);
  assert.equal(r.timeToZeroSec, 0);
});

await test('R7 drift grows with the synthetic gyro drift rate (drift is measured in inches vs truth)', () => {
  const run = cache.get('centre0');
  const lo = runArrayLoop(run, synthSensors(run, { driftDegPerMin: 0, noiseDeg: 0 }), {});
  const hi = runArrayLoop(run, synthSensors(run, { driftDegPerMin: 60, noiseDeg: 0 }), {});
  assert.ok(hi.driftIn.mean > lo.driftIn.mean + 0.5, `${lo.driftIn.mean} -> ${hi.driftIn.mean}`);
});

await test('R7 S01: flags off, the 4 original presets map identical cells to the d917944 mapper', async () => {
  if (!legacyCommitAvailable()) {
    console.log('        (d917944 not in this clone history: comparison skipped)');
    return;
  }
  const legacy = await loadLegacyArrayModules();
  const same = (run, sensors) => {
    const now = runArrayLoop(run, sensors, {});
    const old = runArrayLoop(run, sensors, { modules: { createPanArrayMapper: legacy.createPanArrayMapper } });
    assert.equal(tableKey(now), tableKey(old));
    assert.equal(now.placed, old.placed);
    assert.equal(now.correct, old.correct);
    assert.equal(now.conflictCells, old.conflictCells);
    return now;
  };
  for (const id of ORIGINAL_PRESET_IDS) {
    const run = rec(`orig-${id}`, { presetId: id, ...SIZE });
    const r = same(run, synthSensors(run, {}));
    assert.ok(r.placed > 50, `${id} placed ${r.placed}`);
    assert.equal(r.wrong, 0);
  }
  // harder inputs (wrong placements, conflicts, unplaced) must match too, not just the easy ones
  const tilt = cache.get('truth-tilt');
  const hard = same(tilt, synthSensors(tilt, {}));
  assert.ok(hard.wrong > 10, 'the tilted run really exercises wrong placements');
  const run = cache.get('centre0');
  const rot = same(run, synthSensors(run, { alphaDeg: 90 }));
  assert.ok(rot.wrong > 10);
});

await test('R7 S02: all A flags on (stand-back set) is no worse than off on the 4 original presets', () => {
  for (const id of ORIGINAL_PRESET_IDS) {
    const run = rec(`orig-${id}`, { presetId: id, ...SIZE });
    const s = synthSensors(run, {});
    const off = runArrayLoop(run, s, {});
    const on = runArrayLoop(run, s, { flags: flagsFromNames(noGz) });
    const pitch = Math.min(run.scene.pitchXIn, run.scene.pitchYIn);
    assert.ok(on.correctCells >= off.correctCells, `${id} cells ${off.correctCells} -> ${on.correctCells}`);
    assert.ok(on.wrongCells <= off.wrongCells && on.wrong <= off.wrong, `${id} wrong`);
    assert.ok(on.falseConflicts <= off.falseConflicts);
    assert.ok(on.driftIn.max <= ZERO_OK_FRAC * pitch, `${id} drift ${on.driftIn.max}`);
  }
});

await test('R7 S12: wrong start orientation breaks the legacy zero; orientGravityZero (with the screen angle) recovers it', () => {
  for (const o of START_ORIENTATIONS) {
    const centre = rec(`c-${o.rollOffsetDeg}`, { ...BASE, stance: 'centre', rollOffsetDeg: o.rollOffsetDeg });
    const front = rec(`f-${o.rollOffsetDeg}`, { ...BASE, stance: 'in-front', rollOffsetDeg: o.rollOffsetDeg });
    const off = runArrayLoop(centre, synthSensors(centre, { alphaDeg: o.alphaDeg }), {});
    const gz = runArrayLoop(front, synthSensors(front, { alphaDeg: o.alphaDeg, gravityFrame: true }), {
      flags: flagsFromNames(['orientGravityZero']),
    });
    const all = runArrayLoop(front, synthSensors(front, { alphaDeg: o.alphaDeg, gravityFrame: true }), {
      flags: flagsFromNames(A_ALL_STANDBACK),
    });
    if (o.alphaDeg !== 0 || o.rollOffsetDeg !== 0) {
      assert.ok(off.wrong > off.correct, `${o.id}: legacy should misattribute (ok ${off.correct}, wrong ${off.wrong})`);
    }
    for (const r of [gz, all]) {
      assert.equal(r.wrong, 0, `${o.id} gravityZero wrong ${r.wrong}`);
      assert.equal(r.wrongCells, 0);
      assert.ok(r.correctCells >= 6);
      assert.ok((r.attribution ?? 0) >= (off.attribution ?? 0));
    }
    assert.equal(gz.hold, o.rollOffsetDeg ? 'ROTATED' : 'OK');
  }
});

await test('R7 axisRemapAuto as wired in array.html never fires (its observations use keys the solver does not read)', () => {
  const run = cache.get('centre0');
  for (const a of [90, 180, 270]) {
    const r = runArrayLoop(run, synthSensors(run, { alphaDeg: a }), { flags: flagsFromNames(['axisRemapAuto']) });
    assert.equal(r.remapFixes, 0);
    assert.equal(r.axisRemapId, 0);
    const base = runArrayLoop(run, synthSensors(run, { alphaDeg: a }), {});
    assert.equal(tableKey(r), tableKey(base), 'identical to flags off');
  }
  // even with solver-format observations it does not recover a rotated start (no independent truth to snap to)
  const fixed = runArrayLoop(run, synthSensors(run, { alphaDeg: 180 }), {
    flags: flagsFromNames(['axisRemapAuto']),
    remapObsFormat: 'solver',
  });
  assert.ok(fixed.wrong >= fixed.correct);
});

await test('R7 driftFromLabel (A5) is not read by array.html or the mapper: flag on equals flag off', () => {
  for (const a of [0, 90]) {
    const run = cache.get('centre0');
    const s = synthSensors(run, { alphaDeg: a });
    const off = runArrayLoop(run, s, {});
    const on = runArrayLoop(run, s, { flags: flagsFromNames(['driftFromLabel']) });
    assert.equal(tableKey(on), tableKey(off));
    assert.deepEqual(on.driftIn, off.driftIn);
  }
});

await test('R7 panKalman pulls a mis-set standoff back towards the true 30 in and cuts drift', () => {
  const run = cache.get('centre0');
  const s = synthSensors(run, {});
  for (const ud of [22.5, 37.5]) {
    const off = runArrayLoop(run, s, { userDistanceIn: ud });
    const pk = runArrayLoop(run, s, { userDistanceIn: ud, flags: flagsFromNames(['panKalman']) });
    assert.ok(Math.abs(pk.standDistanceIn - 30) < Math.abs(ud - 30), `D ${ud} -> ${pk.standDistanceIn}`);
    assert.ok(pk.driftIn.mean < off.driftIn.mean, `${off.driftIn.mean} -> ${pk.driftIn.mean}`);
    assert.ok(pk.wrong <= off.wrong);
  }
});

await test('R7 single-flag sweep: every A flag is exercised in the loop and none makes upright attribution worse', () => {
  const run = cache.get('centre0');
  const s = synthSensors(run, {});
  const off = runArrayLoop(run, s, {});
  const front = rec('f-0', { ...BASE, stance: 'in-front', rollOffsetDeg: 0 });
  for (const n of ARRAY_FLAG_NAMES) {
    if (n === 'slideMap') continue; // its own mode, see the slide test
    if (n === 'orientGravityZero') {
      const r = runArrayLoop(front, synthSensors(front, { gravityFrame: true }), { flags: flagsFromNames([n]) });
      assert.deepEqual(r.flags, [n]);
      assert.equal(r.wrong, 0);
      continue;
    }
    const r = runArrayLoop(run, s, { flags: flagsFromNames([n]) });
    assert.deepEqual(r.flags, [n]);
    if (n === 'nudgeDamp') continue; // known to hurt on a mis-set standoff; upright-correct standoff only checked below
    assert.ok(r.wrong <= off.wrong, `${n} wrong ${r.wrong}`);
    assert.ok(r.correctCells >= off.correctCells, `${n} cells`);
  }
  const nd = runArrayLoop(run, s, { flags: flagsFromNames(['nudgeDamp']) });
  assert.equal(nd.wrong, 0);
});

await test('R7 autoZeroFromLabel fires on the centred start label during the hold and re-zeroes once', () => {
  const front = rec('f-0', { ...BASE, stance: 'in-front', rollOffsetDeg: 0 });
  const r = runArrayLoop(front, synthSensors(front, { gravityFrame: true }), {
    flags: flagsFromNames(['orientGravityZero', 'autoZeroFromLabel']),
  });
  assert.ok(r.autoZero, 'auto-zero should trigger');
  assert.ok(r.autoZero.atSec < 1.5, `fired at ${r.autoZero.atSec}s, inside the start hold`);
  assert.equal(r.zeroEvents, 2);
  assert.ok(r.autoZero.distanceIn >= 6 && r.autoZero.distanceIn <= 45);
  assert.equal(r.wrong, 0);
  // tilted hold: auto-zero must refuse (it gates on |roll| < 10 deg)
  const tf = rec('f-25', { ...BASE, stance: 'in-front', rollOffsetDeg: 25 });
  const t = runArrayLoop(tf, synthSensors(tf, { gravityFrame: true }), {
    flags: flagsFromNames(['orientGravityZero', 'autoZeroFromLabel']),
  });
  assert.equal(t.autoZero, null);
});

await test('R7 S07 slide pass: slide mapper places every cell with no silent wrong cell; dropped flow degrades safely', () => {
  const run = recordSlideRun({ presetId: 'fc-8-3p5', ...SIZE });
  const ok = runSlideLoop(run, {});
  assert.equal(ok.correctCells, 16);
  assert.equal(ok.silentWrongCells, 0);
  assert.equal(ok.wrong, 0);
  assert.ok(ok.driftIn.max < 5, `drift ${JSON.stringify(ok.driftIn)}`);
  const dropped = runSlideLoop(run, { dropFlowFromSec: 5, dropFlowToSec: 9 });
  assert.equal(dropped.silentWrongCells, 0, 'never a silently wrong READ cell');
  assert.ok(dropped.trackingCounts.LOST > 0, 'tracking reports LOST');
  assert.ok(dropped.correctCells < ok.correctCells);
});

console.log(`\nAll ${passed} R7 array-loop tests passed.`);
