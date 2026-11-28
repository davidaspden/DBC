/**
 * R6 — GL to CPU parity: the CPU side and the comparison rules, plus the GL half when its frames are
 * committed (`tests/fixtures-sim/gl-parity/`).   node tests/gl-parity.test.js [--require-gl]
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderFrame } from '../src/sim/cpu-render.js';
import {
  PARITY_CASES, buildParityCase, glCellsFor, labelRects, compareFrames, flipVertical, decodeSet, judgeCase,
  encodePgm, decodePgm, INSIDE_LABEL_TOL, OUTSIDE_LABEL_TOL,
} from '../src/sim/gl-parity.js';
import { checkFixtureDir, FIXTURE_DIR } from '../tools/gl-parity-check.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}
const render = (b) => renderFrame(b.scene, b.pose, b.opts);

await test('R6 cases are well formed and the GL page would upload exactly the scene cells', () => {
  const ids = PARITY_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(PARITY_CASES.length, 6);
  for (const c of PARITY_CASES) {
    assert.equal(c.width % 4, 0, 'the GL luma pack needs width % 4 == 0');
    const b = buildParityCase(c);
    const gl = glCellsFor(b.fcMode);
    assert.equal(gl.length, b.scene.cells.length);
    assert.ok(gl.every((g, i) => g.payload === b.scene.cells[i].payload), `${c.id}: GL cells differ from the CPU scene`);
    assert.equal(b.opts.noiseStrength, 0);
    assert.ok(labelRects(b).length >= 1, `${c.id}: target label not in frame`);
  }
});

await test('R6 CPU side: deterministic renders that decode the target label on every case', () => {
  for (const c of PARITY_CASES) {
    const b = buildParityCase(c);
    const a = render(b);
    const again = render(b);
    assert.deepEqual(a, again, `${c.id} is not deterministic`);
    const target = b.scene.cells[c.cellIndex].payload;
    assert.ok(decodeSet(a, c.width, c.height).includes(target), `${c.id}: ${target} does not decode on the CPU frame`);
  }
});

await test('R6 PGM codec round-trips (raw and gzipped)', () => {
  const luma = Uint8Array.from({ length: 64 * 8 }, (_, i) => (i * 7) & 255);
  const pgm = encodePgm(luma, 64, 8);
  assert.equal(String.fromCharCode(...pgm.subarray(0, 2)), 'P5');
  const back = decodePgm(pgm);
  assert.deepEqual([back.width, back.height], [64, 8]);
  assert.deepEqual(back.luma, luma);
  assert.deepEqual(decodePgm(new Uint8Array(gunzipSync(gzipSync(pgm)))).luma, luma);
  assert.throws(() => decodePgm(new TextEncoder().encode('P6\n1 1\n255\n\0\0\0')), /not a binary PGM/);
});
await test('R6 comparison rules: thresholds 6 inside labels / 10 elsewhere; flip and decode failures are caught', () => {
  const c = PARITY_CASES[1]; // oblique: asymmetric, so a flip is visible
  const b = buildParityCase(c);
  const cpu = render(b);
  const rects = labelRects(b);
  const { width, height } = b.camera;
  const shifted = (inside, outside) => {
    const out = new Uint8Array(cpu);
    const mark = new Uint8Array(width * height);
    for (const r of rects) for (let y = r.y0; y <= r.y1; y++) mark.fill(1, y * width + r.x0, y * width + r.x1 + 1);
    for (let i = 0; i < out.length; i++) {
      const d = mark[i] ? inside : outside;
      out[i] = cpu[i] >= 128 ? cpu[i] - d : cpu[i] + d; // exact |difference| of d, no clipping
    }
    return out;
  };
  const same = judgeCase(b, cpu, cpu);
  assert.equal(same.pass, true);
  assert.equal(same.meanInside, 0);
  const m = compareFrames(cpu, shifted(5, 9), width, height, rects);
  assert.ok(Math.abs(m.meanInside - 5) < 1e-9 && Math.abs(m.meanOutside - 9) < 1e-9, JSON.stringify(m));
  assert.equal(judgeCase(b, cpu, shifted(5, 9)).pixelPass, true);
  assert.equal(judgeCase(b, cpu, shifted(7, 9)).pixelPass, false, 'inside > 6 fails');
  assert.equal(judgeCase(b, cpu, shifted(5, 11)).pixelPass, false, 'outside > 10 fails');
  assert.equal(INSIDE_LABEL_TOL, 6);
  assert.equal(OUTSIDE_LABEL_TOL, 10);
  // a vertically flipped GL read-back fails and says so
  const flipped = judgeCase(b, cpu, flipVertical(cpu, width, height));
  assert.equal(flipped.pass, false);
  assert.equal(flipped.flippedWouldPass, true);
  // a blank frame decodes nothing: decode parity fails even if the pixels were close
  const blank = new Uint8Array(width * height).fill(128);
  const j = judgeCase(b, cpu, blank);
  assert.equal(j.decodeParity, false);
  assert.equal(j.pass, false);
});

await test('R6 checker CLI: a directory in the page\'s output format is read, judged and installable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-glp-'));
  // fake "GL" frames = the CPU frames (a perfect GPU): everything must pass
  const cases = [];
  for (const c of PARITY_CASES) {
    const b = buildParityCase(c);
    writeFileSync(join(dir, `${c.id}.pgm.gz`), gzipSync(encodePgm(render(b), c.width, c.height)));
    cases.push({ id: c.id, width: c.width, height: c.height, file: `${c.id}.pgm.gz` });
  }
  const manifest = { format: 'dbc-gl-parity', version: 1, gpu: 'fake', softwareRenderer: false, cases };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  let res = checkFixtureDir(dir);
  assert.equal(res.ok, true, res.problems.join('; '));
  assert.equal(res.rows.length, 6);
  // software renderer is flagged (does not count as the real GPU check)
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, softwareRenderer: true, gpu: 'SwiftShader' }));
  res = checkFixtureDir(dir);
  assert.equal(res.ok, false);
  assert.match(res.problems.join(' '), /SOFTWARE renderer/);
  // a damaged frame is reported with its case
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const c0 = PARITY_CASES[0];
  writeFileSync(join(dir, `${c0.id}.pgm.gz`), gzipSync(encodePgm(new Uint8Array(c0.width * c0.height).fill(200), c0.width, c0.height)));
  res = checkFixtureDir(dir);
  assert.equal(res.ok, false);
  assert.match(res.problems[0], new RegExp(c0.id));
  const cli = spawnSync('node', ['tools/gl-parity-check.mjs', dir], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /GL PARITY: FAIL/);
  assert.equal(checkFixtureDir(join(dir, 'nowhere')).ok, false);
});

const haveGl = existsSync(join(FIXTURE_DIR, 'manifest.json'));
if (haveGl) {
  await test('R6 GL half: the committed GL frames match the CPU renders (labels <= 6, elsewhere <= 10, same decodes)', () => {
    const res = checkFixtureDir(FIXTURE_DIR);
    assert.equal(res.ok, true, res.problems.join('\n'));
    assert.equal(res.rows.length, PARITY_CASES.length);
  });
} else if (process.argv.includes('--require-gl')) {
  console.error('FAIL: --require-gl given but tests/fixtures-sim/gl-parity/manifest.json is missing (run tools/gl-parity.html on a GPU machine; see docs/gl-parity.md)');
  process.exit(1);
} else {
  console.log('  NOTE  GL half not run yet: no tests/fixtures-sim/gl-parity/manifest.json. Steps in docs/gl-parity.md. baseline status stays cpu-baseline.');
}

console.log(`\nAll ${passed} R6 gl-parity tests passed${haveGl ? ' (incl. GL half)' : ' (CPU half only)'}.`);
