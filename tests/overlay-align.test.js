/**
 * Unit tests for unified `mapFrameToScreen(x, y)` overlay alignment (`overlayAlign` flag).
 * Covers uploaded portrait tote images (`1080x2400`), live portrait/landscape camera streams
 * under both `object-fit: cover` and `object-fit: contain`, DPR canvas sizing, and live frame
 * dimension detection (`readRealFrameSize`).
 */
import assert from 'node:assert/strict';
import {
  createFrameToScreenMapper,
  mapFrameToScreen,
  readRealFrameSize,
  syncOverlayCanvasSize,
} from '../src/ui/frame-map.js';
import { resolveFlags } from '../src/flags.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

test('overlayAlign feature flag exists and defaults to false', () => {
  const def = resolveFlags({ search: '', stored: null });
  assert.equal(def.overlayAlign, false);
  const on = resolveFlags({ search: '?flags=overlayAlign', stored: null });
  assert.equal(on.overlayAlign, true);
});

test('Uploaded portrait tote image (1080x2400, contain) preserves exact aspect & box coordinates in portrait and landscape', () => {
  // Barcode at x=420..660 (w=240), y=900..1500 (h=600) in 1080x2400 uploaded photo
  const frameW = 1080;
  const frameH = 2400;
  const box = { x: 420, y: 900, w: 240, h: 600 };

  // Portrait viewport 412x915 (Galaxy A53 CSS px)
  const mp = createFrameToScreenMapper({ frameW, frameH, cssW: 412, cssH: 915, fit: 'contain' });
  const expectedScaleP = Math.min(412 / 1080, 915 / 2400);
  assert.ok(Math.abs(mp.scale - expectedScaleP) < 1e-9);
  const rp = mp.mapRectToScreen(box.x, box.y, box.w, box.h);
  // Zero aspect stretch: screen box aspect === frame box aspect
  assert.ok(Math.abs((rp.w / rp.h) - (box.w / box.h)) < 1e-9);
  // Corner mapping matches standalone mapFrameToScreen
  const tl = mapFrameToScreen(box.x, box.y, frameW, frameH, 412, 915, 'contain');
  assert.ok(Math.abs(rp.x - tl.x) < 1e-9 && Math.abs(rp.y - tl.y) < 1e-9);
  // Round-trip inverse recovers exact frame pixel
  const inv = mp.mapScreenToFrame(rp.x + rp.w * 0.5, rp.y + rp.h * 0.5);
  assert.ok(Math.abs(inv.x - 540) < 1e-6 && Math.abs(inv.y - 1200) < 1e-6);

  // Landscape viewport 915x412 (letterboxed horizontally)
  const ml = createFrameToScreenMapper({ frameW, frameH, cssW: 915, cssH: 412, fit: 'contain' });
  const expectedScaleL = 412 / 2400;
  assert.ok(Math.abs(ml.scale - expectedScaleL) < 1e-9);
  assert.ok(ml.offsetX > 300, 'portrait image must be centered horizontally in landscape viewport');
  assert.equal(ml.offsetY, 0);
  const rl = ml.mapRectToScreen(box.x, box.y, box.w, box.h);
  assert.ok(Math.abs((rl.w / rl.h) - (box.w / box.h)) < 1e-9);
});

test('Live camera cover mode (1080x1920 portrait & 1920x1080 landscape in 4:3 stage) aligns without stretch or drift', () => {
  // Portrait camera 1080x1920 displayed with object-fit: cover in 412x309 (4:3) stage
  const mCovPort = createFrameToScreenMapper({ frameW: 1080, frameH: 1920, cssW: 412, cssH: 309, fit: 'cover' });
  const expScale = Math.max(412 / 1080, 309 / 1920); // 412 / 1080
  assert.ok(Math.abs(mCovPort.scale - expScale) < 1e-9);
  assert.equal(mCovPort.offsetX, 0);
  assert.ok(mCovPort.offsetY < 0, 'top/bottom cropped symmetrically under cover');
  // Frame center maps strictly to viewport center
  const c = mCovPort.mapFrameToScreen(540, 960);
  assert.ok(Math.abs(c.x - 206) < 1e-6 && Math.abs(c.y - 154.5) < 1e-6);
  // Square 100x100 frame box stays strictly square (zero stretching)
  const sq = mCovPort.mapRectToScreen(490, 910, 100, 100);
  assert.ok(Math.abs(sq.w - sq.h) < 1e-9);

  // Landscape 1920x1080 displayed with object-fit: cover in portrait 412x915 screen
  const mCovLand = createFrameToScreenMapper({ frameW: 1920, frameH: 1080, cssW: 412, cssH: 915, fit: 'cover' });
  assert.ok(mCovLand.offsetX < 0, 'left/right cropped symmetrically under cover');
  assert.equal(mCovLand.offsetY, 0);
  const c2 = mCovLand.mapFrameToScreen(960, 540);
  assert.ok(Math.abs(c2.x - 206) < 1e-6 && Math.abs(c2.y - 457.5) < 1e-6);
});

test('readRealFrameSize reads real portrait dimensions (1080x2400 / 1080x1920) & syncOverlayCanvasSize applies DPR', () => {
  const fromVf = readRealFrameSize(
    { videoWidth: 1920, videoHeight: 1080 },
    null,
    { visibleRect: { x: 0, y: 0, width: 1080, height: 2400 }, codedWidth: 1080, codedHeight: 2400 }
  );
  assert.deepEqual(fromVf, { width: 1080, height: 2400 });

  const fromVideo = readRealFrameSize({ videoWidth: 1080, videoHeight: 1920 }, { getSettings: () => ({ width: 1920, height: 1080 }) }, null);
  assert.deepEqual(fromVideo, { width: 1080, height: 1920 });

  const fromTrack = readRealFrameSize({ videoWidth: 0, videoHeight: 0 }, { getSettings: () => ({ width: 720, height: 1280 }) }, null);
  assert.deepEqual(fromTrack, { width: 720, height: 1280 });

  const fakeCanvas = { width: 0, height: 0, getBoundingClientRect: () => ({ width: 411.4, height: 776.6 }) };
  const sz = syncOverlayCanvasSize(fakeCanvas, fakeCanvas, 2.625);
  assert.equal(sz.ok, true);
  assert.equal(fakeCanvas.width, Math.round(411.4 * 2.625));
  assert.equal(fakeCanvas.height, Math.round(776.6 * 2.625));
});

console.log(`All ${passed} overlay alignment tests passed.`);
