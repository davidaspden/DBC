/**
 * T2 — golden-tape replay scoring (`tools/gate/tape-score.mjs`, extended `tools/replay.mjs`).
 *   node tests/tape-score.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTapeRecorder } from '../src/tape/record.js';
import { createScenarioFromPreset } from '../tools/gate/scenarios.mjs';
import { exportScenarioTape } from '../tools/sim-to-tape.mjs';
import { parseTapeBytes, replayTape, describeTapeCamera } from '../tools/replay.mjs';
import { scoreParsedTape, scoreTapes, expectedPayloadsFor, compareToBaseline, formatReport } from '../tools/gate/tape-score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}
const run = (args) => spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
const strip = (res) => JSON.parse(JSON.stringify(res, (k, v) => (k === 'workerMs' ? undefined : v)));

const dir = mkdtempSync(join(tmpdir(), 'dbc-tapes-'));
const tapesDir = join(dir, 'tapes');
mkdirSync(tapesDir);

// a sim-exported tape (T4), flags off, with its scene truth in the header
const sc = createScenarioFromPreset('fc-8-3p5', { flagSet: 'off', durationSec: 2.5, width: 960, height: 540 });
const ex = await exportScenarioTape(sc, 1);
const goodPath = join(tapesDir, 'sim-fc-8-3p5.dbct');
writeFileSync(goodPath, ex.bytes);
const good = parseTapeBytes(ex.bytes);

/** Re-records `good` with blank luma frames (same metas): a tape that no longer decodes anything. */
async function blankTape(parsed, extraMeta = {}) {
  const rec = createTapeRecorder({ maxFrames: parsed.frames.length, compress: false, meta: { ...parsed.header.meta, ...extraMeta } });
  rec.start();
  for (const f of parsed.frames) {
    await rec.pushFrame({ ...f.meta, luma: new Uint8Array(f.meta.width * f.meta.height), expectedPayloads: f.meta.expectedPayloads });
  }
  return rec.exportBytes();
}

await test('T2 replay.mjs stays backwards compatible: same legacy fields, same CLI line, additive extras', () => {
  const rep = replayTape(good, 0);
  for (const k of ['frameCount', 'goldenTotal', 'goldenMatched', 'extraDecoded', 'missingPayloads', 'p50Ms', 'p95Ms', 'pass']) {
    assert.ok(k in rep, k);
  }
  assert.equal(rep.frameCount, good.frames.length);
  assert.equal(rep.pass, true, 'a flags-off tape replays its own golden payloads');
  assert.ok(rep.decodedPayloads.length > 0 && rep.decodedPayloads.every((p) => p in rep.firstSeen));
  assert.equal(rep.firstSeen[rep.decodedPayloads[0]].tSec >= 0, true);
  const cli = run(['tools/replay.mjs', goodPath]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^Replay .*: frames=\d+ golden=\d+\/\d+ extra=\d+ p50=[\d.]+ms p95=[\d.]+ms -> PASS\n$/);
  // vertical option is opt-in: undefined leaves the mode alone (identical to the old call)
  const a = replayTape(good, 0, {});
  const b = replayTape(good, 0);
  assert.deepEqual(a.decodedPayloads, b.decodedPayloads);
});

await test('T2 describeTapeCamera: fps/exposure/ISO are "unknown" (null) when the tape lacks them, read when present', async () => {
  const c = describeTapeCamera(good);
  assert.equal(c.fps, sc.fpsCap, 'the sim exporter records its frame rate');
  assert.equal(c.iso, null);
  assert.equal(c.exposureMs, null);
  assert.ok(Math.abs(c.derivedFps - sc.fpsCap) < 1, `derived ${c.derivedFps}`);
  const bare = createTapeRecorder({ compress: false });
  bare.start();
  for (let i = 0; i < 4; i++) await bare.pushFrame({ frameId: i, tFrameMs: i * 50, width: 4, height: 4, luma: new Uint8Array(16) });
  const cb = describeTapeCamera(parseTapeBytes(bare.exportBytes()));
  assert.equal(cb.fps, null);
  assert.equal(cb.iso, null);
  assert.ok(Math.abs(cb.derivedFps - 20) < 1e-9);
  const sb = scoreParsedTape(parseTapeBytes(bare.exportBytes()), { sets: ['off'] });
  assert.equal(sb.camera.fps, 'unknown');
  assert.equal(sb.camera.iso, 'unknown');
  assert.equal(sb.camera.exposureMs, 'unknown');
  const rec = createTapeRecorder({ compress: false, meta: { camera: { fps: 12.5, iso: 1600, exposureMs: 8 } } });
  rec.start();
  for (let i = 0; i < 3; i++) await rec.pushFrame({ frameId: i, tFrameMs: i * 80, width: 4, height: 4, luma: new Uint8Array(16), fps: 12.5 });
  const c2 = describeTapeCamera(parseTapeBytes(rec.exportBytes()));
  assert.equal(c2.fps, 12.5);
  assert.equal(c2.iso, 1600);
  assert.equal(c2.exposureMs, 8);
  assert.ok(Math.abs(c2.derivedFps - 12.5) < 1e-9);
});

