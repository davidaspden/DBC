/**
 * L5 — photo-textured tote walls (`src/sim/photo-wall.js`, `tools/img2wall.mjs`, CPU renderer, GL shader source).
 * Run: node --expose-gc tests/photo-wall.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  parsePgm, encodePgm, unitSquareToQuad, warpQuadToRect, measureWallStats, fillLabelRegion,
  buildWallTexture, preparePhotoWall, samplePhotoWall, applySimPhotoWall, wallMeta, wallFromParts,
} from '../src/sim/photo-wall.js';
import { loadWallFile, writeWallFiles, cornersFromString } from '../tools/img2wall.mjs';
import { createScene } from '../src/sim/scene.js';
import { createSceneForPreset } from '../src/sim/presets.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';
import { createPipelineState, createPipelineResult, processFrameMulti, extractMultiDetections } from '../src/worker/scanner.worker.js';
import { buildWallFragSrc } from '../src/sim/webgl-wall.js';
import { SIM_FLAG_DEFS as SIM_FLAGS } from '../src/sim/simflags.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}
const sha = (u8) => createHash('sha256').update(u8).digest('hex').slice(0, 16);
const WALL_BASE = new URL('./fixtures-sim/walls/tote-tsX07wz7py1', import.meta.url).pathname;

// --- synthetic 200x300 "photo": smooth gradient + a 1 px grid, with a white label holding black bars ---
function syntheticPhoto() {
  const w = 200; const h = 300;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = 40 + ((x * 0.2 + y * 0.1) | 0) + ((x % 20 === 0 || y % 20 === 0) ? 4 : 0);
  }
  // label at x 60..140, y 80..220: paper 230, bars 20 on every 4th column band
  for (let y = 80; y < 220; y++) for (let x = 60; x < 140; x++) data[y * w + x] = (((x - 60) >> 2) & 1) ? 20 : 230;
  return { width: w, height: h, data };
}
const CORNERS = [[0, 0], [200, 0], [200, 300], [0, 300]];

await test('L5 simPhotoWall is a registered sim flag, default off; scene default has no wall texture', () => {
  const f = SIM_FLAGS.find((d) => d.name === 'simPhotoWall');
  assert.ok(f && f.default === false && f.item === 'L5');
  assert.equal(createScene({}).wallTexture, null);
});

await test('L5 PGM parse/encode round trip; homography maps the unit square corners onto the quad', () => {
  const src = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const back = parsePgm(encodePgm(3, 2, src));
  assert.equal(back.width, 3); assert.equal(back.height, 2);
  assert.deepEqual(Array.from(back.data), Array.from(src));
  const quad = [[10, 20], [110, 30], [120, 140], [5, 150]];
  const H = unitSquareToQuad(quad);
  const map = (u, v) => { const d = H[6] * u + H[7] * v + 1; return [(H[0] * u + H[1] * v + H[2]) / d, (H[3] * u + H[4] * v + H[5]) / d]; };
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
    const [x, y] = map(u, v);
    assert.ok(Math.abs(x - quad[i][0]) < 1e-6 && Math.abs(y - quad[i][1]) < 1e-6, `corner ${i}`);
  });
  assert.throws(() => unitSquareToQuad([[0, 0], [1, 1], [2, 2], [3, 3]]), /degenerate/);
});

await test('L5 img2wall: an axis-aligned quad warps to the same pixels; stats are measured; the label region is masked and filled', () => {
  const photo = syntheticPhoto();
  const rect = { u0: 0.3, v0: 0.26, u1: 0.7, v1: 0.74 };
  const wall = buildWallTexture({ pgm: photo, corners: CORNERS, outWidth: 200, outHeight: 300, labelRect: rect, name: 'syn' });
  // outside the label, a 1:1 warp reproduces the photo (within resampling rounding)
  let maxDiff = 0;
  for (let y = 0; y < 300; y++) for (let x = 0; x < 200; x++) {
    const inLabel = x >= 55 && x < 145 && y >= 76 && y < 224;
    if (inLabel || x === 199 || y === 299) continue;
    maxDiff = Math.max(maxDiff, Math.abs(wall.data[y * 200 + x] - photo.data[y * 200 + x]));
  }
  assert.ok(maxDiff <= 8, `1:1 warp differs by ${maxDiff}`);
  // stats: paper ~230/255, ink ~20/255 measured from the label, tote albedo from outside it
  assert.ok(Math.abs(wall.stats.paperAlbedo - 230 / 255) < 0.03, `paper ${wall.stats.paperAlbedo}`);
  assert.ok(Math.abs(wall.stats.inkAlbedo - 20 / 255) < 0.03, `ink ${wall.stats.inkAlbedo}`);
  assert.ok(wall.stats.toteAlbedo > 0.1 && wall.stats.toteAlbedo < 0.5);
  assert.ok(wall.stats.localContrast > 0);
  // masked: no pixel of the filled region keeps the label's bright/dark bars
  let bright = 0;
  for (let y = 80; y < 220; y++) for (let x = 60; x < 140; x++) if (wall.data[y * 200 + x] > 150 || wall.data[y * 200 + x] < 25) bright++;
  assert.equal(bright, 0, 'the label was replaced by tote-like pixels');
  const a = fillLabelRegion(new Uint8Array(200 * 300).fill(90), 200, 300, rect, 1.0);
  const b = fillLabelRegion(new Uint8Array(200 * 300).fill(90), 200, 300, rect, 1.0);
  assert.equal(sha(a), sha(b), 'fill is deterministic');
});

await test('L5 img2wall files: write then load round-trips the texture and metadata; the CLI corner parser is strict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wall-'));
  try {
    const wall = buildWallTexture({ pgm: syntheticPhoto(), corners: CORNERS, outWidth: 64, outHeight: 72, labelRect: { u0: 0.3, v0: 0.3, u1: 0.7, v1: 0.7 }, name: 'rt' });
    writeWallFiles(join(dir, 'rt'), wall);
    const back = loadWallFile(join(dir, 'rt'));
    assert.equal(sha(back.data), sha(wall.data));
    assert.deepEqual(wallMeta(back), JSON.parse(JSON.stringify(wallMeta(wall))));
    assert.throws(() => wallFromParts({ format: 'nope' }, new Uint8Array(1)), /not a dbc-photo-wall/);
    assert.throws(() => cornersFromString('1,2,3'), /8 numbers/);
    assert.deepEqual(cornersFromString('1,2,3,4,5,6,7,8'), [[1, 2], [3, 4], [5, 6], [7, 8]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('L5 committed fixture wall (from the real still): size, stats and the source quad are recorded', () => {
  const wall = loadWallFile(WALL_BASE);
  assert.equal(wall.width, 448); assert.equal(wall.height, 512);
  assert.equal(wall.toteWidthIn, 14); assert.equal(wall.toteHeightIn, 16);
  assert.ok(wall.stats.paperAlbedo > 0.7 && wall.stats.inkAlbedo < 0.2, JSON.stringify(wall.stats));
  assert.ok(wall.stats.labelContrast > 0.5);
  assert.equal(wall.source, 'tote-tsX07wz7py1-gray.pgm.gz');
  // provenance: warping the real still with the recorded corners reproduces the texture outside the label
  const still = parsePgm(new Uint8Array(gunzipSync(readFileSync(new URL('./fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz', import.meta.url)))));
  const again = warpQuadToRect(still, wall.corners, wall.width, wall.height);
  const lr = wall.stats.labelRect;
  let differ = 0;
  for (let y = 0; y < wall.height; y++) for (let x = 0; x < wall.width; x++) {
    const inLabel = x >= Math.floor(lr.u0 * wall.width) && x < Math.ceil(lr.u1 * wall.width) && y >= Math.floor(lr.v0 * wall.height) && y < Math.ceil(lr.v1 * wall.height);
    if (!inLabel && again[y * wall.width + x] !== wall.data[y * wall.width + x]) differ++;
  }
  assert.equal(differ, 0, 'the committed texture is the real still, warped');
  // the label rectangle is gone from the texture: no near-white pixels left inside it
  const r = wall.stats.labelRect;
  let hot = 0;
  for (let y = Math.floor(r.v0 * 512); y < Math.ceil(r.v1 * 512); y++) for (let x = Math.floor(r.u0 * 448); x < Math.ceil(r.u1 * 448); x++) if (wall.data[y * 448 + x] > 160) hot++;
  assert.equal(hot, 0);
});

await test('L5 sampling: bilinear at texel centres, mip level from the footprint (box average), no allocation', () => {
  // 8x8 checkerboard of 0/255 on a 8x8 in tote: 1 texel per inch
  const w = 8;
  const data = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[y * w + x] = ((x + y) & 1) ? 255 : 0;
  const wall = { format: 'dbc-photo-wall', version: 1, width: w, height: w, toteWidthIn: 8, toteHeightIn: 8, data, stats: { paperAlbedo: 0.9, inkAlbedo: 0.05 } };
  const p = preparePhotoWall(wall);
  assert.equal(p.numLevels, 4);
  assert.equal(preparePhotoWall(wall), p, 'prepared once per wall');
  // texel (0,0) centre = (-3.5, +3.5) in: value 0; its right neighbour 255
  assert.equal(samplePhotoWall(p, -3.5, 3.5, 1.0), 0);
  assert.equal(samplePhotoWall(p, -2.5, 3.5, 1.0), 255);
  assert.ok(Math.abs(samplePhotoWall(p, -3.0, 3.5, 1.0) - 127.5) < 1e-6, 'bilinear midpoint');
  // a footprint of 2+ in lands in a coarser level: checkerboard averages to mid grey
  const coarse = samplePhotoWall(p, 0.2, 0.3, 4.0);
  assert.ok(Math.abs(coarse - 127.5) < 8, `coarse sample ${coarse}`);
  assert.equal(preparePhotoWall(null), null);
  if (typeof global.gc === 'function') {
    for (let i = 0; i < 2000; i++) samplePhotoWall(p, (i % 7) - 3, (i % 5) - 2, 1 + (i % 3));
    global.gc();
    const h0 = process.memoryUsage().heapUsed;
    let acc = 0;
    for (let i = 0; i < 200000; i++) acc += samplePhotoWall(p, ((i * 13) % 80) / 10 - 4, ((i * 7) % 80) / 10 - 4, 0.5 + (i % 9) * 0.5);
    global.gc();
    const per = (process.memoryUsage().heapUsed - h0) / 200000;
    assert.ok(acc > 0 && per < 1, `sample allocates ${per} B/call`);
  }
});

// one 14x16 tote filling a 448x512 frame at the texture's own scale (32 px per inch)
function headOnSetup(wall, extra = {}) {
  const scene = createScene({ cols: 1, rows: 1, tote: { widthIn: 14, heightIn: 16 }, pitchXIn: 14, pitchYIn: 16, wallTexture: wall, shadowStrength: 0, noiseStrength: 0, glareStrength: 0, ...extra });
  const pose = { x: 0, y: 0, z: 14, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const opts = { width: 448, height: 512, hfovDeg: 2 * Math.atan(0.5) * 180 / Math.PI, shadowStrength: 0, noiseStrength: 0, glareStrength: 0, seed: 1 };
  return { scene, pose, opts };
}

await test('L5 acceptance: a head-on render at the photo\'s own scale matches the source outside the label (mean < 8/255)', () => {
  const wall = loadWallFile(WALL_BASE);
  const { scene, pose, opts } = headOnSetup(wall);
  const out = new Uint8Array(448 * 512);
  renderFrame(scene, [pose], opts, out);
  // the analytic label sits in the middle (2 x 3.5 in = 64 x 112 px at 32 px/in): leave it out
  let sum = 0; let n = 0; let max = 0;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 448; x++) {
      if (Math.abs(x - 224) < 40 && Math.abs(y - 256) < 130) continue;
      const d = Math.abs(out[y * 448 + x] - wall.data[y * 448 + x]);
      sum += d; n++; if (d > max) max = d;
    }
  }
  const mean = sum / n;
  console.log(`        head-on mean abs diff outside the label: ${mean.toFixed(3)}/255 (max ${max})`);
  assert.ok(mean < 8, `mean ${mean}`);
  assert.ok(mean < 1.5, 'in practice the texel-centred lookup is near exact');
  // and the label itself is the analytic barcode at the measured contrast: dark bars and bright paper both present
  let lo = 255; let hi = 0;
  for (let y = 200; y < 312; y++) for (let x = 200; x < 248; x++) { lo = Math.min(lo, out[y * 448 + x]); hi = Math.max(hi, out[y * 448 + x]); }
  assert.ok(hi > 0.7 * 255 * wall.stats.paperAlbedo && lo < 0.5 * 255 * (wall.stats.paperAlbedo + wall.stats.inkAlbedo), `label luma range ${lo}..${hi}`);
});

await test('L5 flag off: no wall texture, or the flag false, renders bit-for-bit like before', () => {
  const wall = loadWallFile(WALL_BASE);
  const pose = { x: 0, y: 0, z: 10, yawDeg: -20, pitchDeg: 0, rollDeg: 0 };
  const o = { width: 320, height: 180, hfovDeg: 70.7, seed: 7 };
  const base = createScene({ fcMode: true });
  const gated = applySimPhotoWall(base, { simPhotoWall: false, wall });
  assert.equal(gated, base, 'flag false returns the scene itself');
  const a = new Uint8Array(320 * 180); const b = new Uint8Array(320 * 180); const c = new Uint8Array(320 * 180);
  renderFrame(base, [pose], o, a);
  renderFrame(createScene({ fcMode: true, wallTexture: null }), [pose], o, b);
  renderFrame(applySimPhotoWall(base, { simPhotoWall: true, wall }), [pose], o, c);
  assert.equal(Buffer.compare(a, b), 0);
  assert.notEqual(Buffer.compare(a, c), 0, 'flag on changes the picture');
});

await test('L5 mip by footprint: far away the render averages the texture instead of aliasing it', () => {
  // texture is a 1-texel checkerboard (worst case); at 4 texels per pixel it must come out mid-grey, not noise
  const w = 448; const h = 512;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = ((x + y) & 1) ? 220 : 40;
  const wall = { format: 'dbc-photo-wall', version: 1, name: 'chk', width: w, height: h, toteWidthIn: 14, toteHeightIn: 16, data, stats: { paperAlbedo: 0.85, inkAlbedo: 0.05, labelRect: null, toteAlbedo: 0.5 } };
  const scene = createScene({ cols: 1, rows: 1, pitchXIn: 14, pitchYIn: 16, wallTexture: wall, shadowStrength: 0, noiseStrength: 0, glareStrength: 0, label: { widthIn: 0.1, heightIn: 0.1 } });
  const pose = { x: 0, y: 0, z: 14, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const out = new Uint8Array(112 * 128); // 4x smaller frame: 4 texels per pixel each way
  renderFrame(scene, [pose], { width: 112, height: 128, hfovDeg: 2 * Math.atan(0.5) * 180 / Math.PI, shadowStrength: 0, noiseStrength: 0, glareStrength: 0 }, out);
  let mn = 255; let mx = 0; let sum = 0; let n = 0;
  for (let y = 4; y < 124; y++) for (let x = 4; x < 108; x++) { const v = out[y * 112 + x]; mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; n++; }
  assert.ok(mx - mn <= 6, `aliasing: ${mn}..${mx}`);
  assert.ok(Math.abs(sum / n - 130) < 6, `mean ${sum / n} (expected about 130)`);
});

await test('L5 decode: a normal sim pose on the photo wall still decodes the labels (measured paper/ink contrast)', () => {
  const wall = loadWallFile(WALL_BASE);
  const base = createSceneForPreset('fc-8-3p5');
  const scene = applySimPhotoWall(base, { simPhotoWall: true, wall });
  assert.ok(scene.wallTexture === wall);
  const W = 1280; const H = 720;
  const ctx = createCpuRenderContext(scene.cells.length);
  const cell = scene.cells[0];
  const ws = createPipelineState(W, H); const wr = createPipelineResult();
  const luma = new Uint8Array(W * H);
  renderFrame(scene, [{ x: cell.cx, y: cell.cy, z: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0 }], { width: W, height: H, hfovDeg: 70.7, noiseStrength: 0.005, glareStrength: 0, ctx, seed: 3 }, luma);
  processFrameMulti(luma, W, H, ws, wr, false);
  const got = extractMultiDetections(ws).map((d) => d.payload);
  assert.ok(got.includes(cell.payload), `decoded [${got.join(',')}], expected ${cell.payload}`);
});

await test('L5 oblique pose and lips together render finite pixels (no NaN holes) and use the texture', () => {
  const wall = loadWallFile(WALL_BASE);
  const scene = createScene({ fcMode: true, lips: { enabled: true }, wallTexture: wall });
  const pose = { x: 6, y: 4, z: 12, yawDeg: 35, pitchDeg: 10, rollDeg: 3 };
  const out = new Uint8Array(480 * 270);
  renderFrame(scene, [pose], { width: 480, height: 270, hfovDeg: 70.7, seed: 5 }, out);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i];
  assert.ok(sum > 0 && sum < 255 * out.length);
  const multi = new Uint8Array(480 * 270);
  renderFrame(scene, [pose, { ...pose, x: 6.4 }, { ...pose, x: 6.8 }], { width: 480, height: 270, hfovDeg: 70.7, seed: 5 }, multi);
  assert.notEqual(sha(out), sha(multi), 'multi-pose blur path also runs the texture lookup');
});

await test('L5 GL shader mirrors the CPU renderer: photo uniforms, texture lookup in the tote and lip branches, default label albedos', () => {
  for (const gl2 of [true, false]) {
    const src = buildWallFragSrc(gl2);
    for (const s of ['uniform sampler2D uPhotoTex', 'uniform float uPhotoEnabled', 'uniform float uPhotoGain', 'uniform float uLabelPaper', 'uniform float uLabelInk',
      'uPhotoEnabled > 0.5', 'TEX2D(uPhotoTex, uvTote)', 'TEX2D(uPhotoTex, uvLip)', 'float paper = uLabelPaper;', 'float ink = uLabelInk;']) {
      assert.ok(src.includes(s), `shader (${gl2 ? 'ES 3.00' : 'ES 1.00'}) lacks: ${s}`);
    }
  }
  const js = readFileSync(new URL('../src/sim/webgl-wall.js', import.meta.url), 'utf8');
  assert.ok(js.includes('uniform1f(wallLoc.uLabelPaper, 0.93)') && js.includes('uniform1f(wallLoc.uLabelInk, 0.06)'), 'flag off keeps the legacy 0.93 / 0.06 label albedos');
  assert.ok(js.includes('generateMipmap') && js.includes('setPhotoWall'));
});

console.log(`\nAll ${passed} L5 photo wall tests passed.`);
