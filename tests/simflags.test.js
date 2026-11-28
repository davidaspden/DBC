/**
 * Unit tests for R1 Sim & AR Feature-Flag Registry (`src/sim/simflags.js`).
 *   node tests/simflags.test.js
 */

import assert from 'node:assert/strict';
import {
  SIM_FLAG_DEFS,
  resolveSimFlags,
  isSimOn,
  setSimFlag,
  refreshSimFlags,
  describeSimFlags,
} from '../src/sim/simflags.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running R1 sim/AR feature-flag unit tests...');

test('All declared sim and AR flags default to false', () => {
  assert.ok(SIM_FLAG_DEFS.length >= 16, `expected >= 16 sim flags, got ${SIM_FLAG_DEFS.length}`);
  const resolved = resolveSimFlags({});
  for (const def of SIM_FLAG_DEFS) {
    assert.equal(def.default, false, `sim flag ${def.name} must default to false`);
    assert.equal(resolved[def.name], false);
    assert.equal(isSimOn(def.name), false);
  }
});

test('URL ?sim= overrides localStorage and supports -flag exclusions', () => {
  const stored = { simCamera: true, simGlare: true, arWall: true };
  const resolved = resolveSimFlags({
    stored,
    search: '?sim=simLips,-simGlare,arCompose',
  });
  assert.equal(resolved.simCamera, true);
  assert.equal(resolved.simLips, true);
  assert.equal(resolved.simGlare, false);
  assert.equal(resolved.arWall, true);
  assert.equal(resolved.arCompose, true);
});

test('?sim=none disables all stored flags and ?sim=all enables every sim/AR flag', () => {
  const none = resolveSimFlags({
    stored: { simCamera: true, arWall: true },
    search: '?sim=none',
  });
  for (const def of SIM_FLAG_DEFS) assert.equal(none[def.name], false);

  const all = resolveSimFlags({ search: '?sim=all' });
  for (const def of SIM_FLAG_DEFS) assert.equal(all[def.name], true);
});

test('Unknown sim flags are ignored safely, setSimFlag works in-memory, and describeSimFlags has metadata', () => {
  const r = resolveSimFlags({ stored: { fakeSimFlag: true }, search: '?sim=notReal,arShowDots' });
  assert.equal(r.fakeSimFlag, undefined);
  assert.equal(r.notReal, undefined);
  assert.equal(r.arShowDots, true);

  assert.equal(setSimFlag('nonExistent', true, false), false);
  assert.equal(setSimFlag('simCamera', true, false), true);
  assert.equal(isSimOn('simCamera'), true);
  refreshSimFlags();
  assert.equal(isSimOn('simCamera'), false);

  const desc = describeSimFlags();
  assert.equal(desc.length, SIM_FLAG_DEFS.length);
  assert.ok(desc.every((d) => typeof d.name === 'string' && typeof d.item === 'string' && typeof d.desc === 'string' && d.default === false));
});

console.log(`All ${passed} R1 simflags tests passed.`);
