/**
 * Unit tests for M0 AR Wall Marker Layout (`src/ar/layout.js`).
 *   node tests/ar-layout.test.js
 */

import assert from 'node:assert/strict';
import {
  AR_LAYOUT_STORAGE_KEY,
  createArLayout,
  serializeArLayout,
  deserializeArLayout,
  saveArLayoutToStorage,
  loadArLayoutFromStorage,
} from '../src/ar/layout.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running M0 AR wall marker layout unit tests...');

test('4x4 pitch 16x14 Tier A gives 25 corner dots, 16 label-offset dots, 1 origin, 1 axis', () => {
  const layout = createArLayout({ cols: 4, rows: 4, pitchX: 16, pitchY: 14, tier: 'A' });

  assert.equal(layout.wallWidthIn, 64);
  assert.equal(layout.wallHeightIn, 56);
  assert.equal(layout.config.polarity, 'dark-on-light');
  assert.equal(layout.config.dotDiameterIn, 1.0);
  assert.equal(layout.config.provenance, 'unconfirmed');

  assert.equal(layout.counts.corners, 25);
  assert.equal(layout.counts.labelOffsets, 16);
  assert.equal(layout.counts.gridDots, 0);
  assert.equal(layout.counts.total, 41);
  assert.equal(layout.counts.origins, 1);
  assert.equal(layout.counts.axes, 1);
  assert.equal(layout.warnings.length, 0);

  const origin = layout.dots.find((d) => d.landmark === 'origin');
  assert.ok(origin);
  assert.equal(origin.id, 'corner-r0-c0');
  assert.equal(origin.x, 0);
  assert.equal(origin.y, 0);
  assert.equal(origin.diameterScale, 2.0);
  assert.equal(origin.diameterIn, 2.0);

  const axis = layout.dots.find((d) => d.landmark === 'axis');
  assert.ok(axis);
  assert.equal(axis.id, 'corner-r0-c4');
  assert.equal(axis.x, 64);
  assert.equal(axis.y, 0);
  assert.equal(axis.diameterScale, 1.5);
  assert.equal(axis.diameterIn, 1.5);

  // Label-offset dot (0, 0): centre is (8, 7), offset -2.5 in left -> (5.5, 7)
  const lbl00 = layout.dots.find((d) => d.id === 'label-r0-c0');
  assert.ok(lbl00);
  assert.equal(lbl00.role, 'label-offset');
  assert.equal(lbl00.x, 5.5);
  assert.equal(lbl00.y, 7.0);
  assert.equal(lbl00.diameterIn, 1.0);

  // Label-offset dot (3, 3): centre is (56, 49), offset -2.5 in left -> (53.5, 49)
  const lbl33 = layout.dots.find((d) => d.id === 'label-r3-c3');
  assert.ok(lbl33);
  assert.equal(lbl33.x, 53.5);
  assert.equal(lbl33.y, 49.0);
});

test('Tier B 4x4 pitch 16x14 generates fine lattice (default s = pitch/4) with x1.25 tote-corner landmarks', () => {
  const layout = createArLayout({ cols: 4, rows: 4, pitchX: 16, pitchY: 14, tier: 'B' });

  assert.equal(layout.config.spacingXIn, 4);
  assert.equal(layout.config.spacingYIn, 3.5);
  assert.equal(layout.counts.corners, 25);
  assert.equal(layout.counts.labelOffsets, 0);
  assert.equal(layout.counts.origins, 1);
  assert.equal(layout.counts.axes, 1);
  // Remaining 23 tote corners carry x1.25 landmark scale
  assert.equal(layout.counts.cornerLandmarks, 23);

  // Horizontal lines: 5 lines * 3 intermediate dots per tote * 4 totes = 60
  // Vertical lines: 5 lines * 3 intermediate dots per tote * 4 totes = 60
  assert.equal(layout.counts.gridDots, 120);
  assert.equal(layout.counts.total, 145);

  // Verify no duplicate (x, y) coordinates exist
  const seen = new Set();
  for (const d of layout.dots) {
    const key = `${d.x.toFixed(4)},${d.y.toFixed(4)}`;
    assert.equal(seen.has(key), false, `duplicate dot at ${key}`);
    seen.add(key);
  }

  const cornerMid = layout.dots.find((d) => d.id === 'corner-r2-c2');
  assert.equal(cornerMid.landmark, 'corner');
  assert.equal(cornerMid.diameterScale, 1.25);
  assert.equal(cornerMid.diameterIn, 1.25);

  const gridDot = layout.dots.find((d) => d.role === 'grid-h');
  assert.equal(gridDot.diameterScale, 1.0);
  assert.equal(gridDot.diameterIn, 1.0);
});

test('Tier B supports custom scalar spacing s and smaller walls (2x2, swapped pitch, light-on-dark)', () => {
  const layout = createArLayout({
    cols: 2,
    rows: 2,
    pitchX: 14,
    pitchY: 16,
    tier: 'B',
    spacingIn: 3.5,
    dotDiameterIn: 0.8,
    polarity: 'light-on-dark',
  });

  assert.equal(layout.wallWidthIn, 28);
  assert.equal(layout.wallHeightIn, 32);
  assert.equal(layout.config.polarity, 'light-on-dark');
  assert.equal(layout.counts.corners, 9);
  assert.equal(layout.counts.origins, 1);
  assert.equal(layout.counts.axes, 1);
  assert.equal(layout.counts.cornerLandmarks, 7);
  assert.equal(layout.warnings.length, 0);

  const origin = layout.dots.find((d) => d.landmark === 'origin');
  assert.equal(origin.diameterIn, 1.6);
  const axis = layout.dots.find((d) => d.landmark === 'axis');
  assert.equal(axis.x, 28);
  assert.equal(axis.diameterIn, 1.2);
});

