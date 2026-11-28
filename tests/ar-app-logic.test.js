/**
 * Unit tests for M7a AR Wall Capture Page Logic & Raw Tape Recorder Wrapper
 * (`src/ar/app-logic.js` + `src/ar/tape.js` + `ar.html` static invariants).
 *   node tests/ar-app-logic.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AR_DISABLED_MESSAGE,
  evaluateArPageAccess,
  parseNumberList,
  parseDotOverridesJson,
  buildLayoutFromEditorInput,
  createFpsMeter,
  computeCentreBandCrop,
  estimateRecordingBudget,
  computePreviewWallTransform,
} from '../src/ar/app-logic.js';
import { createArLayout } from '../src/ar/layout.js';
import { createArTapeRecorder, extractCameraMeta } from '../src/ar/tape.js';
import { parseTapeBytes, replayTape } from '../tools/replay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running M7a AR capture logic & raw tape wrapper unit tests...');

await test('arWall sim flag gate defaults OFF with exact disabled message and enables via ?sim=arWall', () => {
  const off = evaluateArPageAccess({ search: '', stored: null });
  assert.equal(off.enabled, false);
  assert.equal(off.message, AR_DISABLED_MESSAGE);
  assert.equal(off.message, 'AR wall mode is disabled');

  const onUrl = evaluateArPageAccess({ search: '?sim=arWall', stored: null });
  assert.equal(onUrl.enabled, true);
  assert.equal(onUrl.flags.arWall, true);

  const onStored = evaluateArPageAccess({ search: '', stored: { arWall: true } });
  assert.equal(onStored.enabled, true);

  const forcedOff = evaluateArPageAccess({ search: '?sim=-arWall', stored: { arWall: true } });
  assert.equal(forcedOff.enabled, false);
  assert.equal(forcedOff.message, 'AR wall mode is disabled');
});

await test('Measured coordinate list and per-dot override JSON parsers validate cleanly', () => {
  assert.deepEqual(parseNumberList(''), { values: null, invalidTokens: [] });
  assert.deepEqual(parseNumberList('0, 16.05, 32.1  48.0'), {
    values: [0, 16.05, 32.1, 48],
    invalidTokens: [],
  });
  const bad = parseNumberList('0, abc, 32');
  assert.deepEqual(bad.values, [0, 32]);
  assert.deepEqual(bad.invalidTokens, ['abc']);

  assert.deepEqual(parseDotOverridesJson(''), { dots: [], error: null });
  const okDots = parseDotOverridesJson('[{"id":"label-r0-c0","x":5.7,"y":7.1}]');
  assert.equal(okDots.error, null);
  assert.deepEqual(okDots.dots, [{ id: 'label-r0-c0', x: 5.7, y: 7.1 }]);

  const badDots = parseDotOverridesJson('{"id":"not-an-array"}');
  assert.ok(badDots.error);
});

await test('buildLayoutFromEditorInput builds validated M0 layout and surfaces tolerance warnings', () => {
  const res = buildLayoutFromEditorInput({
    tier: 'A',
    cols: '2',
    rows: '2',
    pitchX: '16',
    pitchY: '14',
    dotDiameterIn: '1.0',
    polarity: 'dark-on-light',
    measuredXsText: '0, 16.2, 32.8', // +0.8 in > 0.5 in -> warning
    measuredYsText: '0, 14.0, 28.1',
    dotOverridesText: '[{"id":"label-r0-c0","x":5.6}]',
  });
  assert.equal(res.ok, true);
  assert.equal(res.parseErrors.length, 0);
  assert.equal(res.layout.counts.corners, 9);
  assert.equal(res.layout.counts.labelOffsets, 4);
  assert.ok(res.layout.warnings.some((w) => w.kind === 'measured-x'));

  const bad = buildLayoutFromEditorInput({ cols: '0', pitchX: '-5' });
  assert.equal(bad.ok, false);
  assert.ok(bad.parseErrors.length >= 2);
});

await test('Sliding-window FPS meter, even centre crop, size estimator and preview transform work', () => {
  const meter = createFpsMeter(1000);
  assert.equal(meter.getFps(), 0);
  for (let i = 0; i <= 30; i++) {
    meter.push(i * (1000 / 30));
  }
  const fps = meter.getFps();
  assert.ok(Math.abs(fps - 30) < 0.2, `expected ~30 fps, got ${fps}`);

  const crop = computeCentreBandCrop(1920, 1080, 0.6);
  assert.equal(crop.x % 2, 0);
  assert.equal(crop.y % 2, 0);
  assert.equal(crop.width % 2, 0);
  assert.equal(crop.height % 2, 0);
  assert.ok(crop.x >= 0 && crop.x + crop.width <= 1920);
  assert.ok(crop.y >= 0 && crop.y + crop.height <= 1080);

  const est1080 = estimateRecordingBudget({ width: 1920, height: 1080, fps: 30, durationSec: 60 });
  assert.equal(est1080.frames, 1800);
  assert.equal(est1080.recommendDownscale, true);

  const est720 = estimateRecordingBudget({ width: 1280, height: 720, fps: 30, durationSec: 60 });
  assert.ok(est720.estHighMb < est1080.estHighMb);

  const tf = computePreviewWallTransform(64, 56, 280, 240, 20);
  assert.ok(tf.scale > 0);
  assert.ok(tf.drawW <= 240.01 && tf.drawH <= 200.01);
});

await test('extractCameraMeta safely reads Image Capture settings and tolerates missing keys', () => {
  const fakeTrack = {
    getSettings: () => ({
      exposureTime: 40,
      iso: 400,
      width: 1080,
      height: 1920,
      zoom: 1.5,
      focusDistance: 0.3,
    }),
  };
  const m = extractCameraMeta(fakeTrack, { fps: 29.84 });
  assert.deepEqual(m, {
    exposureTime: 40,
    iso: 400,
    fps: 29.84,
    width: 1080,
    height: 1920,
    zoom: 1.5,
    focusDistance: 0.3,
  });

  const empty = extractCameraMeta(null, { width: 1280, height: 720, fps: 10.1 });
  assert.equal(empty.exposureTime, null);
  assert.equal(empty.iso, null);
  assert.equal(empty.zoom, null);
  assert.equal(empty.focusDistance, null);
  assert.equal(empty.fps, 10.1);
  assert.equal(empty.width, 1280);
  assert.equal(empty.height, 720);
});

await test('createArTapeRecorder wraps record.js, preserves meta.camera/ar, builds sidecar, and replays in tools/replay.mjs', async () => {
  const layout = createArLayout({
    cols: 4,
    rows: 4,
    pitchX: 16,
    pitchY: 14,
    tier: 'A',
    measured: { xs: [0, 16.1, 32.0, 48.1, 64.0] },
  });

  const rec = createArTapeRecorder({
    layout,
    device: 'Galaxy-A53-Test',
    lighting: 'normal',
    notes: 'raw wall test',
    everyNth: 1,
    compress: true,
  });

  const w = 160;
  const h = 120;
  const luma = new Uint8Array(w * h);
  luma.fill(210);
  // Draw a synthetic black dot in the middle (round blob must never decode as Code 128)
  for (let y = 50; y < 70; y++) {
    for (let x = 70; x < 90; x++) {
      const dx = x - 80;
      const dy = y - 60;
      if (dx * dx + dy * dy <= 81) luma[y * w + x] = 20;
    }
  }

  rec.start(1000);
  for (let i = 0; i < 3; i++) {
    const ok = await rec.pushFrame({
      frameId: i + 1,
      tFrameMs: i * 33.33,
      width: w,
      height: h,
      luma,
      camera: {
        exposureTime: 40,
        iso: 250,
        fps: 30.0,
        width: w,
        height: h,
        zoom: 1.0,
        focusDistance: 0.35,
      },
      sensorSample: {
        q: [0, 0, 0, 1],
        wPanDps: 1.5 * i,
        wPitchDps: -0.5,
        source: 'RelativeOrientationSensor',
        accel: { x: 0, y: 9.81, z: 0 },
      },
    });
    assert.equal(ok, true);
  }
  rec.stop(1100);

  const bytes = rec.exportBytes();
  const parsed = parseTapeBytes(bytes);

  assert.equal(parsed.header.version, 1);
  assert.equal(parsed.header.meta.mode, 'ar-raw');
  assert.equal(parsed.header.meta.layoutId, layout.layoutId);
  assert.equal(parsed.header.meta.composited, false);
  assert.equal(parsed.frames.length, 3);

  const f1 = parsed.frames[1];
  assert.deepEqual(f1.meta.expectedPayloads, []);
  assert.equal(f1.meta.camera.exposureTime, 40);
  assert.equal(f1.meta.camera.iso, 250);
  assert.equal(f1.meta.camera.fps, 30);
  assert.equal(f1.meta.camera.width, w);
  assert.equal(f1.meta.camera.height, h);
  assert.equal(f1.meta.camera.zoom, 1);
  assert.equal(f1.meta.camera.focusDistance, 0.35);
  assert.equal(f1.meta.ar.layoutId, layout.layoutId);
  assert.equal(f1.meta.ar.composited, false);
  assert.equal(f1.meta.sensorSample.wPanDps, 1.5);
  assert.equal(f1.luma.byteLength, w * h);
  assert.equal(f1.luma[60 * w + 80], 20);

  // Confirm compatibility with tools/replay.mjs
  const rep = replayTape(parsed, 0);
  assert.equal(rep.pass, true);
  assert.equal(rep.goldenTotal, 0);

  // Sidecar JSON carries complete layout & measured overrides
  const sidecar = rec.buildSidecar({ tapeFilename: 'session-1.dbct' });
  assert.equal(sidecar.kind, 'dbc-ar-tape-sidecar');
  assert.equal(sidecar.tapeFilename, 'session-1.dbct');
  assert.equal(sidecar.layout.layoutId, layout.layoutId);
  assert.equal(sidecar.layout.dots.length, 41);
  assert.deepEqual(sidecar.layout.measured.xs, [0, 16.1, 32.0, 48.1, 64.0]);
});

await test('ar.html contains disabled gate text, minimal module script, and no inline getUserMedia', () => {
  const html = readFileSync(join(ROOT, 'ar.html'), 'utf8');
  assert.ok(html.includes('AR wall mode is disabled'), 'missing disabled gate message');
  const scriptMatches = [...html.matchAll(/<script\b[^>]*type="module"[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scriptMatches.length, 1, 'expected exactly one minimal inline module script');
  const inlineBody = scriptMatches[0][1].trim();
  assert.ok(inlineBody.split('\n').length <= 6, 'inline script in ar.html should stay minimal');
  assert.ok(inlineBody.includes('./src/ar/app.js'), 'inline script must boot ./src/ar/app.js');
  assert.equal(html.includes('getUserMedia'), false, 'camera logic must live in src/camera.js / src/ar/app.js');
});

console.log(`All ${passed} M7a AR capture logic & raw tape tests passed.`);
