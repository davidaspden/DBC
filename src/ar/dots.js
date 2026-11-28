/**
 * M2 — AR dot detector (`src/ar/dots.js`).
 *
 * Finds the solid dark discs of the AR wall layout (`src/ar/layout.js`) in a luma frame.
 *
 *   1. 1/4-resolution box downscale of the luma (preallocated);
 *   2. local mean by integral image; a pixel is "ink" when `pixel < localMean - delta`, with `delta`
 *      adaptive from the wall noise (robust sigma of horizontal differences);
 *   3. connected components with a preallocated union-find (4-connected, two pass), per-component area,
 *      darkness-weighted centroid, second moments (elongation, orientation) and bounding box;
 *   4. filters: area band, fill ratio of the moment ellipse, elongation up to 3 (motion blur);
 *   5. the surviving dots are refined at FULL resolution (windowed darkness-weighted centroid against
 *      the ring background, subpixel) which also gives a full-resolution dot diameter;
 *   6. size classes (x1 / x1.25 / x1.5 / x2, the layout's landmarks) from the ratio of each dot's diameter
 *      to the median diameter of its nearest neighbours (so perspective does not matter).
 *
 * Zero allocation per frame: every buffer is created once in `createDotDetector`; results are
 * struct-of-arrays typed arrays plus a count. Integer maths in the pixel loops. No dependencies.
 */

const NO_OPTS = Object.freeze({});
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export const DOT_SIZE_RATIOS = Object.freeze([1, 1.25, 1.5, 2]);
export const DOT_SIZE_NAMES = Object.freeze(['x1', 'x1.25', 'x1.5', 'x2']);

/**
 * @param {{ width: number, height: number, maxDots?: number, scale?: number, maxLabels?: number }} cfg
 */
