/**
 * Unit tests for GR1 Feature-Flag Module (`src/flags.js`).
 *   node tests/flags.test.js
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FLAG_DEFS,
  WORKER_FLAG_BITS,
  resolveFlags,
  flagsToWorkerMask,
  isOn,
  toWorkerMask,
  describe,
} from '../src/flags.js';
import * as flagBits from '../src/worker/flagbits.js';
import {
  buildSyntheticTestMatrix,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  createScanResult,
  resetScanResult,
} from './harness.js';
import {
  createPipelineState,
  processFrame,
  extractPayloadString,
} from '../src/worker/scanner.worker.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running GR1 feature-flag unit tests...');

test('All declared flags default to false and worker mask defaults to 0', () => {
  assert.ok(FLAG_DEFS.length >= 38, `expected >= 38 flags, got ${FLAG_DEFS.length}`);
  const resolved = resolveFlags({});
  for (const def of FLAG_DEFS) {
    assert.equal(def.default, false, `flag ${def.name} must default to false`);
    assert.equal(resolved[def.name], false);
    assert.equal(isOn(def.name), false);
  }
  assert.equal(flagsToWorkerMask(resolved), 0);
  assert.equal(toWorkerMask(), 0);
});

test('URL ?flags= overrides localStorage and maps worker flags to exact bitmask', () => {
  const stored = { overlayDim: true, vertFallback: true, cribMatch: true };
  const resolved = resolveFlags({
    stored,
    search: '?flags=tallGuide,-cribMatch,verticalMode',
  });
  assert.equal(resolved.overlayDim, true);
  assert.equal(resolved.tallGuide, true);
  assert.equal(resolved.vertFallback, true);
  assert.equal(resolved.verticalMode, true);
  assert.equal(resolved.cribMatch, false);

  const expectedMask = WORKER_FLAG_BITS.vertFallback | WORKER_FLAG_BITS.verticalMode;
  assert.equal(flagsToWorkerMask(resolved), expectedMask);
});

test('?flags=none overrides stored flags, ?flags=all excludes exclusive requirePrefixStrict, ?flags=allStrict enables all, ?tape=1 enables tapeRecord', () => {
  const none = resolveFlags({ stored: { vertFallback: true, camAlign: true }, search: '?flags=none' });
  assert.equal(none.vertFallback, false);
  assert.equal(none.camAlign, false);
  assert.equal(flagsToWorkerMask(none), 0);

  const all = resolveFlags({ search: '?flags=all' });
  for (const def of FLAG_DEFS) {
    assert.equal(all[def.name], !def.exclusive, `flag ${def.name} expected ${!def.exclusive} under ?flags=all`);
  }
  assert.equal(all.requirePrefixStrict, false);
  assert.ok(flagsToWorkerMask(all) > 0);
  assert.equal((flagsToWorkerMask(all) & WORKER_FLAG_BITS.requirePrefixStrict), 0);

  const allStrict = resolveFlags({ search: '?flags=allStrict' });
  for (const def of FLAG_DEFS) assert.equal(allStrict[def.name], true);
  assert.equal(allStrict.requirePrefixStrict, true);

  const allPlusExplicit = resolveFlags({ search: '?flags=all,requirePrefixStrict' });
  assert.equal(allPlusExplicit.requirePrefixStrict, true);

  const tape = resolveFlags({ search: '?tape=1' });
  assert.equal(tape.tapeRecord, true);
  assert.equal(tape.vertFallback, false);
});

test('H1 ?flags=all decodes 14/14 positive harness fixtures with 0 false positives', () => {
  const allFlags = resolveFlags({ search: '?flags=all' });
  const mask = flagsToWorkerMask(allFlags);
  const fixtures = buildSyntheticTestMatrix();
  const pipeState = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  pipeState.flags = mask;
  const result = createScanResult();

  let posTotal = 0;
  let posDecoded = 0;
  let negTotal = 0;
  let falsePositives = 0;

  for (const fx of fixtures) {
    resetScanResult(result);
    const detected = processFrame(fx.luma, fx.width, fx.height, pipeState, result, false);
    const decoded = detected === 1 ? extractPayloadString(result) : null;
    if (fx.symbology === 'CODE_128') {
      posTotal++;
      if (detected === 1 && decoded === fx.payload) posDecoded++;
    } else {
      negTotal++;
      if (detected === 1) falsePositives++;
    }
  }
  assert.equal(posTotal, 14);
  assert.equal(posDecoded, 14, `expected 14/14 decoded under ?flags=all, got ${posDecoded}/${posTotal}`);
  assert.equal(negTotal, 2);
  assert.equal(falsePositives, 0);
});

test('Unknown flag names in URL/storage are ignored safely and describe() returns full metadata', () => {
  const r = resolveFlags({ stored: { fakeFlag: true }, search: '?flags=notReal,blurGateV2' });
  assert.equal(r.fakeFlag, undefined);
  assert.equal(r.notReal, undefined);
  assert.equal(r.blurGateV2, true);
  const desc = describe();
  assert.equal(desc.length, FLAG_DEFS.length);
  assert.ok(desc.every((d) => typeof d.name === 'string' && typeof d.item === 'string' && typeof d.desc === 'string'));
});

test('H3 WORKER_FLAG_BITS matches golden bit positions and has no duplicate declarations outside flagbits.js', () => {
  const GOLDEN_BITS = {
    vertFallback:        1 << 0,
    extraLines:          1 << 1,
    cribMatch:           1 << 2,
    requirePrefix:       1 << 3,
    requirePrefixStrict: 1 << 4,
    prefixStack:         1 << 5,
    illumNorm:           1 << 6,
    subpixEdges:         1 << 7,
    scanSmooth:          1 << 8,
    roiSmallCodes:       1 << 9,
    verticalMode:        1 << 10,
    deblur1d:            1 << 11,
    flowOn:              1 << 12,
  };
  assert.deepEqual(WORKER_FLAG_BITS, GOLDEN_BITS);
  assert.deepEqual(flagBits.WORKER_FLAG_BITS, GOLDEN_BITS);

  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  function collectJsFiles(dir, out = []) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) collectJsFiles(full, out);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
    }
    return out;
  }
  const files = collectJsFiles(srcRoot);
  const canonicalPath = join(srcRoot, 'worker', 'flagbits.js');
  for (const file of files) {
    if (file === canonicalPath) continue;
    const text = readFileSync(file, 'utf8');
    assert.equal(/FLAG_[A-Z0-9_]+\s*=\s*1\s*<</.test(text), false, `duplicate FLAG_* literal in ${file}`);
    assert.equal(/WORKER_FLAG_BITS\s*=\s*Object\.freeze/.test(text), false, `duplicate WORKER_FLAG_BITS in ${file}`);
  }
});

console.log(`All ${passed} GR1 feature-flag tests passed.`);
