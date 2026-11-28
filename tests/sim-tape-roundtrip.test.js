/**
 * T4 — sim -> tape export round trip. Exports a gate scenario seed to `.dbct` v1, replays the tape,
 * and requires the replay to equal the direct gate run (same decodes, same false positives, same
 * per-label first-decode times).
 */
import assert from 'node:assert/strict';
import { createScenarioFromPreset } from '../tools/gate/scenarios.mjs';
import { runScenarioSeed } from '../tools/gate/score.mjs';
import { parseTapeBytes, replayTape } from '../tools/replay.mjs';
import {
  exportScenarioTape,
  replayScenarioTape,
  diffDecodeSummaries,
  scenarioPhaseOffsetSec,
  scenarioUsesVerticalMode,
  synthSensorSample,
} from '../tools/sim-to-tape.mjs';
import { sampleCameraPose } from '../src/sim/paths.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const SIZE = { width: 960, height: 540 };
function scenario(flagSet) {
  return createScenarioFromPreset('fc-8-3p5', { flagSet, durationSec: 2.5, ...SIZE });
}

const summaries = {};

await test('export -> replay equals the direct gate run (flags off)', async () => {
  const sc = scenario('off');
  const direct = runScenarioSeed(sc, 1, { deviceFactor: 1 });
  const ex = await exportScenarioTape(sc, 1);
  const parsed = parseTapeBytes(ex.bytes);
  assert.equal(parsed.header.version, 1);
  assert.equal(parsed.frames.length, direct.framesRendered);
  const rep = replayScenarioTape(parsed);
  assert.deepEqual(diffDecodeSummaries(direct, rep), [], 'replay vs direct');
  assert.deepEqual(diffDecodeSummaries({ ...ex.summary, perFrame: ex.perFrame }, rep), [], 'replay vs export-time decode');
  assert.equal(rep.falsePositives, direct.falsePositives);
  assert.deepEqual(rep.decodedPayloads, direct.decodedPayloads);
  assert.ok(direct.decodedCount > 0, 'scenario decodes at least one label so the check is not vacuous');
  summaries.off = { direct, decoded: direct.decodedCount, total: direct.totalCells, fp: direct.falsePositives };
});

await test('export -> replay equals the direct gate run with worker flags incl. verticalMode (W-all)', async () => {
  const sc = scenario('W-all');
  assert.equal(scenarioUsesVerticalMode(sc), true);
  const direct = runScenarioSeed(sc, 2, { deviceFactor: 1 });
  const ex = await exportScenarioTape(sc, 2);
  const parsed = parseTapeBytes(ex.bytes);
  assert.equal(parsed.header.meta.vertical, true);
  assert.equal(parsed.header.meta.workerMask, sc.flags.workerMask);
  const rep = replayScenarioTape(parsed);
  assert.deepEqual(diffDecodeSummaries(direct, rep), []);
  summaries.wall = { decoded: direct.decodedCount, fp: direct.falsePositives };
});

await test('false positives round-trip: payloads outside the expected set are counted identically', async () => {
  // Treat only two of the scene's labels as expected; any other decoded label is a "false positive"
  // for both the gate and the replay, so the FP count and payload list must match exactly.
  const full = createScenarioFromPreset('fc-8-3p5', { flagSet: 'off', durationSec: 2.5, ...SIZE });
  const probe = runScenarioSeed(full, 1, { deviceFactor: 1 });
  assert.ok(probe.decodedPayloads.length >= 2, 'need >= 2 decodes to build an FP case');
  const keep = probe.decodedPayloads.slice(0, 1);
  const sc = createScenarioFromPreset('fc-8-3p5', { flagSet: 'off', durationSec: 2.5, expectedPayloads: keep, ...SIZE });
  const direct = runScenarioSeed(sc, 1, { deviceFactor: 1 });
  assert.ok(direct.falsePositives > 0, 'case must contain false positives');
  const ex = await exportScenarioTape(sc, 1);
  const rep = replayScenarioTape(parseTapeBytes(ex.bytes));
  assert.deepEqual(diffDecodeSummaries(direct, rep), []);
  assert.equal(rep.falsePositives, direct.falsePositives);
  assert.deepEqual(rep.falsePositivePayloads, direct.falsePositivePayloads);
  summaries.fp = direct.falsePositives;
});

