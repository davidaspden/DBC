/**
 * Unit tests for GR3 Frame/Sensor Tape Recorder & Node Replay (`src/tape/record.js` + `tools/replay.mjs`).
 *   node tests/tape.test.js
 */

import assert from 'node:assert/strict';
import { createTapeRecorder } from '../src/tape/record.js';
import { parseTapeBytes, replayTape } from '../tools/replay.mjs';
import { buildSyntheticTestMatrix } from './harness.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running GR3 tape record & replay unit tests...');

await test('Tape recorder encodes gzipped .dbct v1 frames and replay reproduces exact golden decodes', async () => {
  const fixtures = buildSyntheticTestMatrix().slice(0, 3);
  const rec = createTapeRecorder({ maxFrames: 10, compress: true, meta: { device: 'synthetic-test' } });
  rec.start();

  for (let i = 0; i < fixtures.length; i++) {
    const fx = fixtures[i];
    const ok = await rec.pushFrame({
      frameId: i + 1,
      tFrameMs: i * 33.3,
      width: fx.width,
      height: fx.height,
      luma: fx.luma,
      expectedPayloads: fx.payload ? [fx.payload] : [],
      sensorSample: { panDeg: i * 5, tiltDeg: 0, wPitchDps: 0.2 },
    });
    assert.equal(ok, true);
  }
  rec.stop();

  const bytes = rec.exportBytes();
  assert.ok(bytes.byteLength < fixtures.length * 1280 * 720 * 0.5, 'gzip compression should shrink synthetic luma frames');

  const parsed = parseTapeBytes(bytes);
  assert.equal(parsed.header.version, 1);
  assert.equal(parsed.frames.length, 3);
  assert.equal(parsed.frames[1].meta.sensorSample.panDeg, 5);

  const rep = replayTape(parsed, 0);
  assert.equal(rep.pass, true);
  assert.equal(rep.goldenMatched, rep.goldenTotal);
  assert.ok(rep.goldenTotal === 3);
});

console.log(`All ${passed} GR3 tape record & replay tests passed.`);