export function createDotDetector(cfg) {
  const width = cfg.width | 0;
  const height = cfg.height | 0;
  const maxDots = cfg.maxDots || 256;
  const S = cfg.scale || 4;
  const sw = Math.floor(width / S);
  const sh = Math.floor(height / S);
  const maxLabels = cfg.maxLabels || 16384;
  const rowStep = S >= 4 ? 2 : 1; // sample every other row of each block (half the memory traffic)
  const shift = Math.log2((S * S) / rowStep) | 0; // S=4 -> 3

  const small = new Uint8Array(sw * sh);
  const integral = new Uint32Array((sw + 1) * (sh + 1));
  const ink = new Uint8Array(sw * sh);
  const dark = new Uint8Array(sw * sh); // darkness (mean - pixel) clipped to 0..255
  const labels = new Int32Array(sw * sh);
  const parent = new Int32Array(maxLabels + 1);
  const hist = new Uint32Array(256);
  const rowSum = new Uint32Array(sw);
  const colX0 = new Int32Array(sw);
  const colX1 = new Int32Array(sw);
  let colR = -1;
  let lastBuf = null;
  let lastOff = -1;
  let luma32 = null;
  const MAX_R = 32;
  const recip = new Float64Array((2 * MAX_R + 1) * (2 * MAX_R + 1) + 1);
  for (let i = 1; i < recip.length; i++) recip[i] = 1 / i;

  // per label stats (Float64 for the moments)
  const lArea = new Float64Array(maxLabels + 1);
  const lW = new Float64Array(maxLabels + 1);
  const lSx = new Float64Array(maxLabels + 1);
  const lSy = new Float64Array(maxLabels + 1);
  const lSxx = new Float64Array(maxLabels + 1);
  const lSyy = new Float64Array(maxLabels + 1);
  const lSxy = new Float64Array(maxLabels + 1);
  const lMinX = new Int32Array(maxLabels + 1);
  const lMaxX = new Int32Array(maxLabels + 1);
  const lMinY = new Int32Array(maxLabels + 1);
  const lMaxY = new Int32Array(maxLabels + 1);

  const out = {
    count: 0,
    x: new Float32Array(maxDots), // full-res px, pixel centres at +0.5 (x = column + 0.5 convention)
    y: new Float32Array(maxDots),
    area: new Float32Array(maxDots), // full-res equivalent area px^2
    diameter: new Float32Array(maxDots), // full-res equivalent diameter px
    major: new Float32Array(maxDots), // full-res semi-axes (moment ellipse)
    minor: new Float32Array(maxDots),
    angleDeg: new Float32Array(maxDots), // major axis direction, 0 = +x, image y down
    elongation: new Float32Array(maxDots),
    fill: new Float32Array(maxDots),
    contrast: new Float32Array(maxDots), // wall luma minus dot core luma
    sizeRatio: new Float32Array(maxDots), // diameter / median neighbour diameter
    sizeClass: new Uint8Array(maxDots), // index into DOT_SIZE_NAMES
    delta: 0,
    sigma: 0,
    components: 0,
    rejected: { area: 0, fill: 0, elongation: 0, border: 0, overflow: 0 },
  };
  const NB = 6;
  const nbrD = new Float32Array(8);
  const nbrDist = new Float64Array(8);
  const nbrIdx = new Int32Array(8);

  function find(a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }

  /**
   * @param {Uint8Array} luma full frame, `width*height`
   * @param {{ meanRadius?: number, minDelta?: number, minArea?: number, maxArea?: number,
   *           maxElongation?: number, minFill?: number, maxFill?: number, refine?: boolean }} [opts]
   *   areas are in 1/4-resolution px (`scale` squared smaller than the frame)
   * @returns {typeof out}
   */
  function detect(luma, opts = NO_OPTS) {
    const R = Math.min(MAX_R, opts.meanRadius || 10);
    const minDelta = opts.minDelta || 24;
    const minArea = opts.minArea || 3;
    const maxArea = opts.maxArea || Math.max(40, (sw * sh) / 40);
    const maxElong = opts.maxElongation || 3;
    const minFill = opts.minFill || 0.5;
    const maxFill = opts.maxFill || 1.4;

    // 1. box downscale (S x S block, every `rowStep`-th row). With S = 4 and a 4-byte aligned buffer the
    //    four horizontal samples come from one 32-bit load (little-endian hosts); otherwise byte loads.
    if (S === 4 && (width & 3) === 0 && (luma.byteOffset & 3) === 0 && LITTLE_ENDIAN) {
      if (luma.buffer !== lastBuf || luma.byteOffset !== lastOff) {
        lastBuf = luma.buffer;
        lastOff = luma.byteOffset;
        luma32 = new Uint32Array(luma.buffer, luma.byteOffset, (luma.byteLength - 0) >> 2);
      }
      const w4 = width >> 2;
      for (let y = 0; y < sh; y++) {
        const so = y * sw;
        const b0 = y * 4 * w4;
        const b1 = b0 + 2 * w4;
        for (let x = 0; x < sw; x++) {
          const a = luma32[b0 + x];
          const b = luma32[b1 + x];
          small[so + x] = (((a & 0xff) + ((a >>> 8) & 0xff) + ((a >>> 16) & 0xff) + (a >>> 24) + (b & 0xff) + ((b >>> 8) & 0xff) + ((b >>> 16) & 0xff) + (b >>> 24)) >> 3);
        }
      }
    } else {
      for (let y = 0; y < sh; y++) {
        rowSum.fill(0);
        const base = y * S * width;
        for (let k = 0; k < S; k += rowStep) {
          const o = base + k * width;
          for (let x = 0; x < sw; x++) {
            const p = o + x * S;
            rowSum[x] += luma[p] + luma[p + 1] + luma[p + 2] + luma[p + 3];
          }
        }
        const so = y * sw;
        for (let x = 0; x < sw; x++) small[so + x] = rowSum[x] >> shift;
      }
    }

    // 2a. integral image
    const iw = sw + 1;
    for (let y = 0; y < sh; y++) {
      let run = 0;
      const io = (y + 1) * iw;
      const so = y * sw;
      for (let x = 0; x < sw; x++) {
        run += small[so + x];
        integral[io + x + 1] = integral[io - iw + x + 1] + run;
      }
    }

    // 2b. wall noise: robust sigma from |horizontal differences| (median via histogram)
    hist.fill(0);
    let nd = 0;
    for (let y = 0; y < sh; y += 2) {
      const so = y * sw;
      for (let x = 1; x < sw; x++) {
        const d = small[so + x] - small[so + x - 1];
        hist[d < 0 ? -d : d]++;
        nd++;
      }
    }
    let acc = 0;
    let med = 0;
    const half = nd >> 1;
    while (med < 255 && acc + hist[med] <= half) { acc += hist[med]; med++; }
    const sigma = (med + 0.5) / (0.6745 * Math.SQRT2);
    const delta = Math.max(minDelta, Math.round(5 * sigma));
    out.sigma = sigma;
    out.delta = delta;

    // 2c. ink mask + darkness (column window limits are precomputed per radius)
    if (colR !== R) {
      colR = R;
      for (let x = 0; x < sw; x++) {
        colX0[x] = x - R < 0 ? 0 : x - R;
        colX1[x] = x + R + 1 > sw ? sw : x + R + 1;
      }
    }
    for (let y = 0; y < sh; y++) {
      const y0 = y - R < 0 ? 0 : y - R;
      const y1 = y + R + 1 > sh ? sh : y + R + 1;
      const r0 = y0 * iw;
      const r1 = y1 * iw;
      const hgt = y1 - y0;
      const so = y * sw;
      for (let x = 0; x < sw; x++) {
        const x0 = colX0[x];
        const x1 = colX1[x];
        const sum = integral[r1 + x1] - integral[r0 + x1] - integral[r1 + x0] + integral[r0 + x0];
        const mean = (sum * recip[((x1 - x0) * hgt)]) | 0;
        const dk = mean - small[so + x];
        ink[so + x] = dk > delta ? 1 : 0;
        dark[so + x] = dk > 0 ? (dk > 255 ? 255 : dk) : 0;
      }
    }

    // 3. connected components (4-connected, two pass with union-find)
    let next = 1;
    let overflow = false;
    for (let y = 0; y < sh; y++) {
      const so = y * sw;
      for (let x = 0; x < sw; x++) {
        const i = so + x;
        if (ink[i] === 0) { labels[i] = 0; continue; }
        const l = x > 0 ? labels[i - 1] : 0;
        const u = y > 0 ? labels[i - sw] : 0;
        if (l === 0 && u === 0) {
          if (next > maxLabels) { overflow = true; labels[i] = 0; continue; }
          parent[next] = next;
          labels[i] = next++;
        } else if (l !== 0 && u !== 0) {
          const a = find(l);
          const b = find(u);
          if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
          labels[i] = a < b ? a : b;
        } else {
          labels[i] = l !== 0 ? l : u;
        }
      }
    }
    for (let i = 1; i < next; i++) {
      lArea[i] = 0; lW[i] = 0; lSx[i] = 0; lSy[i] = 0; lSxx[i] = 0; lSyy[i] = 0; lSxy[i] = 0;
      lMinX[i] = 0x7fffffff; lMaxX[i] = -1; lMinY[i] = 0x7fffffff; lMaxY[i] = -1;
    }
    for (let y = 0; y < sh; y++) {
      const so = y * sw;
      for (let x = 0; x < sw; x++) {
        const lab0 = labels[so + x];
        if (lab0 === 0) continue;
        const lab = find(lab0);
        const w = dark[so + x];
        lArea[lab]++;
        lW[lab] += w;
        lSx[lab] += w * x;
        lSy[lab] += w * y;
        lSxx[lab] += w * x * x;
        lSyy[lab] += w * y * y;
        lSxy[lab] += w * x * y;
        if (x < lMinX[lab]) lMinX[lab] = x;
        if (x > lMaxX[lab]) lMaxX[lab] = x;
        if (y < lMinY[lab]) lMinY[lab] = y;
        if (y > lMaxY[lab]) lMaxY[lab] = y;
      }
    }

    // 4. filter -> dots
    out.count = 0;
    out.components = 0;
    const rej = out.rejected;
    rej.area = 0; rej.fill = 0; rej.elongation = 0; rej.border = 0; rej.overflow = overflow ? 1 : 0;
    for (let lab = 1; lab < next; lab++) {
      if (parent[lab] !== lab) continue; // not a root
      out.components++;
      const a = lArea[lab];
      if (a < minArea || a > maxArea) { rej.area++; continue; }
      const w = lW[lab];
      const cx = lSx[lab] / w;
      const cy = lSy[lab] / w;
      const vxx = lSxx[lab] / w - cx * cx + 1 / 12;
      const vyy = lSyy[lab] / w - cy * cy + 1 / 12;
      const vxy = lSxy[lab] / w - cx * cy;
      const tr = vxx + vyy;
      const dt = Math.sqrt(Math.max(0, ((vxx - vyy) * (vxx - vyy)) / 4 + vxy * vxy));
      const l1 = tr / 2 + dt;
      const l2 = Math.max(1e-6, tr / 2 - dt);
      const elong = Math.sqrt(l1 / l2);
      if (elong > maxElong) { rej.elongation++; continue; }
      const aa = 2 * Math.sqrt(l1);
      const bb = 2 * Math.sqrt(l2);
      const fill = a / (Math.PI * aa * bb);
      if (fill < minFill || fill > maxFill) { rej.fill++; continue; }
      if (lMinX[lab] <= 0 || lMinY[lab] <= 0 || lMaxX[lab] >= sw - 1 || lMaxY[lab] >= sh - 1) { rej.border++; continue; }
      if (out.count >= maxDots) { rej.overflow = 1; break; }
      const k = out.count++;
      out.x[k] = (cx + 0.5) * S; // centre of the small pixel in full-res coordinates
      out.y[k] = (cy + 0.5) * S;
      out.area[k] = a * S * S;
      out.diameter[k] = 2 * Math.sqrt((a * S * S) / Math.PI);
      out.major[k] = aa * S;
      out.minor[k] = bb * S;
      out.angleDeg[k] = 0.5 * Math.atan2(2 * vxy, vxx - vyy) * (180 / Math.PI);
      out.elongation[k] = elong;
      out.fill[k] = fill;
      out.contrast[k] = 0;
    }

    // 5. full-resolution refinement
    if (opts.refine !== false) {
      for (let k = 0; k < out.count; k++) refine(luma, k);
    }

    // 6. size classes vs the neighbours
    classify();
    return out;
  }

  function refine(luma, k) {
    const cx = out.x[k];
    const cy = out.y[k];
    const rad = Math.ceil(out.major[k] * 1.5 + 3);
    let x0 = Math.floor(cx - rad);
    let y0 = Math.floor(cy - rad);
    let x1 = Math.ceil(cx + rad);
    let y1 = Math.ceil(cy + rad);
    if (x0 < 1) x0 = 1;
    if (y0 < 1) y0 = 1;
    if (x1 > width - 2) x1 = width - 2;
    if (y1 > height - 2) y1 = height - 2;
    // background: mean of the window border ring (2 px thick)
    let bs = 0;
    let bn = 0;
    for (let x = x0; x <= x1; x++) {
      bs += luma[y0 * width + x] + luma[y1 * width + x];
      bn += 2;
    }
    for (let y = y0 + 1; y < y1; y++) {
      bs += luma[y * width + x0] + luma[y * width + x1];
      bn += 2;
    }
    const bg = bs / bn;
    // darkest core (mean of the darkest 5% in the window ~ approximated by min over a 3x3 around the centre)
    let core = 255;
    const icx = Math.round(cx - 0.5);
    const icy = Math.round(cy - 0.5);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const v = luma[(icy + dy) * width + icx + dx];
        if (v < core) core = v;
      }
    }
    const span = bg - core;
    if (span < 8) return;
    const floor = 0.15 * span; // ignore the faint tails (noise) of the PSF
    let sw0 = 0;
    let sx = 0;
    let sy = 0;
    for (let y = y0; y <= y1; y++) {
      const o = y * width;
      for (let x = x0; x <= x1; x++) {
        const d = bg - luma[o + x] - floor;
        if (d > 0) { sw0 += d; sx += d * (x + 0.5); sy += d * (y + 0.5); }
      }
    }
    if (sw0 <= 0) return;
    out.x[k] = sx / sw0;
    out.y[k] = sy / sw0;
    out.contrast[k] = span;
    // equivalent area from the integrated darkness (full contrast = span)
    const areaEq = sw0 / (span * (1 - floor / span));
    if (areaEq > 4) {
      out.area[k] = areaEq;
      out.diameter[k] = 2 * Math.sqrt(areaEq / Math.PI);
    }
  }

  function classify() {
    const n = out.count;
    for (let i = 0; i < n; i++) {
      // the (up to) 6 nearest other dots, kept sorted by distance in nbrDist / nbrIdx
      let m = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const dx = out.x[j] - out.x[i];
        const dy = out.y[j] - out.y[i];
        const d2 = dx * dx + dy * dy;
        if (m === NB && d2 >= nbrDist[NB - 1]) continue;
        let p = m < NB ? m++ : NB - 1;
        while (p > 0 && nbrDist[p - 1] > d2) {
          nbrDist[p] = nbrDist[p - 1];
          nbrIdx[p] = nbrIdx[p - 1];
          p--;
        }
        nbrDist[p] = d2;
        nbrIdx[p] = j;
      }
      if (m === 0) { out.sizeRatio[i] = 1; out.sizeClass[i] = 0; continue; }
      for (let a = 0; a < m; a++) {
        const v = out.diameter[nbrIdx[a]];
        let b = a - 1;
        while (b >= 0 && nbrD[b] > v) { nbrD[b + 1] = nbrD[b]; b--; }
        nbrD[b + 1] = v;
      }
      const ref = m & 1 ? nbrD[m >> 1] : 0.5 * (nbrD[(m >> 1) - 1] + nbrD[m >> 1]);
      const ratio = ref > 0 ? out.diameter[i] / ref : 1;
      out.sizeRatio[i] = ratio;
      let bestC = 0;
      let bestE = Infinity;
      for (let c = 0; c < 4; c++) {
        const e = Math.abs(Math.log(ratio / DOT_SIZE_RATIOS[c]));
        if (e < bestE) { bestE = e; bestC = c; }
      }
      out.sizeClass[i] = bestC;
    }
  }

  return { detect, result: out, width, height, scaledWidth: sw, scaledHeight: sh };
}