let score;
await test('T2 scores a sim-exported (T4) tape over off / W-fc / W-all with the full per-set output', () => {
  score = scoreParsedTape(good, { sets: ['off', 'W-fc', 'W-all'] });
  assert.deepEqual(score.sets.map((s) => s.id), ['off', 'W-fc', 'W-all']);
  assert.equal(score.truth.known, true);
  assert.equal(score.truth.source, 'header');
  assert.equal(score.truth.payloads.length, 16);
  assert.equal(score.camera.fps, sc.fpsCap);
  assert.equal(score.camera.iso, 'unknown');
  const off = score.sets[0];
  assert.ok(off.decoded.length > 0, 'something decodes');
  for (const s of score.sets) {
    assert.ok(Number.isFinite(s.workerMs.p50) && Number.isFinite(s.workerMs.p95));
    assert.equal(s.frames, good.frames.length);
    for (const p of s.decoded) assert.ok(s.timeToFirstSec[p] >= 0, 'time to first per payload');
    assert.equal(s.falsePositiveDetections, 0, `${s.id} FP`);
  }
  console.log('        ' + score.sets.map((s) => `${s.id}: ${s.decoded.length}/16`).join('  ') + `  violations: ${score.violations.length}`);
  assert.deepEqual(score.violations, [], 'the superset rule holds on this tape');
  assert.ok(/TAPE SCORE: PASS/.test(formatReport({ tapes: [{ name: 'x', ...score }], violations: [], pass: true })));
});

await test('T2 scoring is deterministic (two runs give the same decode sets, times and FP)', () => {
  const again = scoreParsedTape(good, { sets: ['off', 'W-fc', 'W-all'] });
  assert.deepEqual(strip(again), strip(score));
});

await test('T2 rules: R1 superset and R2 no-new-wrong fire (injected replay results)', () => {
  const fake = (decodedByMask) => (parsed, mask) => {
    const decodedPayloads = decodedByMask(mask);
    const payloadFrameCounts = {};
    const firstSeen = {};
    for (const p of decodedPayloads) { payloadFrameCounts[p] = 2; firstSeen[p] = { tSec: 1, frameIndex: 3 }; }
    return { decodedPayloads, payloadFrameCounts, firstSeen, p50Ms: 1, p95Ms: 2, maxMs: 3, frameCount: 5, missingPayloads: [] };
  };
  const sidecar = { labels: [{ payload: 'A' }, { payload: 'B' }] };
  // flags-on loses B (R1)
  let r = scoreParsedTape(good, { sidecar, sets: ['off', 'W-fc'], replay: fake((m) => (m === 0 ? ['A', 'B'] : ['A'])) });
  assert.deepEqual(r.violations.map((v) => v.rule), ['R1-superset']);
  // flags-on adds a wrong payload X (R2)
  r = scoreParsedTape(good, { sidecar, sets: ['off', 'W-fc'], replay: fake((m) => (m === 0 ? ['A'] : ['A', 'B', 'X'])) });
  assert.deepEqual(r.violations.map((v) => v.rule), ['R2-new-wrong']);
  assert.equal(r.sets[1].falsePositiveDetections, 2);
  // a wrong payload that flags-off also decodes is not "new"
  r = scoreParsedTape(good, { sidecar, sets: ['off', 'W-fc'], replay: fake((m) => (m === 0 ? ['A', 'X'] : ['A', 'B', 'X'])) });
  assert.deepEqual(r.violations, []);
  // unknown truth: R2 is reported as unchecked, R1 still applies
  const noTruth = { ...good, header: { ...good.header, meta: {} } };
  r = scoreParsedTape(noTruth, { sets: ['off', 'W-fc'], replay: fake((m) => (m === 0 ? ['A'] : ['A', 'X'])) });
  assert.match(r.r2, /unchecked/);
  assert.deepEqual(r.violations, []);
  // clean superset
  r = scoreParsedTape(good, { sidecar, sets: ['off', 'W-fc'], replay: fake((m) => (m === 0 ? ['A'] : ['A', 'B'])) });
  assert.deepEqual(r.violations, []);
});

