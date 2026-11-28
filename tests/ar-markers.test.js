/**
 * Unit tests for M1 Printable 1:1 AR Marker Generator (`tools/ar-markers.mjs`).
 *   node tests/ar-markers.test.js
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MM_PER_INCH,
  PAPER_SIZES_MM,
  generateMarkerArtifacts,
  parseCliArgs,
} from '../tools/ar-markers.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

/**
 * Lightweight zero-dependency SVG attribute parser for `<svg ...>` and dot `<circle ...>` tags.
 */
function parseAttrs(tagText) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tagText)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function parseTileSvg(svg) {
  const svgOpen = svg.match(/<svg\b[^>]*>/);
  assert.ok(svgOpen, 'SVG root tag missing');
  const root = parseAttrs(svgOpen[0]);

  const circles = [];
  const circleRe = /<circle\b[^>]*data-dot-id="[^"]+"[^>]*\/?>/g;
  let m;
  while ((m = circleRe.exec(svg)) !== null) {
    circles.push(parseAttrs(m[0]));
  }
  return { root, circles };
}

console.log('Running M1 printable AR marker generator unit tests...');

test('Tier B 4x4 pitch 16x14 A4 tiles are exact 1:1 mm scale and dot positions match layout to 0.01 in', () => {
  const { layout, plan, files } = generateMarkerArtifacts({
    pitchX: 16,
    pitchY: 14,
    cols: 4,
    rows: 4,
    tier: 'B',
    paper: 'A4',
    overlapMm: 10,
    marginMm: 10,
  });

  const tileFiles = files.filter((f) => f.kind === 'tile');
  assert.equal(tileFiles.length, plan.totalTiles);
  assert.ok(tileFiles.length > 4, '4x4 wall should span multiple A4 tiles');

  const dotById = new Map(layout.dots.map((d) => [d.id, d]));
  const seenCenterDots = new Map(); // id -> array of reconstructed wall { xIn, yIn, tileLabel }

  for (const tf of tileFiles) {
    const { root, circles } = parseTileSvg(tf.content);

    // Exact 1:1 physical scale: width/height in mm match viewBox exactly
    assert.equal(root.width, `${PAPER_SIZES_MM.A4.widthMm}mm`);
    assert.equal(root.height, `${PAPER_SIZES_MM.A4.heightMm}mm`);
    assert.equal(root.viewBox, `0 0 ${PAPER_SIZES_MM.A4.widthMm} ${PAPER_SIZES_MM.A4.heightMm}`);
    assert.equal(Number(root['data-overlap-mm']), 10);

    const originXmm = Number(root['data-origin-x-mm']);
    const originYmm = Number(root['data-origin-y-mm']);
    const marginMm = Number(root['data-margin-mm']);

    // Registration marks and scale bar must be present on every tile
    assert.ok(tf.content.includes('class="registration-marks"'), 'missing registration marks');
    assert.ok(tf.content.includes('50mm check'), 'missing 50mm scale verification bar');

    for (const c of circles) {
      const id = c['data-dot-id'];
      const ref = dotById.get(id);
      assert.ok(ref, `unexpected dot id ${id}`);

      const cxMm = Number(c.cx);
      const cyMm = Number(c.cy);
      const rMm = Number(c.r);

      // Reconstruct wall inches strictly from SVG page coordinates at 100% print scale
      const wallXIn = (originXmm + (cxMm - marginMm)) / MM_PER_INCH;
      const wallYIn = (originYmm + (cyMm - marginMm)) / MM_PER_INCH;
      const diaIn = (rMm * 2) / MM_PER_INCH;

      assert.ok(
        Math.abs(wallXIn - ref.x) <= 0.01,
        `dot ${id} X mismatch on ${tf.name}: svg=${wallXIn}, layout=${ref.x}`
      );
      assert.ok(
        Math.abs(wallYIn - ref.y) <= 0.01,
        `dot ${id} Y mismatch on ${tf.name}: svg=${wallYIn}, layout=${ref.y}`
      );
      assert.ok(
        Math.abs(diaIn - ref.diameterIn) <= 0.01,
        `dot ${id} diameter mismatch on ${tf.name}: svg=${diaIn}, layout=${ref.diameterIn}`
      );

      if (c['data-center-in-tile'] === 'true') {
        if (!seenCenterDots.has(id)) seenCenterDots.set(id, []);
        seenCenterDots.get(id).push({ xIn: wallXIn, yIn: wallYIn, tile: tf.name });
      }
    }
  }

  // Every single dot in the layout must have its centre printed on at least one tile
  assert.equal(seenCenterDots.size, layout.dots.length, 'not all layout dots appeared across tiles');

  // Verify any dot appearing in an overlap strip across two tiles has identical wall coordinates
  for (const [id, hits] of seenCenterDots.entries()) {
    if (hits.length >= 2) {
      for (let i = 1; i < hits.length; i++) {
        assert.ok(Math.abs(hits[i].xIn - hits[0].xIn) < 1e-4, `overlap X discontinuity on ${id}`);
        assert.ok(Math.abs(hits[i].yIn - hits[0].yIn) < 1e-4, `overlap Y discontinuity on ${id}`);
      }
    }
  }
});

