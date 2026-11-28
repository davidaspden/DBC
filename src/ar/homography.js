/**
 * M3 — plane homography toolbox (`src/ar/homography.js`).
 *
 * `H` is a 3x3 row-major `Float64Array(9)` mapping wall inches (x, y) to image pixels (u, v):
 * `[u v 1]' ~ H [x y 1]'`. Everything below works on caller-owned typed arrays; a solver instance owns
 * its scratch memory, so nothing allocates per call. Plain doubles (the sets are tiny: tens of dots).
 *
 *  - `fit`            Hartley-normalised DLT (8x8 normal equations, h33 = 1) then a few Gauss-Newton
 *                     iterations with Huber weights on the reprojection error in pixels;
 *  - `ransac`         seeded 4-point RANSAC over putative correspondences (outliers allowed), then `fit`;
 *  - `rmsPx`, `project`, `invert3`, `jacobianScale` helpers.
 */

const NO_OPTS = Object.freeze({});
// preallocated option records for the internal fits (no per-call object literals)
const OPT_RAW = Object.freeze({ iters: 0 });

export function project(H, x, y, out, o = 0) {
  const w = H[6] * x + H[7] * y + H[8];
  out[o] = (H[0] * x + H[1] * y + H[2]) / w;
  out[o + 1] = (H[3] * x + H[4] * y + H[5]) / w;
  return w;
}

/** out = inverse(H); returns false when singular. `out` may not alias `H`. */
export function invert3(H, out) {
  const a = H[0]; const b = H[1]; const c = H[2];
  const d = H[3]; const e = H[4]; const f = H[5];
  const g = H[6]; const h = H[7]; const i = H[8];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300)) return false;
  const r = 1 / det;
  out[0] = A * r; out[1] = -(b * i - c * h) * r; out[2] = (b * f - c * e) * r;
  out[3] = B * r; out[4] = (a * i - c * g) * r; out[5] = -(a * f - c * d) * r;
  out[6] = C * r; out[7] = -(a * h - b * g) * r; out[8] = (a * e - b * d) * r;
  return true;
}

/** Local image-area scale |det J| (px^2 per in^2) of H at wall point (x, y); sqrt of it = px per inch. */
export function jacobianScale(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  const nu = H[0] * x + H[1] * y + H[2];
  const nv = H[3] * x + H[4] * y + H[5];
  const w2 = w * w;
  const dudx = (H[0] * w - nu * H[6]) / w2;
  const dudy = (H[1] * w - nu * H[7]) / w2;
  const dvdx = (H[3] * w - nv * H[6]) / w2;
  const dvdy = (H[4] * w - nv * H[7]) / w2;
  return Math.abs(dudx * dvdy - dudy * dvdx);
}

export function rmsPx(H, sx, sy, dx, dy, idx, n) {
  if (n <= 0) return 0;
  let s = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    const w = H[6] * sx[i] + H[7] * sy[i] + H[8];
    const u = (H[0] * sx[i] + H[1] * sy[i] + H[2]) / w - dx[i];
    const v = (H[3] * sx[i] + H[4] * sy[i] + H[5]) / w - dy[i];
    s += u * u + v * v;
  }
  return Math.sqrt(s / n);
}

/**
 * @param {number} maxN largest correspondence set handled
 */
