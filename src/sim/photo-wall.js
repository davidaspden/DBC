/**
 * L5 — Photo-textured tote walls (`src/sim/photo-wall.js`, flag `simPhotoWall`).
 *
 * A "photo wall" is one tote face as a normalised luma texture built from a real photo (`tools/img2wall.mjs`):
 *  - the four photo corners are warped to a W x H rectangle that stands for the whole tote face
 *    (default 448 x 512 texels for the 14 x 16 in tote, so 32 texels per inch);
 *  - the label region is **masked and filled** from its surroundings, and the stats measured from the photo
 *    (label paper albedo, bar black level, tote albedo, local contrast) are stored next to it;
 *  - the renderers look the texture up per pixel (bilinear + mip level chosen from the pixel footprint) and
 *    draw the analytic barcode over the masked region at the **measured paper/ink albedos**, so the wall has
 *    real colour, scuffs and seams but a known payload.
 *
 * This file is browser-safe (no node imports) and holds everything shared by the tool, the CPU renderer
 * and the tests. The same texture is uploaded as a mip-mapped texture by `webgl-wall.js` (WebGL2).
 *
 * Units: texture luma is 0..255 and means "the photo's own brightness"; the renderers divide by the flat
 * illumination so that, with no shadow gradient, glare or noise, a head-on render reproduces the photo.
 *
 * Scene use: `scene.wallTexture = wall` (a `dbc-photo-wall` object) turns the feature on; `null` (default)
 * leaves every renderer path as it was. `applySimPhotoWall(scene, { simPhotoWall, wall })` is the flag gate.
 */

export const WALL_FORMAT = 'dbc-photo-wall';
export const WALL_VERSION = 1;
export const DEFAULT_WALL_WIDTH_PX = 448;   // 32 texels per inch on the 14 in tote
export const DEFAULT_WALL_HEIGHT_PX = 512;  // 32 texels per inch on the 16 in tote
export const DEFAULT_TOTE_WIDTH_IN = 14;
export const DEFAULT_TOTE_HEIGHT_IN = 16;

// ---------------------------------------------------------------------------------------------
// PGM (P5) parsing
// ---------------------------------------------------------------------------------------------

/** Parses a binary PGM (P5, maxval 255) from bytes. */
export function parsePgm(bytes) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4 && pos < bytes.length) {
    while (pos < bytes.length && (bytes[pos] === 0x20 || bytes[pos] === 0x0a || bytes[pos] === 0x0d || bytes[pos] === 0x09)) pos++;
    if (bytes[pos] === 0x23) { while (pos < bytes.length && bytes[pos] !== 0x0a) pos++; continue; }
    let s = '';
    while (pos < bytes.length && !(bytes[pos] === 0x20 || bytes[pos] === 0x0a || bytes[pos] === 0x0d || bytes[pos] === 0x09)) s += String.fromCharCode(bytes[pos++]);
    tokens.push(s);
  }
  pos++; // single whitespace after maxval
  if (tokens[0] !== 'P5') throw new Error('parsePgm: only binary P5 PGM is supported');
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  if (!(width > 0 && height > 0) || Number(tokens[3]) !== 255) throw new Error('parsePgm: expected maxval 255');
  const data = bytes.subarray(pos, pos + width * height);
  if (data.length < width * height) throw new Error('parsePgm: truncated pixel data');
  return { width, height, data };
}

/** Encodes luma to a binary PGM (P5). */
export function encodePgm(width, height, data) {
  const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(head.length + width * height);
  out.set(head, 0);
  out.set(data.subarray(0, width * height), head.length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Quad -> rectangle warp (homography, bilinear, 2x2 supersampling)
// ---------------------------------------------------------------------------------------------

/**
 * Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) to the quad `corners` (TL, TR, BR, BL).
 * Returns [h0..h7] with h8 = 1.
 */
export function unitSquareToQuad(corners) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = corners;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    a = x1 - x0; b = x2 - x1; c = x0;
    d = y1 - y0; e = y2 - y1; f = y0;
    g = 0; h = 0;
  } else {
    const dx1 = x1 - x2; const dx2 = x3 - x2;
    const dy1 = y1 - y2; const dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) throw new Error('unitSquareToQuad: degenerate corner quad');
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0;
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0;
  }
  return [a, b, c, d, e, f, g, h];
}

function bilinearGray(src, w, h, x, y) {
  let xf = x - 0.5;
  let yf = y - 0.5;
  if (xf < 0) xf = 0; else if (xf > w - 1) xf = w - 1;
  if (yf < 0) yf = 0; else if (yf > h - 1) yf = h - 1;
  const x0 = xf | 0;
  const y0 = yf | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = xf - x0;
  const fy = yf - y0;
  const a = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx;
  const b = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Warps the photo quad (corners TL, TR, BR, BL in source pixels) to an `outW` x `outH` luma rectangle.
 * @param {{width:number,height:number,data:Uint8Array}} pgm
 * @param {number[][]} corners
 */
export function warpQuadToRect(pgm, corners, outW, outH) {
  const H = unitSquareToQuad(corners);
  const out = new Uint8Array(outW * outH);
  const sub = [0.25, 0.75];
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let acc = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const u = (x + sub[sx]) / outW;
          const v = (y + sub[sy]) / outH;
          const den = H[6] * u + H[7] * v + 1;
          const px = (H[0] * u + H[1] * v + H[2]) / den;
          const py = (H[3] * u + H[4] * v + H[5]) / den;
          acc += bilinearGray(pgm.data, pgm.width, pgm.height, px, py);
        }
      }
      out[y * outW + x] = Math.round(acc * 0.25);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Label mask, fill and measured stats