await test('tape carries golden payloads, sim clock, synthesised sensors and scenario meta', async () => {
  const sc = scenario('off');
  const ex = await exportScenarioTape(sc, 1);
  const parsed = parseTapeBytes(ex.bytes);
  const m = parsed.header.meta;
  assert.equal(m.source, 'sim-to-tape');
  assert.equal(m.presetId, 'fc-8-3p5');
  assert.equal(m.seed, 1);
  assert.deepEqual(m.expectedPayloads, sc.scene.cells.map((c) => c.payload));
  assert.equal(m.phaseOffsetSec, scenarioPhaseOffsetSec(sc, 1));
  const f0 = parsed.frames[0].meta;
  assert.equal(f0.width, SIZE.width);
  assert.equal(f0.height, SIZE.height);
  assert.equal(f0.cropX, 0);
  assert.equal(f0.sensorSample.source, 'sim-synth');
  assert.equal(f0.sensorSample.q.length, 4);
  const norm = Math.hypot(...f0.sensorSample.q);
  assert.ok(Math.abs(norm - 1) < 1e-3, `quaternion norm ${norm}`);
  // Clock: frames are 1/fps apart starting at the seeded phase.
  const dt = (parsed.frames[1].meta.tFrameMs - parsed.frames[0].meta.tFrameMs) / 1000;
  assert.ok(Math.abs(dt - 1 / sc.fpsCap) < 1e-9);
  assert.ok(Math.abs(parsed.frames[0].meta.tFrameMs / 1000 - m.phaseOffsetSec) < 1e-9);
  const goldenUnion = new Set(parsed.frames.flatMap((f) => f.meta.expectedPayloads));
  assert.deepEqual([...goldenUnion].sort(), ex.summary.decodedPayloads);
});

await test('tools/replay.mjs also passes its golden check on an exported tape (flags off)', async () => {
  const sc = scenario('off');
  const ex = await exportScenarioTape(sc, 1);
  const rep = replayTape(parseTapeBytes(ex.bytes), sc.flags.workerMask);
  assert.equal(rep.pass, true);
  assert.equal(rep.goldenMatched, rep.goldenTotal);
  assert.ok(rep.goldenTotal > 0);
  assert.equal(rep.extraDecoded, 0);
});

await test('export is deterministic: same scenario + seed gives identical frames and decodes', async () => {
  const sc = scenario('off');
  const a = await exportScenarioTape(sc, 3);
  const b = await exportScenarioTape(sc, 3);
  const pa = parseTapeBytes(a.bytes);
  const pb = parseTapeBytes(b.bytes);
  assert.equal(pa.frames.length, pb.frames.length);
  for (let i = 0; i < pa.frames.length; i++) {
    assert.deepEqual(pa.frames[i].luma, pb.frames[i].luma, `frame ${i}`);
    assert.deepEqual(pa.frames[i].meta, pb.frames[i].meta, `meta ${i}`);
  }
  assert.deepEqual(diffDecodeSummaries({ ...a.summary, perFrame: a.perFrame }, { ...b.summary, perFrame: b.perFrame }), []);
  const c = await exportScenarioTape(sc, 4);
  assert.notDeepEqual(parseTapeBytes(c.bytes).frames[0].luma, pa.frames[0].luma, 'a different seed gives a different phase/noise');
});

await test('the comparison catches a tampered tape (negative control)', async () => {
  const sc = scenario('off');
  const direct = runScenarioSeed(sc, 1, { deviceFactor: 1 });
  const ex = await exportScenarioTape(sc, 1);
  const parsed = parseTapeBytes(ex.bytes);
  // Blank every frame that carried a golden decode: replay must now differ from the direct run.
  for (const fr of parsed.frames) if (fr.meta.expectedPayloads.length) fr.luma.fill(128);
  const rep = replayScenarioTape(parsed);
  const diffs = diffDecodeSummaries(direct, rep);
  assert.ok(diffs.length > 0, 'tamper must be detected');
  assert.ok(diffs.some((d) => d.startsWith('decodedPayloads') || d.startsWith('decodedCount')));
});

await test('flag A/B on one tape: replaying with another worker mask reuses the same pixels', async () => {
  const ex = await exportScenarioTape(scenario('off'), 1);
  const parsed = parseTapeBytes(ex.bytes);
  const off = replayScenarioTape(parsed);
  const wall = scenario('W-all');
  const repWall = replayScenarioTape(parsed, { workerMask: wall.flags.workerMask });
  assert.ok(repWall.decodedCount >= off.decodedCount - 1, `W-all ${repWall.decodedCount} vs off ${off.decodedCount}`);
  assert.equal(repWall.framesRendered, off.framesRendered);
});

await test('synthesised sensor sample follows the pose rates', () => {
  const sc = scenario('off');
  const cfg = { distanceIn: sc.distanceIn, speedInPerSec: sc.speed, jitter: sc.jitter, loop: sc.loop !== false, manualPose: sc.manualPose || undefined };
  const pose = sampleCameraPose(sc.path, 1.0, cfg);
  const s = synthSensorSample(sc, cfg, 1.0, pose);
  const p2 = sampleCameraPose(sc.path, 1.0 + 1 / 120, cfg);
  const p1 = sampleCameraPose(sc.path, 1.0 - 1 / 120, cfg);
  assert.ok(Math.abs(s.wPanDps - (p2.yawDeg - p1.yawDeg) * 60) < 1e-3);
  assert.equal(s.simPose.z, Math.round(pose.z * 10000) / 10000);
});

console.log(`  direct runs: off ${summaries.off.decoded}/${summaries.off.total} FP ${summaries.off.fp}; W-all ${summaries.wall.decoded} FP ${summaries.wall.fp}; FP-case FP ${summaries.fp}`);
console.log(`All ${passed} sim-to-tape round-trip tests passed.`);
