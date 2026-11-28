/**
 * M3 — wall matcher (`src/ar/lattice.js`): turns detected dots (M2) into wall correspondences and a
 * wall->image homography, resolving the lattice-offset ambiguity of the periodic layouts.
 *
 * The model is the layout's dot list (`src/ar/layout.js`; inches, +x right, +y down). The matcher is
 * layout-agnostic: Tier B (dots along tote grid lines, an integer sub-lattice of the pitch/4 grid) and
 * Tier A (corners + label-offset dots) both work; nothing hard-codes the grid.
 *
 *  acquire (`match`)  seed on a detected dot and two non-collinear neighbours, hypothesise every model
 *                     dot with a non-collinear neighbour pair (orientation-consistent), score each by
 *                     the inliers of the local affine map, then grow the best few into full
 *                     homographies (project the model, match nearest detections, Huber fit, tighten);
 *  offset check       the periodic grid maps onto itself under a one-step shift, so a candidate is
 *                     also judged by SIZE: observed dot diameter vs `model diameter x local scale`
 *                     (landmarks are 1.25 / 1.5 / 2 x the standard dot). A shifted candidate puts
 *                     landmark dots on standard ones and fails by ~22% or more;
 *  track (`track`)    cheap re-fit from a prior homography (used by the M4 tracker).
 *
 * Zero allocation per call: every buffer is created once in `createWallMatcher`; the result object is
 * reused. Pure doubles for the geometry; no dependencies.
 */
import { createHomographySolver, invert3, jacobianScale, project, rmsPx } from './homography.js';

const CLASS_INDEX = { x1: 0, 'x1.25': 1, 'x1.5': 2, x2: 3 };
/** seed priority: larger-looking dots first, then closest to the frame centre (no closure per frame) */
function seedKey(dots, i, cx0, cy0) {
  return (dots.sizeClass ? -dots.sizeClass[i] * 1e6 : 0) + Math.hypot(dots.x[i] - cx0, dots.y[i] - cy0);
}

export const OFFSET_UNVERIFIED = 0;
export const OFFSET_OK = 1;
export const OFFSET_WRONG = 2;

/**
 * @param {{ layout: { dots: Array<{ x:number, y:number, diameterIn:number, sizeClass:string }> },
 *           maxDets?: number, seeds?: number, refineTop?: number }} cfg
 */
