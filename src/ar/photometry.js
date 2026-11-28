/**
 * M5 — wall photometry estimator (`src/ar/photometry.js`), behind the `arCompose` sim flag (default OFF).
 *
 * From one luma frame and the detected dots (M2), estimate what the camera + wall did to the picture, so a
 * synthetic label composited into the frame (M6) looks like it was really on the wall:
 *
 *   shading      plane fit `paper(x, y) = a (1 + gx (x/W - 0.5) + gy (y/H - 0.5))` to the dot-free blocks;
 *   whitePoint   paper luma at the image centre (the plane value);
 *   blackPoint   ink luma at the centre: dot cores, divided by the local shading;
 *   noiseSigma   white-noise sigma from horizontal pixel differences on dot-free blocks (rounding removed);
 *   psfSigmaPx   optical Gaussian sigma from the 16%-84% width of dot edges along 8 rays per dot
 *                (pixel-box integration removed); per-direction medians give `psfSigmaMin/Max`
 *                (a ratio far from 1 means motion blur or an astigmatic lens).
 *
 * Zero allocation per frame: typed scratch arrays and one reused result record. The pixel loops are
 * strided integer reads; only the small per-dot ray sampling uses floating point.
 *
 * `estimate` returns the result record; `result.valid` is false when too little clean wall or too few
 * big dots were found (callers keep the previous estimate).
 */
import { isSimOn } from '../sim/simflags.js';

const NRAYS = 8;
const RAY_COS = new Float64Array(NRAYS);
const RAY_SIN = new Float64Array(NRAYS);
for (let k = 0; k < NRAYS; k++) { RAY_COS[k] = Math.cos((k * Math.PI) / NRAYS * 2); RAY_SIN[k] = Math.sin((k * Math.PI) / NRAYS * 2); }
const PIXEL_BOX_VAR = 1 / 12; // variance of one pixel of box integration (removed from the edge width)
const ROUND_VAR = 1 / 12; // uint8 rounding noise (removed from the pixel-difference noise)

/**
 * @param {{ width: number, height: number, grid?: number, enabled?: boolean, maxPsfDots?: number }} cfg
 */
