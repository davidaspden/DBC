/**
 * Unit tests for GR1 Feature-Flag Module (`src/flags.js`).
 *   node tests/flags.test.js
 */

import assert from 'node:assert/strict';
import {
  FLAG_DEFS,
  WORKER_FLAG_BITS,
  resolveFlags,
  flagsToWorkerMask,
  isOn,
  toWorkerMask,
  describe,
} from '../src/flags.js';

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

test('?flags=none overrides stored flags and ?flags=all enables all flags; ?tape=1 enables tapeRecord', () => {
  const none = resolveFlags({ stored: { vertFallback: true, camAlign: true }, search: '?flags=none' });
  assert.equal(none.vertFallback, false);
  assert.equal(none.camAlign, false);
  assert.equal(flagsToWorkerMask(none), 0);

  const all = resolveFlags({ search: '?flags=all' });
  for (const def of FLAG_DEFS) assert.equal(all[def.name], true);
  assert.ok(flagsToWorkerMask(all) > 0);

  const tape = resolveFlags({ search: '?tape=1' });
  assert.equal(tape.tapeRecord, true);
  assert.equal(tape.vertFallback, false);
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

console.log(`All ${passed} GR1 feature-flag tests passed.`);
