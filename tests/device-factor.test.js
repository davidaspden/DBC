/**
 * F2 — Dynamic Machine-Measured A53 Device Factor Tests (`tests/device-factor.test.js`).
 *   node tests/device-factor.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PHONE_MS_A53,
  EXPECTED_PAYLOAD,
  measureDeviceFactor,
  getDeviceFactorMeasurement,
  getDeviceFactorA53,
  clearDeviceFactorCache,
  getMachineInfo,
} from '../tools/gate/device-factor.mjs';
import { parseCliArgs } from '../tools/simgate.mjs';
import { buildReport } from '../tools/gate/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running F2 dynamic device-factor tests...');

test('measureDeviceFactor({ iterations: 5 }) decodes tsX07wz7py1 and computes 38 / nodeP50Ms', () => {
  const m = measureDeviceFactor({ iterations: 5, warmup: 2 });

  assert.equal(m.phoneMs, 38);
  assert.equal(PHONE_MS_A53, 38);
  assert.equal(m.payload, EXPECTED_PAYLOAD);
  assert.equal(m.payload, 'tsX07wz7py1');
  assert.equal(m.width, 1080);
  assert.equal(m.height, 2400);
  assert.equal(m.iterations, 5);
  assert.ok(Number.isFinite(m.nodeP50Ms) && m.nodeP50Ms > 0, `expected positive nodeP50Ms, got ${m.nodeP50Ms}`);
  assert.ok(Number.isFinite(m.nodeP95Ms) && m.nodeP95Ms >= m.nodeP50Ms, `expected nodeP95Ms >= nodeP50Ms`);
  assert.ok(Number.isFinite(m.deviceFactorA53) && m.deviceFactorA53 > 0, `expected positive deviceFactorA53`);
  assert.equal(m.deviceFactorA53, 38 / m.nodeP50Ms, 'deviceFactorA53 must equal 38 / nodeP50Ms');

  assert.ok(m.machine && typeof m.machine === 'object', 'machine metadata must be present');
  assert.ok(typeof m.machine.hostname === 'string' && m.machine.hostname.length > 0);
  assert.ok(typeof m.machine.platform === 'string' && m.machine.platform.length > 0);
  assert.ok(typeof m.machine.arch === 'string' && m.machine.arch.length > 0);
  assert.ok(typeof m.machine.cpuModel === 'string' && m.machine.cpuModel.length > 0);
  assert.ok(Number.isInteger(m.machine.cpuCount) && m.machine.cpuCount > 0);
  assert.ok(typeof m.machine.nodeVersion === 'string' && m.machine.nodeVersion.startsWith('v'));
});

test('getDeviceFactorMeasurement caches in-process and getDeviceFactorA53 matches cached value', () => {
  clearDeviceFactorCache();
  const first = getDeviceFactorMeasurement({ iterations: 3, warmup: 1 });
  const second = getDeviceFactorMeasurement({ iterations: 30, warmup: 5 });
  assert.strictEqual(first, second, 'subsequent call must return cached measurement without re-measuring');
  assert.equal(getDeviceFactorA53(), first.deviceFactorA53);
  clearDeviceFactorCache();
});

test('simgate CLI parser supports --device-factor override', () => {
  const a = parseCliArgs(['--quick', '--device-factor', '6.25']);
  assert.equal(a.quick, true);
  assert.equal(a.deviceFactor, 6.25);

  const b = parseCliArgs(['--device-factor=7.5']);
  assert.equal(b.deviceFactor, 7.5);
});

test('buildReport includes deviceFactorA53 and deviceFactorMeta without static fallback', () => {
  const metaObj = {
    phoneMs: 38,
    nodeP50Ms: 6.0,
    iterations: 30,
    machine: getMachineInfo(),
  };
  const rep = buildReport([], {
    commit: 'abc1234',
    machine: 'test-box',
    deviceFactorA53: 38 / 6.0,
    deviceFactorMeta: metaObj,
  });
  assert.equal(rep.deviceFactorA53, 38 / 6.0);
  assert.deepEqual(rep.deviceFactorMeta, metaObj);
});

test('static source scan confirms no hard-coded 5.8 or 8.43 device-factor constants remain', () => {
  const files = [
    'tools/simgate.mjs',
    'tools/gate/score.mjs',
    'tools/gate/report.mjs',
  ];
  const forbiddenPatterns = [
    /\b5\.8\b/,
    /\b8\.43\b/,
    /PROVISIONAL_DEVICE_FACTOR_A53/,
  ];

  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const rx of forbiddenPatterns) {
      assert.equal(
        rx.test(src),
        false,
        `Found forbidden hard-coded device-factor pattern ${rx} in ${rel}`
      );
    }
  }
});

console.log(`All ${passed} F2 device-factor tests passed.`);