await test('T2 sidecar: expected payloads and device info come from tapes/<name>.json (negative tape: every decode is wrong)', () => {
  writeFileSync(join(tapesDir, 'sim-fc-8-3p5.json'), JSON.stringify({ version: 1, name: 'sim', device: { model: 'sim' }, lighting: { condition: 'ideal' }, distance: { nominalIn: 8 }, labels: [] }));
  const res = scoreTapes([goodPath], { sets: ['off'] });
  const t = res.tapes[0];
  assert.equal(t.truth.source, 'sidecar');
  assert.equal(t.truth.payloads.length, 0);
  assert.equal(t.sidecar.device.model, 'sim');
  assert.equal(t.sets[0].wrong.length, t.sets[0].decoded.length, 'with an empty label list every decode is wrong');
  assert.ok(t.sets[0].falsePositiveDetections > 0);
  assert.equal(expectedPayloadsFor(good, { labels: [{ payload: 'Q' }] }).payloads[0], 'Q');
  writeFileSync(join(tapesDir, 'sim-fc-8-3p5.json'), JSON.stringify({ version: 1, labels: sc.scene.cells.map((c) => ({ payload: c.payload, orientation: 'ladder' })) }));
  assert.equal(scoreTapes([goodPath], { sets: ['off'] }).tapes[0].sets[0].falsePositiveDetections, 0);
});

await test('T2 regression: a tape that stops decoding fails against the baseline (R3) and the CLI exits 1; the good tape exits 0', async () => {
  const basePath = join(dir, 'baseline.json');
  const ok = run(['tools/gate/tape-score.mjs', '--dir', tapesDir, '--sets', 'off,W-fc', '--json', basePath]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /TAPE SCORE: PASS/);
  const same = run(['tools/gate/tape-score.mjs', '--dir', tapesDir, '--sets', 'off,W-fc', '--baseline', basePath]);
  assert.equal(same.status, 0, same.stdout);
  // replace the tape by a blanked copy of the same name: decodes vanish
  const bad = await blankTape(good, { workerMask: 0 });
  writeFileSync(goodPath, bad);
  const fail = run(['tools/gate/tape-score.mjs', '--dir', tapesDir, '--sets', 'off,W-fc', '--baseline', basePath]);
  assert.equal(fail.status, 1, fail.stdout);
  assert.match(fail.stdout, /R3-baseline/);
  assert.match(fail.stdout, /TAPE SCORE: FAIL/);
  writeFileSync(goodPath, ex.bytes);
  // direct API
  const cur = scoreTapes([goodPath], { sets: ['off', 'W-fc'] });
  const base = JSON.parse(JSON.stringify(cur));
  base.tapes[0].sets[0].decoded.push('GONE');
  assert.equal(compareToBaseline(cur, base).length, 1);
});

await test('T2 golden (R4): per-frame golden payloads that stop decoding fail with --golden', async () => {
  const goldenPath = join(dir, 'golden-only');
  mkdirSync(goldenPath);
  // blank frames that claim a golden payload, recorded with worker mask 0
  const rec = createTapeRecorder({ compress: false, meta: { workerMask: 0 } });
  rec.start();
  for (let i = 0; i < 3; i++) await rec.pushFrame({ frameId: i, tFrameMs: i * 33, width: 64, height: 64, luma: new Uint8Array(64 * 64), expectedPayloads: ['tsX07wz7py1'] });
  writeFileSync(join(goldenPath, 'blank.dbct'), rec.exportBytes());
  const noGolden = run(['tools/gate/tape-score.mjs', '--dir', goldenPath, '--sets', 'off']);
  assert.equal(noGolden.status, 0, noGolden.stdout);
  const withGolden = run(['tools/gate/tape-score.mjs', '--dir', goldenPath, '--sets', 'off', '--golden']);
  assert.equal(withGolden.status, 1, withGolden.stdout);
  assert.match(withGolden.stdout, /R4-golden/);
});

await test('T2 CLI: an empty tapes folder passes (no tapes yet) unless --require-tapes', () => {
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const a = run(['tools/gate/tape-score.mjs', '--dir', empty]);
  assert.equal(a.status, 0);
  assert.match(a.stdout, /no tapes to score/);
  const b = run(['tools/gate/tape-score.mjs', '--dir', empty, '--require-tapes']);
  assert.equal(b.status, 1);
});

console.log(`\nAll ${passed} T2 tape-score tests passed.`);