test('Measured xs/ys overrides replace nominal positions and shift Tier A label-offset dots', () => {
  const layout = createArLayout({
    cols: 2,
    rows: 2,
    pitchX: 16,
    pitchY: 14,
    tier: 'A',
    measured: {
      xs: [0.1, 16.2, 32.3],
      ys: [0.0, 14.3, 28.2],
    },
  });

  assert.equal(layout.warnings.length, 0);
  const c11 = layout.dots.find((d) => d.id === 'corner-r1-c1');
  assert.equal(c11.x, 16.2);
  assert.equal(c11.y, 14.3);
  assert.equal(c11.nominalX, 16);
  assert.equal(c11.nominalY, 14);
  assert.equal(c11.overridden, true);

  // Cell (0,0) measured centre = ((0.1 + 16.2)/2, (0 + 14.3)/2) = (8.15, 7.15)
  // Label offset dot = (8.15 - 2.5, 7.15) = (5.65, 7.15)
  const l00 = layout.dots.find((d) => d.id === 'label-r0-c0');
  assert.equal(l00.x, 5.65);
  assert.equal(l00.y, 7.15);
});

test('Per-dot overrides replace nominal and tolerance warnings fire when delta > 0.5 in', () => {
  const layout = createArLayout({
    cols: 2,
    rows: 2,
    pitchX: 16,
    pitchY: 14,
    tier: 'A',
    measured: {
      xs: [0, 16.45, 32.75], // 32.75 differs by +0.75 in (> 0.5 in) -> warning; 16.45 (+0.45) -> OK
      ys: [0, 13.4, 28.0],   // 13.4 differs by -0.60 in (> 0.5 in) -> warning
      dots: [
        { id: 'label-r0-c0', x: 6.2, y: 7.0 }, // nominal x is 5.5 -> +0.7 in (> 0.5 in) -> warning
        { id: 'nonexistent-dot', x: 1, y: 1 }, // unknown id -> warning
      ],
    },
  });

  const lbl00 = layout.dots.find((d) => d.id === 'label-r0-c0');
  assert.equal(lbl00.x, 6.2);
  assert.equal(lbl00.y, 7.0);

  const kinds = layout.warnings.map((w) => w.kind);
  assert.ok(kinds.includes('measured-x'), 'expected measured-x warning');
  assert.ok(kinds.includes('measured-y'), 'expected measured-y warning');
  assert.ok(kinds.includes('measured-dot'), 'expected measured-dot warning');
  assert.ok(kinds.includes('measured-dot-unknown'), 'expected unknown-dot warning');
  assert.equal(layout.warnings.length, 4);
});

test('Tier B interpolates intermediate grid dots when measured tote-line xs/ys are supplied', () => {
  const layout = createArLayout({
    cols: 2,
    rows: 1,
    pitchX: 16,
    pitchY: 14,
    tier: 'B',
    measured: {
      xs: [0, 16.4, 32.4], // tote col 1 shifted +0.4 in (within 0.5 in tolerance)
      ys: [0, 14.0],
    },
  });

  assert.equal(layout.warnings.length, 0);
  // Halfway between tote col 0 (0) and tote col 1 (16.4) is nominal 8 -> measured 8.2
  const midDot = layout.dots.find((d) => d.role === 'grid-h' && d.toteRow === 0 && d.nominalX === 8);
  assert.ok(midDot);
  assert.equal(midDot.x, 8.2);
});

test('Dot diameter outside [0.75, 1.5] triggers a warning', () => {
  const small = createArLayout({ dotDiameterIn: 0.5 });
  assert.ok(small.warnings.some((w) => w.kind === 'dot-diameter'));
  const large = createArLayout({ dotDiameterIn: 1.75 });
  assert.ok(large.warnings.some((w) => w.kind === 'dot-diameter'));
});

test('Layout JSON serialisation and localStorage round-trip preserve exact state', () => {
  const orig = createArLayout({
    cols: 4,
    rows: 4,
    pitchX: 16,
    pitchY: 14,
    tier: 'A',
    polarity: 'dark-on-light',
    measured: {
      xs: [0, 16.1, 32.0, 48.2, 64.1],
      ys: [0, 14.0, 28.1, 42.0, 56.2],
      dots: [{ id: 'label-r2-c1', x: 21.75, y: 35.1 }],
    },
  });

  const serialized = serializeArLayout(orig);
  const jsonStr = JSON.stringify(serialized);
  const restored = deserializeArLayout(jsonStr);

  assert.equal(restored.layoutId, orig.layoutId);
  assert.deepEqual(restored.dots, orig.dots);
  assert.deepEqual(restored.counts, orig.counts);

  // Mock Storage for Node test
  const mem = new Map();
  const mockStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  assert.equal(saveArLayoutToStorage(orig, mockStorage), true);
  assert.ok(mem.has(AR_LAYOUT_STORAGE_KEY));
  const loaded = loadArLayoutFromStorage(mockStorage);
  assert.ok(loaded);
  assert.equal(loaded.layoutId, orig.layoutId);
  assert.deepEqual(loaded.dots, orig.dots);
});

console.log(`All ${passed} M0 AR wall layout tests passed.`);