export function createWallMatcher(cfg) {
  const dotsIn = cfg.layout.dots;
  const NM = dotsIn.length;
  const maxDets = cfg.maxDets || 256;
  const NSEED = cfg.seeds || 6;
  const TOPK = cfg.refineTop || 12;
  const AFFINE_BELOW = 12; // matches needed before the homography replaces the local affine map
  const LOC = 12; // detections nearest the seed used to score a local hypothesis

  const mx = new Float64Array(NM);
  const my = new Float64Array(NM);
  const md = new Float64Array(NM);
  const mcls = new Uint8Array(NM);
  for (let i = 0; i < NM; i++) {
    mx[i] = dotsIn[i].x; my[i] = dotsIn[i].y; md[i] = dotsIn[i].diameterIn;
    mcls[i] = CLASS_INDEX[dotsIn[i].sizeClass] ?? 0;
  }

  // ---- model neighbour structure (construct-time allocation is fine) ----
  const NB = 6;
  const FIT_OPT = Object.freeze({ huberPx: 1.0, iters: 4 });
  const mnn = new Int32Array(NM * NB).fill(-1);
  let minNN = Infinity;
  for (let a = 0; a < NM; a++) {
    const d = [];
    for (let b = 0; b < NM; b++) if (b !== a) d.push([Math.hypot(mx[b] - mx[a], my[b] - my[a]), b]);
    d.sort((p, q) => p[0] - q[0]);
    for (let k = 0; k < NB && k < d.length; k++) mnn[a * NB + k] = d[k][1];
    if (d.length && d[0][0] < minNN) minNN = d[0][0];
  }
  // Orientation-free model pair list: (a, b, c) with b, c among a's neighbours and not collinear.
  const SIN_MIN = 0.45;
  const pairA = [];
  const pairB = [];
  const pairC = [];
  for (let a = 0; a < NM; a++) {
    for (let p = 0; p < NB; p++) {
      for (let q = p + 1; q < NB; q++) {
        const b = mnn[a * NB + p];
        const c = mnn[a * NB + q];
        if (b < 0 || c < 0) continue;
        const bx = mx[b] - mx[a]; const by = my[b] - my[a];
        const cx = mx[c] - mx[a]; const cy = my[c] - my[a];
        const s = Math.abs(bx * cy - by * cx) / (Math.hypot(bx, by) * Math.hypot(cx, cy));
        if (s >= SIN_MIN) { pairA.push(a); pairB.push(b); pairC.push(c); }
      }
    }
  }
  const NPAIR = pairA.length;
  const pA = Int32Array.from(pairA);
  const pB = Int32Array.from(pairB);
  const pC = Int32Array.from(pairC);
  // model spatial hash
  const CELL = Math.max(1e-3, minNN);
  let maxX = 0; let maxY = 0;
  for (let i = 0; i < NM; i++) { maxX = Math.max(maxX, mx[i]); maxY = Math.max(maxY, my[i]); }
  const GW = Math.floor(maxX / CELL) + 3;
  const GH = Math.floor(maxY / CELL) + 3;
  const cellStart = new Int32Array(GW * GH + 1);
  const cellItems = new Int32Array(NM);
  {
    const counts = new Int32Array(GW * GH);
    for (let i = 0; i < NM; i++) counts[Math.floor(my[i] / CELL + 1) * GW + Math.floor(mx[i] / CELL + 1)]++;
    for (let c = 0; c < GW * GH; c++) cellStart[c + 1] = cellStart[c] + counts[c];
    const fill = new Int32Array(GW * GH);
    for (let i = 0; i < NM; i++) {
      const c = Math.floor(my[i] / CELL + 1) * GW + Math.floor(mx[i] / CELL + 1);
      cellItems[cellStart[c] + fill[c]++] = i;
    }
  }

  // ---- scratch ----
  const solver = createHomographySolver(Math.max(NM, maxDets) + 8);
  const sx = new Float64Array(maxDets); // wall coords of matched pairs
  const sy = new Float64Array(maxDets);
  const dxp = new Float64Array(maxDets); // image coords of matched pairs
  const dyp = new Float64Array(maxDets);
  const pairDet = new Int32Array(maxDets);
  const pairModel = new Int32Array(maxDets);
  const detOwner = new Int32Array(maxDets); // model claimed per detection (growth)
  const detOwnerD = new Float64Array(maxDets);
  const seedOrder = new Int32Array(maxDets);
  const nn = new Int32Array(16);
  const nnD = new Float64Array(16);
  const Hcur = new Float64Array(9);
  const Htmp = new Float64Array(9);
  const Hstart2 = new Float64Array(9);
  const Htry = new Float64Array(9);
  const Hinv = new Float64Array(9);
  const pj = new Float64Array(2);
  const resBuf = new Float64Array(maxDets);
  const resSort = new Float64Array(maxDets);
  const keepIdx = new Int32Array(maxDets);
  const pairKeep = new Uint8Array(maxDets);
  const lr = new Float64Array(maxDets); // log size ratios
  const lrS = new Float64Array(maxDets);
  const candScore = new Float64Array(TOPK);
  const candHyp = new Int32Array(TOPK * 4); // seed, j, k, modelPair
  const candAff = new Float64Array(TOPK * 6);
  const candH = new Float64Array(TOPK * 9);
  const candIn = new Int32Array(TOPK);
  const candRms = new Float64Array(TOPK);
  const candSize = new Float64Array(TOPK);
  const candFit = new Float64Array(TOPK);
  const candAsg = new Int32Array(TOPK * maxDets);
  const bestAsg = new Int32Array(maxDets);
  // per-candidate views, created once (no subarray() per frame)
  const candAsgV = [];
  const candHV = [];
  for (let c = 0; c < TOPK; c++) {
    candAsgV.push(candAsg.subarray(c * maxDets, (c + 1) * maxDets));
    candHV.push(candH.subarray(c * 9, c * 9 + 9));
  }

  const result = {
    ok: false,
    inliers: 0,
    rmsPx: 0,
    H: new Float64Array(9), // wall (in) -> image (px)
    detToModel: new Int32Array(maxDets), // model dot per detection, -1 = none
    modelIds: dotsIn,
    landmarksSeen: 0,
    sizeRms: 0,
    offset: OFFSET_UNVERIFIED,
    ambiguous: false,
    hypotheses: 0,
    seedsTried: 0,
  };
  const det = { n: 0, x: null, y: null, d: null };

  // ------------------------------------------------------------------
  function nearestModel(x, y, tol) {
    const cx = Math.floor(x / CELL + 1);
    const cy = Math.floor(y / CELL + 1);
    let best = -1;
    let bd = tol * tol;
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      if (gy < 0 || gy >= GH) continue;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= GW) continue;
        const c = gy * GW + gx;
        for (let t = cellStart[c]; t < cellStart[c + 1]; t++) {
          const m = cellItems[t];
          const ex = mx[m] - x; const ey = my[m] - y;
          const d2 = ex * ex + ey * ey;
          if (d2 <= bd) { bd = d2; best = m; }
        }
      }
    }
    return best;
  }

  /** K nearest detections of `i` (K = 6) into nn / nnD; returns the count. */
  function nearestDets(i, xs, ys, n) {
    let m = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = xs[j] - xs[i]; const dy = ys[j] - ys[i];
      const d2 = dx * dx + dy * dy;
      if (m === LOC && d2 >= nnD[LOC - 1]) continue;
      let p = m < LOC ? m++ : LOC - 1;
      while (p > 0 && nnD[p - 1] > d2) { nnD[p] = nnD[p - 1]; nn[p] = nn[p - 1]; p--; }
      nnD[p] = d2;
      nn[p] = j;
    }
    return m;
  }

  /**
   * Growth: from H (wall->image) match model dots to detections, fit, tighten. Fills `asg` (detection ->
   * model, -1) and Hout; returns the inlier count (0 when it collapses).
   */
  function grow(xs, ys, n, Hstart, W, Hgt, iters, tolStart, asg, Hout, anchor, r0) {
    for (let k = 0; k < 9; k++) Hcur[k] = Hstart[k];
    let count = 0;
    let stable = 0;
    let radius2 = anchor >= 0 ? r0 * r0 : Infinity;
    for (let it = 0; it < iters; it++) {
      if (it >= iters - 3) radius2 = Infinity; // the last passes see the whole wall with the full homography
      // growth passes use a generous, per-dot tolerance (a fraction of the local dot spacing in px, which
      // varies a lot under perspective); the final passes tighten it
      const frac = it < iters - 2 ? tolStart : 0.12;
      for (let d = 0; d < n; d++) { detOwner[d] = -1; detOwnerD[d] = Infinity; }
      for (let m = 0; m < NM; m++) {
        if (radius2 !== Infinity) {
          const ex = mx[m] - mx[anchor]; const ey = my[m] - my[anchor];
          if (ex * ex + ey * ey > radius2) continue;
        }
        const w = Hcur[6] * mx[m] + Hcur[7] * my[m] + Hcur[8];
        if (w <= 1e-9) continue;
        const u = (Hcur[0] * mx[m] + Hcur[1] * my[m] + Hcur[2]) / w;
        const v = (Hcur[3] * mx[m] + Hcur[4] * my[m] + Hcur[5]) / w;
        const tol = Math.max(2.5, frac * minNN * Math.sqrt(jacobianScale(Hcur, mx[m], my[m])));
        if (u < -tol || u > W + tol || v < -tol || v > Hgt + tol) continue;
        let bd = tol * tol;
        let bj = -1;
        for (let d = 0; d < n; d++) {
          const ex = xs[d] - u; const ey = ys[d] - v;
          const d2 = ex * ex + ey * ey;
          if (d2 < bd) { bd = d2; bj = d; }
        }
        if (bj >= 0 && bd < detOwnerD[bj]) { detOwnerD[bj] = bd; detOwner[bj] = m; }
      }
      const prev = count;
      count = 0;
      for (let d = 0; d < n; d++) {
        if (detOwner[d] < 0) continue;
        const m = detOwner[d];
        sx[count] = mx[m]; sy[count] = my[m]; dxp[count] = xs[d]; dyp[count] = ys[d];
        pairDet[count] = d; pairModel[count] = m;
        count++;
      }
      if (count < 4) {
        if (radius2 === Infinity || it >= iters - 1) return 0;
        radius2 *= 2.2 * 2.2; // too little support yet: widen the region, keep the current map
        continue;
      }
      // a small, local patch constrains only an affine map (a homography fitted to a handful of nearly
      // collinear dots extrapolates wildly); the full homography takes over once the region is large
      const rms = count >= AFFINE_BELOW || radius2 === Infinity
        ? solver.fit(sx, sy, dxp, dyp, null, count, Htmp, FIT_OPT)
        : solver.fitAffine(sx, sy, dxp, dyp, null, count, Htmp);
      if (rms < 0 || !Number.isFinite(Htmp[0])) {
        if (radius2 === Infinity || it >= iters - 1) return 0;
        radius2 *= 2.2 * 2.2;
        continue;
      }
      // drop gross outliers one at a time (worst residual first) while that clearly improves the fit: a wrong
      // match biases the map and starves the next growth pass
      let curRms = rms;
      let kept = count;
      for (let q = 0; q < count; q++) pairKeep[q] = 1;
      for (let drop = 0; drop < 4 && curRms > 0.5 && kept >= 6; drop++) {
        let worst = -1; let wv = -1;
        for (let q = 0; q < count; q++) {
          if (!pairKeep[q]) continue;
          const w = Htmp[6] * sx[q] + Htmp[7] * sy[q] + Htmp[8];
          const eu = (Htmp[0] * sx[q] + Htmp[1] * sy[q] + Htmp[2]) / w - dxp[q];
          const ev = (Htmp[3] * sx[q] + Htmp[4] * sy[q] + Htmp[5]) / w - dyp[q];
          const r2 = eu * eu + ev * ev;
          if (r2 > wv) { wv = r2; worst = q; }
        }
        let kc = 0;
        for (let q = 0; q < count; q++) if (pairKeep[q] && q !== worst) keepIdx[kc++] = q;
        const r2 = kc >= AFFINE_BELOW || radius2 === Infinity
          ? solver.fit(sx, sy, dxp, dyp, keepIdx, kc, Htry, FIT_OPT)
          : solver.fitAffine(sx, sy, dxp, dyp, keepIdx, kc, Htry);
        if (r2 < 0 || !(r2 < 0.6 * curRms || r2 < 0.3)) break;
        pairKeep[worst] = 0; kept--; curRms = r2;
        for (let k = 0; k < 9; k++) Htmp[k] = Htry[k];
      }
      for (let k = 0; k < 9; k++) Hcur[k] = Htmp[k];
      if (count === prev && radius2 === Infinity) stable++; else stable = 0;
      if (radius2 !== Infinity) radius2 *= 1.8 * 1.8; // expand the region as the fit improves
      // converged early: jump straight to the final tight passes
      if (stable >= 1 && it < iters - 2) it = iters - 3;
    }
    for (let k = 0; k < 9; k++) Hout[k] = Hcur[k];
    for (let d = 0; d < n; d++) asg[d] = -1;
    let kept = 0;
    for (let q = 0; q < count; q++) if (pairKeep[q]) { asg[pairDet[q]] = pairModel[q]; kept++; }
    return kept;
  }

  /** log-size-ratio statistics for an assignment under H; sets result.landmarksSeen/sizeRms/offset. */
  function sizeCheck(xs, ys, ds, n, asg, H, minDiamPx) {
    let nStd = 0; let nAll = 0; let lms = 0;
    for (let d = 0; d < n; d++) {
      const m = asg[d];
      if (m < 0) continue;
      const obs = ds[d];
      const sc = Math.sqrt(jacobianScale(H, mx[m], my[m]));
      if (mcls[m] > 0) lms++;
      if (!(obs >= minDiamPx)) continue;
      const r = Math.log(obs / (md[m] * sc));
      lr[nAll++] = r;
      if (mcls[m] === 0) lrS[nStd++] = r;
    }
    // median of standard dots (or of all when none)
    const src = nStd > 0 ? lrS : lr;
    const cnt = nStd > 0 ? nStd : nAll;
    let med = 0;
    if (cnt > 0) {
      // insertion sort on a copy in place (small n)
      for (let a = 1; a < cnt; a++) { const v = src[a]; let b = a - 1; while (b >= 0 && src[b] > v) { src[b + 1] = src[b]; b--; } src[b + 1] = v; }
      med = cnt & 1 ? src[cnt >> 1] : 0.5 * (src[(cnt >> 1) - 1] + src[cnt >> 1]);
    }
    let ss = 0; let nl = 0; let worstLm = 0;
    for (let d = 0; d < n; d++) {
      const m = asg[d];
      if (m < 0 || !(ds[d] >= minDiamPx)) continue;
      const sc = Math.sqrt(jacobianScale(H, mx[m], my[m]));
      const e = Math.log(ds[d] / (md[m] * sc)) - med;
      ss += e * e; nl++;
      if (mcls[m] > 0 && Math.abs(e) > worstLm) worstLm = Math.abs(e);
    }
    const rms = nl > 0 ? Math.sqrt(ss / nl) : 0;
    result.landmarksSeen = lms;
    result.sizeRms = rms;
    let verdict = OFFSET_UNVERIFIED;
    // a landmark must be present AND measurable (>= minDiamPx) to judge the offset
    let measurable = 0;
    for (let d = 0; d < n; d++) if (asg[d] >= 0 && mcls[asg[d]] > 0 && ds[d] >= minDiamPx) measurable++;
    if (measurable > 0 && nl >= 3) verdict = rms <= 0.10 && worstLm <= 0.13 ? OFFSET_OK : OFFSET_WRONG;
    return verdict;
  }

  function countFinite(asg, n) {
    let c = 0;
    for (let d = 0; d < n; d++) if (asg[d] >= 0) c++;
    return c;
  }

  /**
   * Acquire: find the wall homography with no prior.
   * @param {{count:number, x:Float32Array, y:Float32Array, diameter:Float32Array, sizeClass?:Uint8Array}} dots M2 output
   * @param {{ width:number, height:number, minInliers?: number, minDiameterPx?: number,
   *           axisAngleDeg?: number, axisTolDeg?: number }} opts  axisAngleDeg = prior image angle of the wall +x axis
   *   (degrees, atan2(dv, du), image y down; e.g. from the gyro roll), resolving the 180-degree ambiguity;
   *   centerX/centerY/centerTolIn = prior wall point (inches) under the image centre, resolving the periodic
   *   whole-tote shifts when no landmark (origin x2 / axis x1.5) is in view
   */
  function match(dots, opts) {
    const n = Math.min(dots.count, maxDets);
    const xs = dots.x; const ys = dots.y;
    const W = opts.width; const Hgt = opts.height;
    const minInliers = opts.minInliers || 5;
    const minDiam = opts.minDiameterPx || 10;
    result.ok = false; result.inliers = 0; result.rmsPx = 0; result.landmarksSeen = 0; result.sizeRms = 0;
    result.offset = OFFSET_UNVERIFIED; result.ambiguous = false; result.hypotheses = 0; result.seedsTried = 0;
    for (let d = 0; d < maxDets; d++) result.detToModel[d] = -1;
    if (n < 4) return result;

    // seed order: bigger-looking dots first, then closest to the frame centre
    for (let i = 0; i < n; i++) seedOrder[i] = i;
    const cx0 = W * 0.5; const cy0 = Hgt * 0.5;
    // insertion sort of the first NSEED by key (selection, n is small)
    const nSeed = Math.min(NSEED, n);
    for (let s = 0; s < nSeed; s++) {
      let bi = s; let bk = seedKey(dots, seedOrder[s], cx0, cy0);
      for (let t = s + 1; t < n; t++) { const k = seedKey(dots, seedOrder[t], cx0, cy0); if (k < bk) { bk = k; bi = t; } }
      const tmp = seedOrder[s]; seedOrder[s] = seedOrder[bi]; seedOrder[bi] = tmp;
    }

    for (let c = 0; c < TOPK; c++) { candScore[c] = -1; candIn[c] = 0; }
    let hyps = 0;
    for (let s = 0; s < nSeed; s++) {
      const i = seedOrder[s];
      const m = nearestDets(i, xs, ys, n);
      if (m < 2) continue;
      result.seedsTried++;
      // up to 3 non-collinear detection pairs among the nearest neighbours, best = smallest distances
      let used = 0;
      for (let total = 0; total < 2 * NB && used < 3; total++) {
        // enumerate pairs in order of (p + q) growth: p<q
        let p = 0; let q = 1; let idx = 0;
        // map `total` to the k-th pair in lexicographic order of (p+q, p)
        let found = false;
        for (let sum = 1; sum <= 2 * NB - 3 && !found; sum++) {
          for (let pp = 0; pp < NB && !found; pp++) {
            const qq = sum - pp;
            if (qq <= pp || qq >= m || qq >= NB || pp >= m) continue;
            if (idx === total) { p = pp; q = qq; found = true; }
            idx++;
          }
        }
        if (!found) break;
        const j = nn[p]; const k = nn[q];
        const ax = xs[j] - xs[i]; const ay = ys[j] - ys[i];
        const bx = xs[k] - xs[i]; const by = ys[k] - ys[i];
        const cr = ax * by - ay * bx;
        if (Math.abs(cr) / (Math.hypot(ax, ay) * Math.hypot(bx, by)) < SIN_MIN) continue;
        used++;
        const detSign = cr > 0 ? 1 : -1;
        const iD = 1 / cr; // det of D = [[ax bx],[ay by]]
        // D^-1 = iD * [[by -bx],[-ay ax]]
        for (let pi = 0; pi < NPAIR; pi++) {
          const a = pA[pi];
          let b = pB[pi]; let c = pC[pi];
          let pxx = mx[b] - mx[a]; let pxy = my[b] - my[a];
          let qxx = mx[c] - mx[a]; let qxy = my[c] - my[a];
          const modSign = pxx * qxy - pxy * qxx > 0 ? 1 : -1;
          if (modSign !== detSign) { const t = b; b = c; c = t; pxx = mx[b] - mx[a]; pxy = my[b] - my[a]; qxx = mx[c] - mx[a]; qxy = my[c] - my[a]; }
          // ratio-of-ratios sanity (perspective keeps it within ~x2.5)
          const rr = (Math.hypot(ax, ay) / Math.hypot(bx, by)) / (Math.hypot(pxx, pxy) / Math.hypot(qxx, qxy));
          if (rr < 0.4 || rr > 2.5) continue;
          // Q = P D^-1 maps image offsets to wall offsets
          const q00 = (pxx * by - qxx * ay) * iD; const q01 = (-pxx * bx + qxx * ax) * iD;
          const q10 = (pxy * by - qxy * ay) * iD; const q11 = (-pxy * bx + qxy * ax) * iD;
          if (opts.centerX !== undefined) {
            const cwx = mx[a] + q00 * (W * 0.5 - xs[i]) + q01 * (Hgt * 0.5 - ys[i]);
            const cwy = my[a] + q10 * (W * 0.5 - xs[i]) + q11 * (Hgt * 0.5 - ys[i]);
            if (Math.hypot(cwx - opts.centerX, cwy - opts.centerY) > (opts.centerTolIn || 12) * 1.5) continue;
          }
          if (opts.axisAngleDeg !== undefined) {
            // image direction of the wall +x axis = column 0 of the affine map = inverse of Q: d/dx image = Q^-1 e1
            const dq = q00 * q11 - q01 * q10;
            let diffA = Math.atan2(-q10 / dq, q11 / dq) * (180 / Math.PI) - opts.axisAngleDeg;
            diffA -= 360 * Math.round(diffA / 360);
            if (Math.abs(diffA) > (opts.axisTolDeg || 25) * 1.5) continue;
          }
          const tol = 0.35 * minNN;
          let inl = 1;
          for (let t = 0; t < m; t++) {
            const d = nn[t];
            const ox = xs[d] - xs[i]; const oy = ys[d] - ys[i];
            const wx = mx[a] + q00 * ox + q01 * oy;
            const wy = my[a] + q10 * ox + q11 * oy;
            if (wx < -tol || wy < -tol || wx > maxX + tol || wy > maxY + tol) continue;
            const mm = nearestModel(wx, wy, tol);
            if (mm >= 0) inl++;
          }
          hyps++;
          if (inl < 4 || inl < (m + 1) * 0.5) continue;
          // keep TOPK by raw inlier count (replace worst)
          let w = 0;
          for (let c2 = 1; c2 < TOPK; c2++) if (candScore[c2] < candScore[w]) w = c2;
          if (inl > candScore[w]) {
            candScore[w] = inl;
            candHyp[w * 4] = i; candHyp[w * 4 + 1] = j; candHyp[w * 4 + 2] = k; candHyp[w * 4 + 3] = pi;
            // affine wall->image: image offset = D P^-1 (wall - a) ; store as H directly
            const iP = 1 / (pxx * qxy - qxx * pxy);
            // P^-1 = iP [[qxy -qxx],[-pxy pxx]]
            const m00 = (ax * qxy - bx * pxy) * iP; const m01 = (-ax * qxx + bx * pxx) * iP;
            const m10 = (ay * qxy - by * pxy) * iP; const m11 = (-ay * qxx + by * pxx) * iP;
            const o = w * 6;
            candAff[o] = m00; candAff[o + 1] = m01; candAff[o + 2] = xs[i] - m00 * mx[a] - m01 * my[a];
            candAff[o + 3] = m10; candAff[o + 4] = m11; candAff[o + 5] = ys[i] - m10 * mx[a] - m11 * my[a];
          }
        }
      }
    }
    result.hypotheses = hyps;

    // ---- refine each candidate into a full homography, keep the best by (inliers, size agreement) ----
    let best = -1; let bestFit = -1e9;
    let second = -1e9; let secondDiffers = false;
    for (let c = 0; c < TOPK; c++) {
      candIn[c] = 0;
      if (candScore[c] < 4) continue;
      const o = c * 6;
      Hcur[0] = candAff[o]; Hcur[1] = candAff[o + 1]; Hcur[2] = candAff[o + 2];
      Hcur[3] = candAff[o + 3]; Hcur[4] = candAff[o + 4]; Hcur[5] = candAff[o + 5];
      Hcur[6] = 0; Hcur[7] = 0; Hcur[8] = 1;
      const asg = candAsgV[c];
      let cnt = grow(xs, ys, n, Hcur, W, Hgt, 9, 0.35, asg, candHV[c], pA[candHyp[c * 4 + 3]], 1.8 * minNN);
      let cnt2 = cnt;
      if (cnt >= 5 && cnt < 0.8 * n) {
        // stalled on a local patch: a second, global pass from the improved map
        const Hc0 = candHV[c];
        for (let k = 0; k < 9; k++) Hstart2[k] = Hc0[k];
        const c3 = grow(xs, ys, n, Hstart2, W, Hgt, 6, 0.5, asg, Hc0, -1, 0);
        if (c3 >= cnt) cnt2 = c3;
      }
      cnt = cnt2;
      if (cnt < minInliers) continue;
      candIn[c] = cnt;
      const Hc = candHV[c];
      let rm = 0;
      for (let q = 0; q < cnt; q++) { /* rms recomputed below from asg */ }
      let nn2 = 0;
      for (let d = 0; d < n; d++) if (asg[d] >= 0) { sx[nn2] = mx[asg[d]]; sy[nn2] = my[asg[d]]; dxp[nn2] = xs[d]; dyp[nn2] = ys[d]; nn2++; }
      rm = rmsPx(Hc, sx, sy, dxp, dyp, null, nn2);
      candRms[c] = rm;
      const verdict = sizeCheck(xs, ys, dots.diameter, n, asg, Hc, minDiam);
      candSize[c] = result.sizeRms;
      let priorOk = true;
      if (opts.axisAngleDeg !== undefined) {
        // image direction of the wall +x axis at the centre of the matched dots
        let gx = 0; let gy = 0;
        for (let q2 = 0; q2 < nn2; q2++) { gx += sx[q2]; gy += sy[q2]; }
        gx /= nn2; gy /= nn2;
        const w = Hc[6] * gx + Hc[7] * gy + Hc[8];
        const nu = Hc[0] * gx + Hc[1] * gy + Hc[2];
        const nv = Hc[3] * gx + Hc[4] * gy + Hc[5];
        const dudx = (Hc[0] * w - nu * Hc[6]) / (w * w);
        const dvdx = (Hc[3] * w - nv * Hc[6]) / (w * w);
        let diff = Math.atan2(dvdx, dudx) * (180 / Math.PI) - opts.axisAngleDeg;
        diff -= 360 * Math.round(diff / 360);
        priorOk = Math.abs(diff) <= (opts.axisTolDeg || 25);
      }
      if (priorOk && opts.centerX !== undefined) {
        // wall point under the image centre must be near the prior (the stance the user stands at)
        if (!invert3(Hc, Hinv)) priorOk = false;
        else {
          project(Hinv, W * 0.5, Hgt * 0.5, pj);
          priorOk = Math.hypot(pj[0] - opts.centerX, pj[1] - opts.centerY) <= (opts.centerTolIn || 12);
        }
      }
      // fitness: inliers, minus a hard penalty when the landmark sizes contradict the offset
      const fitv = cnt - (verdict === OFFSET_WRONG ? 1000 : 0) - (priorOk ? 0 : 1000) - rm;
      candFit[c] = fitv;
      if (fitv > bestFit) { second = bestFit; bestFit = fitv; best = c; } else if (fitv > second) second = fitv;
    }
    if (best < 0) return result;
    const asg = candAsgV[best];
    const Hb = candHV[best];
    for (let k = 0; k < 9; k++) result.H[k] = Hb[k];
    for (let d = 0; d < n; d++) result.detToModel[d] = asg[d];
    result.inliers = candIn[best];
    result.rmsPx = candRms[best];
    result.offset = sizeCheck(xs, ys, dots.diameter, n, asg, Hb, minDiam);
    // ambiguity: another candidate that maps differently with (nearly) the same support
    result.ambiguous = false;
    for (let c = 0; c < TOPK; c++) {
      if (c === best || candIn[c] < minInliers) continue;
      if (candIn[c] >= candIn[best] - 1 && candFit[c] > -500) {
        // same assignment?
        const a2 = candAsgV[c];
        let diff = 0;
        for (let d = 0; d < n; d++) if (a2[d] !== asg[d]) diff++;
        if (diff > 1) { result.ambiguous = true; break; }
      }
    }
    // quality gates: a plausible fit explains most detections tightly (a stalled local patch does not)
    result.ok = result.offset !== OFFSET_WRONG && result.inliers >= minInliers && !result.ambiguous && candFit[best] > -500 &&
      result.rmsPx <= (opts.maxRmsPx || 1.0) && result.inliers >= (opts.minFraction || 0.5) * n;
    return result;
  }

  /**
   * Re-fit from a prior homography (no hypotheses).
   * @param {Float64Array} Hprior wall->image
   */
  function track(dots, Hprior, opts) {
    const n = Math.min(dots.count, maxDets);
    const minInliers = opts.minInliers || 5;
    result.ok = false; result.inliers = 0; result.rmsPx = 0; result.ambiguous = false; result.hypotheses = 0;
    for (let d = 0; d < maxDets; d++) result.detToModel[d] = -1;
    const cnt = grow(dots.x, dots.y, n, Hprior, opts.width, opts.height, 5, opts.tolFrac || 0.25, bestAsg, Htmp, -1, 0);
    if (cnt < minInliers) return result;
    for (let k = 0; k < 9; k++) result.H[k] = Htmp[k];
    let q = 0;
    for (let d = 0; d < n; d++) {
      result.detToModel[d] = bestAsg[d];
      if (bestAsg[d] >= 0) { sx[q] = mx[bestAsg[d]]; sy[q] = my[bestAsg[d]]; dxp[q] = dots.x[d]; dyp[q] = dots.y[d]; q++; }
    }
    result.inliers = cnt;
    result.rmsPx = rmsPx(result.H, sx, sy, dxp, dyp, null, q);
    result.offset = sizeCheck(dots.x, dots.y, dots.diameter, n, bestAsg, result.H, opts.minDiameterPx || 10);
    result.ok = result.offset !== OFFSET_WRONG;
    return result;
  }

  /**
   * Judge an externally supplied assignment (detection -> model dot, -1 none): fit H, size check.
   * Used by tests to prove a one-step-shifted labelling is rejected.
   */
  function evaluate(dots, asg, opts) {
    const n = Math.min(dots.count, maxDets);
    let q = 0;
    for (let d = 0; d < n; d++) {
      if (asg[d] < 0) continue;
      sx[q] = mx[asg[d]]; sy[q] = my[asg[d]]; dxp[q] = dots.x[d]; dyp[q] = dots.y[d]; q++;
    }
    result.landmarksSeen = 0; result.sizeRms = 0;
    if (q < 4) { result.offset = OFFSET_UNVERIFIED; result.inliers = q; return result; }
    const rms = solver.fit(sx, sy, dxp, dyp, null, q, Htmp, FIT_OPT);
    for (let k = 0; k < 9; k++) result.H[k] = Htmp[k];
    result.inliers = q;
    result.rmsPx = rms;
    result.offset = sizeCheck(dots.x, dots.y, dots.diameter, n, asg, Htmp, opts && opts.minDiameterPx ? opts.minDiameterPx : 10);
    return result;
  }

  return {
    match, track, evaluate, result, model: { x: mx, y: my, diameterIn: md, sizeClass: mcls, count: NM, minSpacingIn: minNN, pairs: NPAIR },
    nearestModel,
  };
}