test('Measured dot overrides flow to SVG coordinates and overlap-strip dots agree across adjacent tiles', () => {
  // Place a dot intentionally inside the horizontal overlap strip between tile C1 and C2
  const base = generateMarkerArtifacts({ cols: 2, rows: 1, pitchX: 16, pitchY: 14, tier: 'A', paper: 'A4' });
  const c1 = base.plan.tiles.find((t) => t.row === 0 && t.col === 0);
  const c2 = base.plan.tiles.find((t) => t.row === 0 && t.col === 1);
  assert.ok(c1 && c2, 'expected at least 2 horizontal tiles');
  const overlapMidXIn = ((c2.originXmm + c1.endXmm) * 0.5) / MM_PER_INCH;

  const { files } = generateMarkerArtifacts({
    cols: 2,
    rows: 1,
    pitchX: 16,
    pitchY: 14,
    tier: 'A',
    paper: 'A4',
    measured: {
      dots: [{ id: 'label-r0-c0', x: overlapMidXIn, y: 7.0 }],
    },
  });

  const hits = [];
  for (const tf of files.filter((f) => f.kind === 'tile')) {
    const { root, circles } = parseTileSvg(tf.content);
    const originXmm = Number(root['data-origin-x-mm']);
    const originYmm = Number(root['data-origin-y-mm']);
    const marginMm = Number(root['data-margin-mm']);
    for (const c of circles) {
      if (c['data-dot-id'] === 'label-r0-c0' && c['data-center-in-tile'] === 'true') {
        hits.push({
          tile: tf.name,
          wallXIn: (originXmm + (Number(c.cx) - marginMm)) / MM_PER_INCH,
          wallYIn: (originYmm + (Number(c.cy) - marginMm)) / MM_PER_INCH,
        });
      }
    }
  }
  assert.ok(hits.length >= 2, `expected overlap dot on >=2 tiles, got ${hits.length}`);
  for (const h of hits) {
    assert.ok(Math.abs(h.wallXIn - overlapMidXIn) < 1e-3, `override X mismatch on ${h.tile}`);
    assert.ok(Math.abs(h.wallYIn - 7.0) < 1e-3, `override Y mismatch on ${h.tile}`);
  }
});