export function createHomographySolver(maxN = 512) {
  const nx = new Float64Array(maxN); // normalised wall
  const ny = new Float64Array(maxN);
  const mu = new Float64Array(maxN); // normalised image
  const mv = new Float64Array(maxN);
  const wts = new Float64Array(maxN);
  const AtA = new Float64Array(64);
  const Atb = new Float64Array(8);
  const h = new Float64Array(8);
  const Hn = new Float64Array(9);
  const T = new Float64Array(6); // sCx, sCy, sS, dCx, dCy, dS
  const Hd = new Float64Array(9);
  const Tdi = new Float64Array(9);
  const tmp = new Float64Array(9);
  const sample = new Int32Array(4);
  const inl = new Uint8Array(maxN);
  const bestInl = new Uint8Array(maxN);
  const idxBuf = new Int32Array(maxN);
  const Hs = new Float64Array(9);
  const pj = new Float64Array(2);
  const ra = new Float64Array(8);
  const rb = new Float64Array(8);
  const res = { inliers: 0, rms: -1 };
  const ransacOpt = { huberPx: 1, iters: 6 };
  const rng = new Uint32Array(1); // typed-array cell: a captured `let` holding a uint32 would box a heap number per call
  function rnd() {
    rng[0] += 0x6d2b79f5;
    let t = rng[0];
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function solve8() {
    // Gaussian elimination with partial pivoting on AtA h = Atb (in place)
    for (let c = 0; c < 8; c++) {
      let p = c;
      let best = Math.abs(AtA[c * 8 + c]);
      for (let r = c + 1; r < 8; r++) {
        const v = Math.abs(AtA[r * 8 + c]);
        if (v > best) { best = v; p = r; }
      }
      if (best < 1e-12) return false;
      if (p !== c) {
        for (let k = 0; k < 8; k++) { const t = AtA[c * 8 + k]; AtA[c * 8 + k] = AtA[p * 8 + k]; AtA[p * 8 + k] = t; }
        const t = Atb[c]; Atb[c] = Atb[p]; Atb[p] = t;
      }
      const inv = 1 / AtA[c * 8 + c];
      for (let r = c + 1; r < 8; r++) {
        const f = AtA[r * 8 + c] * inv;
        if (f === 0) continue;
        for (let k = c; k < 8; k++) AtA[r * 8 + k] -= f * AtA[c * 8 + k];
        Atb[r] -= f * Atb[c];
      }
    }
    for (let r = 7; r >= 0; r--) {
      let s = Atb[r];
      for (let k = r + 1; k < 8; k++) s -= AtA[r * 8 + k] * h[k];
      h[r] = s / AtA[r * 8 + r];
    }
    return true;
  }

  function accumulate(n, useW) {
    AtA.fill(0);
    Atb.fill(0);
    for (let i = 0; i < n; i++) {
      const w = useW ? wts[i] : 1;
      const x = nx[i]; const y = ny[i]; const u = mu[i]; const v = mv[i];
      // row 1: [x y 1 0 0 0 -u x -u y] = u ; row 2: [0 0 0 x y 1 -v x -v y] = v
      ra[0] = x; ra[1] = y; ra[2] = 1; ra[3] = 0; ra[4] = 0; ra[5] = 0; ra[6] = -u * x; ra[7] = -u * y;
      rb[0] = 0; rb[1] = 0; rb[2] = 0; rb[3] = x; rb[4] = y; rb[5] = 1; rb[6] = -v * x; rb[7] = -v * y;
      for (let a = 0; a < 8; a++) {
        const a1 = ra[a] * w;
        const a2 = rb[a] * w;
        Atb[a] += a1 * u + a2 * v;
        for (let b = a; b < 8; b++) AtA[a * 8 + b] += a1 * ra[b] + a2 * rb[b];
      }
    }
    for (let a = 1; a < 8; a++) for (let b = 0; b < a; b++) AtA[a * 8 + b] = AtA[b * 8 + a];
  }

  /**
   * Fit H from `n` correspondences `idx[k]` (or 0..n-1 when `idx` is null).
   * @param {{ huberPx?: number, iters?: number }} [opts] huberPx 0 = plain least squares
   * @returns {number} RMS reprojection error in px over the used set, or -1 when degenerate
   */
  function fit(sx, sy, dx, dy, idx, n, Hout, opts) {
    if (n < 4) return -1;
    // normalisation
    let scx = 0; let scy = 0; let dcx = 0; let dcy = 0;
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k;
      scx += sx[i]; scy += sy[i]; dcx += dx[i]; dcy += dy[i];
    }
    scx /= n; scy /= n; dcx /= n; dcy /= n;
    let sds = 0; let sdd = 0;
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k;
      sds += Math.hypot(sx[i] - scx, sy[i] - scy);
      sdd += Math.hypot(dx[i] - dcx, dy[i] - dcy);
    }
    sds /= n; sdd /= n;
    if (!(sds > 1e-9) || !(sdd > 1e-9)) return -1;
    const ss = Math.SQRT2 / sds;
    const ds = Math.SQRT2 / sdd;
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k;
      nx[k] = (sx[i] - scx) * ss; ny[k] = (sy[i] - scy) * ss;
      mu[k] = (dx[i] - dcx) * ds; mv[k] = (dy[i] - dcy) * ds;
    }
    accumulate(n, false);
    if (!solve8()) return -1;
    for (let k = 0; k < 8; k++) Hn[k] = h[k];
    Hn[8] = 1;

    const huber = opts && opts.huberPx > 0 ? opts.huberPx * ds : 0; // threshold in normalised units
    const iters = opts && opts.iters !== undefined ? opts.iters : huber > 0 ? 6 : 0;
    for (let it = 0; it < iters; it++) {
      // IRLS on the linearised (algebraic) problem is replaced by true Gauss-Newton on reprojection error
      AtA.fill(0);
      Atb.fill(0);
      for (let i = 0; i < n; i++) {
        const x = nx[i]; const y = ny[i];
        const w = Hn[6] * x + Hn[7] * y + 1;
        const uu = (Hn[0] * x + Hn[1] * y + Hn[2]) / w;
        const vv = (Hn[3] * x + Hn[4] * y + Hn[5]) / w;
        const ru = mu[i] - uu;
        const rv = mv[i] - vv;
        const r = Math.hypot(ru, rv);
        const wt = r <= huber ? 1 : huber / r;
        const iw = 1 / w;
        const ja0 = x * iw; const ja1 = y * iw; const ja2 = iw;
        const j6u = -uu * x * iw; const j7u = -uu * y * iw;
        const j6v = -vv * x * iw; const j7v = -vv * y * iw;
        // row u: [ja0 ja1 ja2 0 0 0 j6u j7u], row v: [0 0 0 ja0 ja1 ja2 j6v j7v]
        ra[0] = ja0; ra[1] = ja1; ra[2] = ja2; ra[3] = 0; ra[4] = 0; ra[5] = 0; ra[6] = j6u; ra[7] = j7u;
        rb[0] = 0; rb[1] = 0; rb[2] = 0; rb[3] = ja0; rb[4] = ja1; rb[5] = ja2; rb[6] = j6v; rb[7] = j7v;
        for (let a = 0; a < 8; a++) {
          const au = ra[a] * wt;
          const av = rb[a] * wt;
          Atb[a] += au * ru + av * rv;
          for (let b = a; b < 8; b++) AtA[a * 8 + b] += au * ra[b] + av * rb[b];
        }
      }
      for (let a = 1; a < 8; a++) for (let b = 0; b < a; b++) AtA[a * 8 + b] = AtA[b * 8 + a];
      for (let a = 0; a < 8; a++) AtA[a * 8 + a] += 1e-9 * (AtA[a * 8 + a] + 1e-12);
      if (!solve8()) break;
      let step = 0;
      for (let k = 0; k < 8; k++) { Hn[k] += h[k]; step += Math.abs(h[k]); }
      if (step < 1e-12) break;
    }

    // denormalise: H = Td^-1 Hn Ts
    // Ts = [[ss 0 -ss scx],[0 ss -ss scy],[0 0 1]]; Td^-1 = [[1/ds 0 dcx],[0 1/ds dcy],[0 0 1]]
    tmp[0] = Hn[0] * ss; tmp[1] = Hn[1] * ss; tmp[2] = Hn[2] - ss * (Hn[0] * scx + Hn[1] * scy);
    tmp[3] = Hn[3] * ss; tmp[4] = Hn[4] * ss; tmp[5] = Hn[5] - ss * (Hn[3] * scx + Hn[4] * scy);
    tmp[6] = Hn[6] * ss; tmp[7] = Hn[7] * ss; tmp[8] = Hn[8] - ss * (Hn[6] * scx + Hn[7] * scy);
    const id = 1 / ds;
    for (let c = 0; c < 3; c++) {
      Hout[c] = tmp[c] * id + dcx * tmp[6 + c];
      Hout[3 + c] = tmp[3 + c] * id + dcy * tmp[6 + c];
      Hout[6 + c] = tmp[6 + c];
    }
    const nrm = Hout[8];
    if (Math.abs(nrm) > 1e-12) for (let k = 0; k < 9; k++) Hout[k] /= nrm;
    T[0] = scx; T[1] = scy; T[2] = ss; T[3] = dcx; T[4] = dcy; T[5] = ds;
    return rmsPx(Hout, sx, sy, dx, dy, idx, n);
  }

  function collinear4(sxA, syA, a, b, c) {
    const cr = (sxA[b] - sxA[a]) * (syA[c] - syA[a]) - (syA[b] - syA[a]) * (sxA[c] - sxA[a]);
    const l = Math.hypot(sxA[b] - sxA[a], syA[b] - syA[a]) * Math.hypot(sxA[c] - sxA[a], syA[c] - syA[a]);
    return !(Math.abs(cr) > 0.05 * l);
  }

  /**
   * Seeded RANSAC over `m` putative correspondences (some may be wrong).
   * @param {{ thresholdPx?: number, iterations?: number, seed?: number, huberPx?: number, minInliers?: number }} [opts]
   * @param {Uint8Array} [inlierOut] length >= m, filled with 1 for inliers
   * @returns {{ inliers: number, rms: number }} rms over the final inliers (-1 when no model found)
   */
  function ransac(sx, sy, dx, dy, m, Hout, opts = NO_OPTS, inlierOut = null) {
    const thr = opts.thresholdPx || 2;
    const maxIter = opts.iterations || 200;
    const minIn = opts.minInliers || 6;
    rng[0] = (opts.seed ?? 12345) >>> 0;
    ransacOpt.huberPx = opts.huberPx ?? 1;
    let best = 0;
    let bestHave = false;
    const thr2 = thr * thr;
    let need = maxIter;
    for (let it = 0; it < need && it < maxIter; it++) {
      for (let k = 0; k < 4; k++) {
        let v;
        let ok;
        do {
          v = (rnd() * m) | 0;
          ok = true;
          for (let q = 0; q < k; q++) if (sample[q] === v) ok = false;
        } while (!ok);
        sample[k] = v;
      }
      if (collinear4(sx, sy, sample[0], sample[1], sample[2]) || collinear4(sx, sy, sample[0], sample[1], sample[3]) ||
          collinear4(sx, sy, sample[0], sample[2], sample[3]) || collinear4(sx, sy, sample[1], sample[2], sample[3])) continue;
      if (fit(sx, sy, dx, dy, sample, 4, Hs, OPT_RAW) < 0) continue;
      let cnt = 0;
      for (let i = 0; i < m; i++) {
        const w = Hs[6] * sx[i] + Hs[7] * sy[i] + Hs[8];
        const u = (Hs[0] * sx[i] + Hs[1] * sy[i] + Hs[2]) / w - dx[i];
        const v = (Hs[3] * sx[i] + Hs[4] * sy[i] + Hs[5]) / w - dy[i];
        const ok = u * u + v * v <= thr2 ? 1 : 0;
        inl[i] = ok;
        cnt += ok;
      }
      if (cnt > best) {
        best = cnt;
        bestHave = true;
        for (let i = 0; i < m; i++) bestInl[i] = inl[i];
        // adaptive iteration count for 99% confidence
        const e = 1 - cnt / m;
        const pAll = Math.pow(1 - e, 4);
        if (pAll > 0.999999) need = it + 1;
        else if (pAll > 1e-9) need = Math.min(maxIter, Math.ceil(Math.log(0.01) / Math.log(1 - pAll)));
      }
    }
    if (!bestHave || best < minIn) { res.inliers = best; res.rms = -1; return res; }
    // refit on the inliers (Huber), re-collect, refit once more
    let rms = -1;
    for (let pass = 0; pass < 2; pass++) {
      let n = 0;
      for (let i = 0; i < m; i++) if (bestInl[i]) idxBuf[n++] = i;
      rms = fit(sx, sy, dx, dy, idxBuf, n, Hout, ransacOpt);
      if (rms < 0) { res.inliers = best; res.rms = -1; return res; }
      let cnt = 0;
      for (let i = 0; i < m; i++) {
        project(Hout, sx[i], sy[i], pj);
        const u = pj[0] - dx[i]; const v = pj[1] - dy[i];
        bestInl[i] = u * u + v * v <= thr2 ? 1 : 0;
        cnt += bestInl[i];
      }
      best = cnt;
    }
    let n = 0;
    for (let i = 0; i < m; i++) if (bestInl[i]) idxBuf[n++] = i;
    rms = n >= 4 ? rmsPx(Hout, sx, sy, dx, dy, idxBuf, n) : -1;
    if (inlierOut) for (let i = 0; i < m; i++) inlierOut[i] = bestInl[i];
    res.inliers = n;
    res.rms = rms;
    return res;
  }

  /** Least-squares affine map (6 dof, H row 3 = 0 0 1) from n correspondences; returns RMS px or -1. */
  function fitAffine(sx, sy, dx, dy, idx, n, Hout) {
    if (n < 3) return -1;
    let cx = 0; let cy = 0; let ux = 0; let uy = 0;
    for (let k = 0; k < n; k++) { const i = idx ? idx[k] : k; cx += sx[i]; cy += sy[i]; ux += dx[i]; uy += dy[i]; }
    cx /= n; cy /= n; ux /= n; uy /= n;
    let sxx = 0; let sxy = 0; let syy = 0; let a1 = 0; let a2 = 0; let b1 = 0; let b2 = 0;
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k;
      const x = sx[i] - cx; const y = sy[i] - cy;
      const u = dx[i] - ux; const v = dy[i] - uy;
      sxx += x * x; sxy += x * y; syy += y * y;
      a1 += x * u; a2 += y * u; b1 += x * v; b2 += y * v;
    }
    const det = sxx * syy - sxy * sxy;
    if (!(Math.abs(det) > 1e-9 * (sxx + syy) * (sxx + syy))) return -1;
    const id = 1 / det;
    const m00 = (a1 * syy - a2 * sxy) * id; const m01 = (a2 * sxx - a1 * sxy) * id;
    const m10 = (b1 * syy - b2 * sxy) * id; const m11 = (b2 * sxx - b1 * sxy) * id;
    Hout[0] = m00; Hout[1] = m01; Hout[2] = ux - m00 * cx - m01 * cy;
    Hout[3] = m10; Hout[4] = m11; Hout[5] = uy - m10 * cx - m11 * cy;
    Hout[6] = 0; Hout[7] = 0; Hout[8] = 1;
    return rmsPx(Hout, sx, sy, dx, dy, idx, n);
  }

  return { fit, fitAffine, ransac };
}