export function createPhotometryEstimator(cfg) {
  const W = cfg.width | 0;
  const H = cfg.height | 0;
  const G = cfg.grid || 12; // G x G blocks
  const enabled = cfg.enabled === undefined ? isSimOn('arCompose') : Boolean(cfg.enabled);
  const maxPsf = cfg.maxPsfDots || 16;

  const bw = Math.floor(W / G);
  const bh = Math.floor(H / G);
  const blockMean = new Float64Array(G * G);
  const blockOk = new Uint8Array(G * G);
  const blockDiff = new Float64Array(G * G); // sum of squared horizontal differences
  const blockDiffN = new Float64Array(G * G);
  const blockVarList = new Float64Array(G * G);
  const sel = new Int32Array(maxPsf);
  const selScore = new Float64Array(maxPsf);
  const samples = new Float64Array(maxPsf * NRAYS);
  const dirSamples = new Float64Array(maxPsf);
  const coreVals = new Float64Array(maxPsf);
  const plane = new Float64Array(3); // a, b (per px x), c (per px y) of the paper plane, origin at the image centre
  const sc = new Float64Array(8); // scratch scalars (no captured `let` doubles)
  const dirMed = new Float64Array(NRAYS);

  const result = {
    valid: false,
    enabled,
    whitePoint: 0,
    blackPoint: 0,
    shadingGx: 0,
    shadingGy: 0,
    noiseSigma: 0,
    psfSigmaPx: 0,
    psfSigmaMin: 0,
    psfSigmaMax: 0,
    cleanBlocks: 0,
    psfDots: 0,
    coreDots: 0,
  };

  function paperAt(x, y) {
    return plane[0] + plane[1] * (x - W * 0.5) + plane[2] * (y - H * 0.5);
  }

  function bilinear(luma, x, y) {
    // continuous coordinates with pixel centres at +0.5
    const fx = x - 0.5; const fy = y - 0.5;
    let ix = Math.floor(fx); let iy = Math.floor(fy);
    if (ix < 0) ix = 0; else if (ix > W - 2) ix = W - 2;
    if (iy < 0) iy = 0; else if (iy > H - 2) iy = H - 2;
    const tx = fx - ix; const ty = fy - iy;
    const o = iy * W + ix;
    return (luma[o] * (1 - tx) + luma[o + 1] * tx) * (1 - ty) + (luma[o + W] * (1 - tx) + luma[o + W + 1] * tx) * ty;
  }

  function sortRange(a, n) {
    for (let i = 1; i < n; i++) { const v = a[i]; let j = i - 1; while (j >= 0 && a[j] > v) { a[j + 1] = a[j]; j--; } a[j + 1] = v; }
  }
  function medianN(a, n) {
    sortRange(a, n);
    return n & 1 ? a[n >> 1] : 0.5 * (a[(n >> 1) - 1] + a[n >> 1]);
  }

  /**
   * @param {Uint8Array} luma
   * @param {{count:number, x:Float32Array, y:Float32Array, diameter:Float32Array, major:Float32Array,
   *          minor:Float32Array, elongation:Float32Array}} dots M2 result
   */
  function estimate(luma, dots) {
    result.valid = false;
    if (!enabled) return result;
    const n = dots.count;

    // ---- 1. clean blocks + block means + pixel-difference noise ----
    let clean = 0;
    for (let by = 0; by < G; by++) {
      for (let bx = 0; bx < G; bx++) {
        const b = by * G + bx;
        const x0 = bx * bw; const y0 = by * bh;
        let ok = 1;
        // a block is clean when no dot (radius x 1.8 + 3 px) comes near it
        for (let d = 0; d < n; d++) {
          const r = dots.major[d] * 1.8 + 3;
          const dx = dots.x[d] < x0 ? x0 - dots.x[d] : dots.x[d] > x0 + bw ? dots.x[d] - (x0 + bw) : 0;
          const dy = dots.y[d] < y0 ? y0 - dots.y[d] : dots.y[d] > y0 + bh ? dots.y[d] - (y0 + bh) : 0;
          if (dx * dx + dy * dy < r * r) { ok = 0; break; }
        }
        blockOk[b] = ok;
        if (!ok) continue;
        clean++;
        let sum = 0; let cnt = 0; let dsum = 0; let dn = 0;
        for (let y = y0 + 1; y < y0 + bh - 1; y += 2) {
          const o = y * W;
          let prev = luma[o + x0];
          for (let x = x0 + 1; x < x0 + bw - 1; x++) {
            const v = luma[o + x];
            sum += v; cnt++;
            const d = v - prev; dsum += d * d; dn++;
            prev = v;
          }
        }
        blockMean[b] = sum / cnt;
        blockDiff[b] = dsum; blockDiffN[b] = dn;
      }
    }
    result.cleanBlocks = clean;
    if (clean < 6) return result;

    // ---- 2. paper plane by least squares over the clean block means (centred coordinates); one robust
    //         re-fit that drops blocks the plane misses (dot halos, stains) ----
    for (let pass = 0; pass < 2; pass++) {
      let s1 = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let syy = 0; let sv = 0; let sxv = 0; let syv = 0;
      for (let by = 0; by < G; by++) {
        for (let bx = 0; bx < G; bx++) {
          const b = by * G + bx;
          if (!blockOk[b]) continue;
          const x = bx * bw + bw * 0.5 - W * 0.5; const y = by * bh + bh * 0.5 - H * 0.5; const v = blockMean[b];
          if (pass === 1 && Math.abs(v - (plane[0] + plane[1] * x + plane[2] * y)) > 1.5 + 0.02 * plane[0]) { blockOk[b] = 0; continue; }
          s1++; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; sv += v; sxv += x * v; syv += y * v;
        }
      }
      if (s1 < 6) return result;
      // solve [s1 sx sy; sx sxx sxy; sy sxy syy] [a b c]' = [sv sxv syv]'
      const det = s1 * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
      if (!(Math.abs(det) > 1e-9)) return result;
      plane[0] = (sv * (sxx * syy - sxy * sxy) - sx * (sxv * syy - sxy * syv) + sy * (sxv * sxy - sxx * syv)) / det;
      plane[1] = (s1 * (sxv * syy - sxy * syv) - sv * (sx * syy - sxy * sy) + sy * (sx * syv - sxv * sy)) / det;
      plane[2] = (s1 * (sxx * syv - sxv * sxy) - sx * (sx * syv - sxv * sy) + sv * (sx * sxy - sxx * sy)) / det;
    }
    const a = plane[0];
    if (!(a > 8)) return result;
    result.whitePoint = a;
    result.shadingGx = (plane[1] * W) / a;
    result.shadingGy = (plane[2] * H) / a;
    // white-noise sigma: var(diff) = 2 sigma^2 (+ gradient, negligible); median over the surviving blocks is
    // robust to a block that still holds an edge; the uint8 rounding variance is removed
    let nb = 0;
    for (let b = 0; b < G * G; b++) if (blockOk[b]) blockVarList[nb++] = blockDiff[b] / blockDiffN[b];
    const varPix = medianN(blockVarList, nb) / 2 - ROUND_VAR;
    result.noiseSigma = varPix > 0 ? Math.sqrt(varPix) : 0;

    // ---- 3. pick the largest round dots away from the border ----
    let m = 0;
    for (let d = 0; d < n; d++) {
      if (dots.elongation[d] > 1.5 || dots.diameter[d] < 12) continue;
      const r = dots.major[d] * 1.6 + 3;
      if (dots.x[d] < r || dots.y[d] < r || dots.x[d] > W - r || dots.y[d] > H - r) continue;
      const score = dots.diameter[d];
      if (m < maxPsf) { sel[m] = d; selScore[m] = score; m++; } else {
        let wi = 0;
        for (let k = 1; k < m; k++) if (selScore[k] < selScore[wi]) wi = k;
        if (score > selScore[wi]) { sel[wi] = d; selScore[wi] = score; }
      }
    }
    result.psfDots = m;
    if (m < 2) return result;

    // ---- 4. PSF from the edge width along rays; ink level from the cores ----
    let ns = 0;
    let nc = 0;
    for (let k = 0; k < NRAYS; k++) dirMed[k] = 0;
    for (let q = 0; q < m; q++) {
      const d = sel[q];
      const cx = dots.x[d]; const cy = dots.y[d];
      const rm = dots.minor[d];
      // core: mean of the pixels within 0.3 minor semi-axes
      const rc = Math.max(1.5, 0.3 * rm);
      let cs = 0; let cn = 0;
      const ix0 = Math.floor(cx - rc); const ix1 = Math.ceil(cx + rc); const iy0 = Math.floor(cy - rc); const iy1 = Math.ceil(cy + rc);
      for (let y = iy0; y <= iy1; y++) {
        for (let x = ix0; x <= ix1; x++) {
          const ex = x + 0.5 - cx; const ey = y + 0.5 - cy;
          if (ex * ex + ey * ey <= rc * rc) { cs += luma[y * W + x]; cn++; }
        }
      }
      if (cn < 4) continue;
      const core = cs / cn;
      const bgC = paperAt(cx, cy);
      if (!(bgC - core > 20)) continue;
      coreVals[nc++] = (core / bgC) * a; // ink level normalised to the image centre's shading
      // rays: outward from the centre, locate the 84% and 16% darkness crossings
      const rmax = dots.major[d] * 1.7 + 4;
      for (let k = 0; k < NRAYS; k++) {
        const ux = RAY_COS[k]; const uy = RAY_SIN[k];
        let rr = 0.5;
        let r84 = -1; let r16 = -1;
        let tPrev = 1;
        let rPrev = 0.5;
        for (; rr <= rmax; rr += 0.25) {
          const px = cx + ux * rr; const py = cy + uy * rr;
          const bg = paperAt(px, py);
          const t = (bg - bilinear(luma, px, py)) / (bgC - core) * (bgC / bg); // darkness 1 = ink, 0 = paper
          if (r84 < 0 && t < 0.84 && tPrev >= 0.84) r84 = rPrev + ((tPrev - 0.84) / (tPrev - t)) * (rr - rPrev);
          if (r84 >= 0 && t < 0.16 && tPrev >= 0.16) { r16 = rPrev + ((tPrev - 0.16) / (tPrev - t)) * (rr - rPrev); break; }
          tPrev = t; rPrev = rr;
        }
        if (r84 > 0 && r16 > r84) samples[ns++] = 0.5 * (r16 - r84); // sigma of the Gaussian edge spread
        else samples[ns++] = -1;
      }
    }
    // per-direction medians and the overall median (invalid samples removed)
    let nv = 0;
    for (let k = 0; k < NRAYS; k++) {
      let nd = 0;
      for (let q = 0; q * NRAYS + k < ns; q++) { const v = samples[q * NRAYS + k]; if (v > 0) dirSamples[nd++] = v; }
      dirMed[k] = nd > 0 ? medianN(dirSamples, nd) : 0;
    }
    for (let i = 0; i < ns; i++) if (samples[i] > 0) samples[nv++] = samples[i];
    if (nv < 8 || nc < 2) return result;
    const sigMeas = medianN(samples, nv);
    let dmin = Infinity; let dmax = 0;
    for (let k = 0; k < NRAYS; k++) { if (dirMed[k] > 0) { if (dirMed[k] < dmin) dmin = dirMed[k]; if (dirMed[k] > dmax) dmax = dirMed[k]; } }
    result.psfSigmaPx = Math.sqrt(Math.max(0, sigMeas * sigMeas - PIXEL_BOX_VAR));
    result.psfSigmaMin = Math.sqrt(Math.max(0, dmin * dmin - PIXEL_BOX_VAR));
    result.psfSigmaMax = Math.sqrt(Math.max(0, dmax * dmax - PIXEL_BOX_VAR));
    result.blackPoint = medianN(coreVals, nc);
    result.coreDots = nc;
    result.valid = true;
    return result;
  }

  return { estimate, result, enabled, grid: G };
}