test('Adjacent tiles are continuous with exact 10 mm overlap on both axes', () => {
  const { plan } = generateMarkerArtifacts({
    pitchX: 16,
    pitchY: 14,
    cols: 4,
    rows: 4,
    tier: 'B',
    paper: 'A4',
    overlapMm: 10,
    marginMm: 10,
  });

  const byRC = new Map(plan.tiles.map((t) => [`${t.row},${t.col}`, t]));

  for (let r = 0; r < plan.tileRows; r++) {
    for (let c = 0; c < plan.tileCols; c++) {
      const cur = byRC.get(`${r},${c}`);
      if (c + 1 < plan.tileCols) {
        const right = byRC.get(`${r},${c + 1}`);
        const overlapX = cur.endXmm - right.originXmm;
        assert.ok(
          Math.abs(overlapX - 10.0) < 1e-3,
          `horizontal overlap between R${r + 1}C${c + 1} and R${r + 1}C${c + 2} is ${overlapX}mm, expected 10mm`
        );
        assert.equal(cur.originYmm, right.originYmm);
      }
      if (r + 1 < plan.tileRows) {
        const below = byRC.get(`${r + 1},${c}`);
        const overlapY = cur.endYmm - below.originYmm;
        assert.ok(
          Math.abs(overlapY - 10.0) < 1e-3,
          `vertical overlap between R${r + 1}C${c + 1} and R${r + 2}C${c + 1} is ${overlapY}mm, expected 10mm`
        );
        assert.equal(cur.originXmm, below.originXmm);
      }
    }
  }
});

test('Letter paper size and Tier A hand-draw sheet + overview are generated accurately', () => {
  const { layout, plan, files } = generateMarkerArtifacts({
    pitchX: 16,
    pitchY: 14,
    cols: 4,
    rows: 4,
    tier: 'A',
    paper: 'Letter',
  });

  const firstTile = files.find((f) => f.kind === 'tile');
  const { root } = parseTileSvg(firstTile.content);
  assert.equal(root.width, '215.9mm');
  assert.equal(root.height, '279.4mm');
  assert.equal(root.viewBox, '0 0 215.9 279.4');

  const handTxt = files.find((f) => f.name === 'hand-draw-sheet.txt');
  assert.ok(handTxt, 'hand-draw-sheet.txt missing');
  for (const d of layout.dots) {
    assert.ok(handTxt.content.includes(d.id), `hand-draw sheet missing dot ${d.id}`);
  }

  const handSvg = files.find((f) => f.name === 'hand-draw-sheet.svg');
  assert.ok(handSvg && handSvg.content.includes('data-hand-draw-sheet="true"'));

  const overview = files.find((f) => f.name === 'overview.svg');
  assert.ok(overview && overview.content.includes('data-overview="true"'));
  for (const t of plan.tiles) {
    assert.ok(overview.content.includes(`data-tile-label="${t.label}"`), `overview missing tile ${t.label}`);
  }
});

test('CLI executes end-to-end and writes valid SVGs and layout.json to --out dir', () => {
  const cliParsed = parseCliArgs([
    '--pitchX', '16', '--pitchY', '14', '--cols', '2', '--rows', '2', '--tier', 'A', '--paper', 'A4',
  ]);
  assert.equal(cliParsed.pitchX, 16);
  assert.equal(cliParsed.cols, 2);
  assert.equal(cliParsed.tier, 'A');

  const outDir = mkdtempSync(join(tmpdir(), 'dbc-ar-markers-'));
  try {
    const res = spawnSync(
      process.execPath,
      [
        'tools/ar-markers.mjs',
        '--pitchX', '16',
        '--pitchY', '14',
        '--cols', '2',
        '--rows', '2',
        '--tier', 'A',
        '--paper', 'A4',
        '--out', outDir,
      ],
      { encoding: 'utf8', timeout: 15000 }
    );
    assert.equal(res.status, 0, `CLI exited non-zero: ${res.stderr}`);
    assert.ok(existsSync(join(outDir, 'tile-R1C1.svg')), 'tile-R1C1.svg not written');
    assert.ok(existsSync(join(outDir, 'overview.svg')), 'overview.svg not written');
    assert.ok(existsSync(join(outDir, 'hand-draw-sheet.txt')), 'hand-draw-sheet.txt not written');
    assert.ok(existsSync(join(outDir, 'layout.json')), 'layout.json not written');

    const savedLayout = JSON.parse(readFileSync(join(outDir, 'layout.json'), 'utf8'));
    assert.equal(savedLayout.counts.corners, 9);
    assert.equal(savedLayout.counts.labelOffsets, 4);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

console.log(`All ${passed} M1 printable AR marker tests passed.`);