// ---------------------------------------------------------------------------------------------

function percentileOf(values, p) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

function rectPx(rect, w, h) {
  return {
    x0: Math.max(0, Math.floor(rect.u0 * w)),
    x1: Math.min(w, Math.ceil(rect.u1 * w)),
    y0: Math.max(0, Math.floor(rect.v0 * h)),
    y1: Math.min(h, Math.ceil(rect.v1 * h)),
  };
}

/**
 * Measures the stats the renderers need from the warped texture **before** the label is filled.
 * `labelRect` is `{u0,v0,u1,v1}` in 0..1 texture coordinates (null = no label in the photo).
 * Albedos are the photo's own brightness (0..1): the renderer divides by the flat illumination.
 */
export function measureWallStats(tex, w, h, labelRect) {
  const mask = new Uint8Array(w * h);
  let paper = 0.93;
  let ink = 0.06;
  if (labelRect) {
    const r = rectPx(labelRect, w, h);
    const inside = [];
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        mask[y * w + x] = 1;
        inside.push(tex[y * w + x]);
      }
    }
    paper = percentileOf(inside, 0.93) / 255;
    ink = percentileOf(inside, 0.04) / 255;
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) { sum += tex[i]; n++; }
  }
  const mean = n ? sum / n : 0;
  let varSum = 0;
  let gradSum = 0;
  let gn = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i] || mask[i + 1] || mask[i + w]) continue;
      const d = tex[i] - mean;
      varSum += d * d;
      gradSum += Math.abs(tex[i + 1] - tex[i]) + Math.abs(tex[i + w] - tex[i]);
      gn++;
    }
  }
  return {
    toteAlbedo: round4(mean / 255),
    toteStd: round4(Math.sqrt(gn ? varSum / gn : 0) / 255),
    localContrast: round4(gn ? gradSum / (2 * gn) / 255 : 0),
    paperAlbedo: round4(paper),
    inkAlbedo: round4(ink),
    labelContrast: round4(paper - ink),
    labelRect: labelRect ? { ...labelRect } : null,
  };
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Fills the masked label rectangle in place: each row is interpolated between the unmasked pixels at its
 * left and right edge (so a bright overlay or an edge above/below the label cannot leak into the fill), plus
 * a small deterministic grain with the requested standard deviation so the patch does not look synthetically flat.
 */
export function fillLabelRegion(tex, w, h, labelRect, grainStd = 0) {
  if (!labelRect) return tex;
  const r = rectPx(labelRect, w, h);
  const xl = Math.max(0, r.x0 - 1);
  const xr = Math.min(w - 1, r.x1);
  let rng = 0x2545f491;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const fx = (x - xl) / Math.max(1, xr - xl);
      let v = tex[y * w + xl] * (1 - fx) + tex[y * w + xr] * fx;
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      v += ((rng >>> 8) / 16777216 - 0.5) * 3.46 * grainStd; // uniform with the requested std
      tex[y * w + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return tex;
}

/**
 * Builds a `dbc-photo-wall` object from a parsed PGM and four corners.
 *
 * @param {{ pgm: {width:number,height:number,data:Uint8Array}, corners: number[][], name?: string,
 *           outWidth?: number, outHeight?: number, toteWidthIn?: number, toteHeightIn?: number,
 *           labelRect?: {u0:number,v0:number,u1:number,v1:number}|null, source?: string }} o
 */
export function buildWallTexture(o) {
  const w = o.outWidth || DEFAULT_WALL_WIDTH_PX;
  const h = o.outHeight || DEFAULT_WALL_HEIGHT_PX;
  const tex = warpQuadToRect(o.pgm, o.corners, w, h);
  const labelRect = o.labelRect || null;
  const stats = measureWallStats(tex, w, h, labelRect);
  fillLabelRegion(tex, w, h, labelRect, stats.localContrast * 255 * 0.6);
  return {
    format: WALL_FORMAT,
    version: WALL_VERSION,
    name: o.name || 'photo-wall',
    source: o.source || null,
    corners: o.corners.map((c) => [c[0], c[1]]),
    width: w,
    height: h,
    toteWidthIn: o.toteWidthIn || DEFAULT_TOTE_WIDTH_IN,
    toteHeightIn: o.toteHeightIn || DEFAULT_TOTE_HEIGHT_IN,
    stats,
    data: tex,
  };
}

/** Rebuilds a wall object from its metadata JSON and decoded texture bytes (the two files img2wall writes). */
export function wallFromParts(meta, textureBytes) {
  if (!meta || meta.format !== WALL_FORMAT) throw new Error('wallFromParts: not a dbc-photo-wall file');
  const pgm = parsePgm(textureBytes);
  if (pgm.width !== meta.width || pgm.height !== meta.height) throw new Error('wallFromParts: texture size does not match its JSON');
  return { ...meta, data: pgm.data };
}

/** The JSON half of a wall (everything but the pixels). */
export function wallMeta(wall) {
  const { data, ...meta } = wall;
  return meta;
}

// ---------------------------------------------------------------------------------------------
// Render-side preparation and lookup (zero allocation per sample)
// ---------------------------------------------------------------------------------------------

const preparedCache = new WeakMap();

/**
 * Builds the mip chain and constants the renderers use. Cached per wall object.
 * Returns null when `wall` is falsy or not a photo wall (the flag-off path).
 */
export function preparePhotoWall(wall) {
  if (!wall || wall.format !== WALL_FORMAT || !wall.data) return null;
  let p = preparedCache.get(wall);
  if (p) return p;
  const levels = [wall.data];
  const lw = [wall.width];
  const lh = [wall.height];
  while (lw[lw.length - 1] > 1 || lh[lh.length - 1] > 1) {
    const sw = lw[lw.length - 1];
    const sh = lh[lh.length - 1];
    const src = levels[levels.length - 1];
    const dw = Math.max(1, (sw + 1) >> 1);
    const dh = Math.max(1, (sh + 1) >> 1);
    const dst = new Uint8Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(sh - 1, y * 2);
      const y1 = Math.min(sh - 1, y * 2 + 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(sw - 1, x * 2);
        const x1 = Math.min(sw - 1, x * 2 + 1);
        dst[y * dw + x] = (src[y0 * sw + x0] + src[y0 * sw + x1] + src[y1 * sw + x0] + src[y1 * sw + x1] + 2) >> 2;
      }
    }
    levels.push(dst);
    lw.push(dw);
    lh.push(dh);
  }
  const texelInX = wall.toteWidthIn / wall.width;
  const texelInY = wall.toteHeightIn / wall.height;
  const texelIn = Math.max(texelInX, texelInY);
  p = {
    wall,
    width: wall.width,
    height: wall.height,
    levels,
    lw,
    lh,
    numLevels: levels.length,
    halfToteW: wall.toteWidthIn * 0.5,
    halfToteH: wall.toteHeightIn * 0.5,
    invToteW: 1 / wall.toteWidthIn,
    invToteH: 1 / wall.toteHeightIn,
    texelIn,
    invTexelIn: 1 / texelIn,
    paperAlbedo: wall.stats.paperAlbedo,
    inkAlbedo: wall.stats.inkAlbedo,
  };
  preparedCache.set(wall, p);
  return p;
}

function bilinearLevel(p, l, u, v) {
  const w = p.lw[l];
  const h = p.lh[l];
  const d = p.levels[l];
  let x = u * w - 0.5;
  let y = v * h - 0.5;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const a = d[y0 * w + x0] + (d[y0 * w + x1] - d[y0 * w + x0]) * fx;
  const b = d[y1 * w + x0] + (d[y1 * w + x1] - d[y1 * w + x0]) * fx;
  return a + (b - a) * fy;
}

/**
 * Samples the photo wall (0..255 luma) at tote-local inches `(lx, ly)` (origin at the tote centre, +y up)
 * for a pixel footprint of `footprintIn` inches (trilinear: bilinear in the two nearest mip levels).
 * No allocation.
 */
export function samplePhotoWall(p, lx, ly, footprintIn) {
  let u = (lx + p.halfToteW) * p.invToteW;
  let v = (p.halfToteH - ly) * p.invToteH;
  if (u < 0) u = 0; else if (u > 1) u = 1;
  if (v < 0) v = 0; else if (v > 1) v = 1;
  let lod = 0;
  if (footprintIn > p.texelIn * 1.0001) {
    lod = Math.log2(footprintIn * p.invTexelIn);
    const maxL = p.numLevels - 1;
    if (lod > maxL) lod = maxL;
  }
  const l0 = lod | 0;
  const f = lod - l0;
  const a = bilinearLevel(p, l0, u, v);
  if (f < 0.004 || l0 + 1 >= p.numLevels) return a;
  return a + (bilinearLevel(p, l0 + 1, u, v) - a) * f;
}

/**
 * Flag gate (mirrors `applySimFcLabel`): with `simPhotoWall` false (default) the scene is returned
 * untouched; with it true and a wall, returns a copy of the scene with `wallTexture` set.
 */
export function applySimPhotoWall(scene, opts = {}) {
  if (!opts || !opts.simPhotoWall || !opts.wall || !scene || typeof scene !== 'object') return scene;
  return { ...scene, wallTexture: opts.wall };
}
