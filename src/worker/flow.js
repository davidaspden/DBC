/**
 * W13 — Downsampled Block-Matching Optical Flow (`src/worker/flow.js`).
 *
 * Operates directly on Stage 1's already-downsampled luma buffer (`state.roi.downsampled`,
 * e.g. 320×180 at 720p/4x or 480×270 at 1080p/4x) behind the `flowOn` feature flag.
 *
 * Design (Zero-Allocation, Pure 32-Bit Integer SAD):
 *  - 3×3 grid of 32×32 downsampled-pixel tiles (9 tiles max).
 *  - Texture gate: rejects flat tiles whose subsampled mean |Gx|+|Gy| < TEXTURE_MIN.
 *  - Coarse-to-fine block matching around predicted shift `(predDxDs, predDyDs)` ± 6 ds-px:
 *      1. Coarse search (step 2 ds-px, 7×7 = 49 candidates) using 2×2 subsampled SAD.
 *      2. Fine search (±1 ds-px around coarse winner, 3×3 = 9 candidates).
 *      3. Parabolic sub-pixel refinement in Q8 (1/256 ds-px) along X and Y.
 *  - Quality gate: `(secondBestSAD - bestSAD) / (bestSAD + eps)` rejecting ambiguous/aperture tiles.
 *  - Robust median shift across accepted tiles, scaled by `(1 << dsShift)` to full-res pixels.
 */

const TILE_GRID = 3;
const MAX_TILES = TILE_GRID * TILE_GRID; // 9
const TILE_SIZE = 32;
const SEARCH_RADIUS = 6;
const TEXTURE_MIN_SUM = 1600; // ~6.25 mean |grad| over 256 subsampled pixels
const MIN_QUAL_Q8 = 22;       // ~0.086 second-best peak margin

/**
 * Pre-allocates all optical flow buffers once for `(dsW, dsH)`.
 */
export function createFlowState(dsW = 320, dsH = 180) {
  const w = dsW | 0;
  const h = dsH | 0;
  return {
    dsW: w,
    dsH: h,
    hasPrev: 0,
    prevLuma: new Uint8Array(w * h),

    // Pre-allocated per-tile results (Q8 ds-px) & scratch sort buffers
    tileDxQ8: new Int32Array(MAX_TILES),
    tileDyQ8: new Int32Array(MAX_TILES),
    tileQualQ8: new Int32Array(MAX_TILES),
    sortBuf: new Int32Array(MAX_TILES),

    // Latest frame output (mutated in-place, zero allocations)
    dxFullPx: 0,
    dyFullPx: 0,
    conf: 0,
    tilesAccepted: 0,
    tilesTried: 0,
    tFlowMs: 0,
  };
}

/**
 * Clears previous frame history (call on camera reset or dimension change).
 */
export function resetFlowState(flowState) {
  flowState.hasPrev = 0;
  flowState.dxFullPx = 0;
  flowState.dyFullPx = 0;
  flowState.conf = 0;
  flowState.tilesAccepted = 0;
  flowState.tilesTried = 0;
  flowState.tFlowMs = 0;
}

/**
 * Evaluates 2×2-subsampled integer SAD of a 32×32 tile at `(tx, ty)` in `prev`
 * against `(tx + sx, ty + sy)` in `cur`.
 */
function tileSadSub2(prev, cur, dsW, tx, ty, sx, sy) {
  const w = dsW | 0;
  const w2 = w << 1;
  let pRow = (Math.imul(ty, w) + tx) | 0;
  let cRow = (Math.imul((ty + sy) | 0, w) + ((tx + sx) | 0)) | 0;
  let sad = 0;
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 32; c += 2) {
      const d = (prev[(pRow + c) | 0] - cur[(cRow + c) | 0]) | 0;
      sad = (sad + (d < 0 ? -d : d)) | 0;
    }
    pRow = (pRow + w2) | 0;
    cRow = (cRow + w2) | 0;
  }
  return sad | 0;
}

/**
 * Insertion-sort median over `n` integers in `src[0..n-1]` using scratch `buf`.
 */
function medianInt(src, n, buf) {
  for (let i = 0; i < n; i++) buf[i] = src[i];
  for (let i = 1; i < n; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  const mid = n >> 1;
  if ((n & 1) === 1) return buf[mid] | 0;
  return ((buf[mid - 1] + buf[mid]) >> 1) | 0;
}

/**
 * Computes inter-frame translation `(dxFullPx, dyFullPx)` in full-resolution pixels
 * between `flowState.prevLuma` and `curDsLuma` with strictly zero allocations.
 *
 * Positive `dxFullPx` / `dyFullPx` means image content moved right / down from prev to cur.
 *
 * @returns {number} 1 if valid flow estimate produced, 0 otherwise
 */
export function computeOpticalFlow(
  curDsLuma,
  dsW,
  dsH,
  dsShift,
  predDxDs,
  predDyDs,
  flowState,
  measure = false
) {
  const t0 = measure ? performance.now() : 0;
  const w = dsW | 0;
  const h = dsH | 0;
  const nPx = Math.imul(w, h);
  const prev = flowState.prevLuma;

  if (flowState.dsW !== w || flowState.dsH !== h || prev.length < nPx) {
    flowState.dxFullPx = 0;
    flowState.dyFullPx = 0;
    flowState.conf = 0;
    flowState.tilesAccepted = 0;
    flowState.tilesTried = 0;
    flowState.tFlowMs = 0;
    return 0;
  }

  if (flowState.hasPrev === 0) {
    prev.set(curDsLuma.length === nPx ? curDsLuma : curDsLuma.subarray(0, nPx));
    flowState.hasPrev = 1;
    flowState.dxFullPx = 0;
    flowState.dyFullPx = 0;
    flowState.conf = 0;
    flowState.tilesAccepted = 0;
    flowState.tilesTried = 0;
    flowState.tFlowMs = measure ? performance.now() - t0 : 0;
    return 0;
  }

  // Clamp predicted shift so search window stays safely inside frame
  const maxPredX = Math.max(0, ((w - TILE_SIZE) >> 1) - SEARCH_RADIUS - 2) | 0;
  const maxPredY = Math.max(0, ((h - TILE_SIZE) >> 1) - SEARCH_RADIUS - 2) | 0;
  let px0 = Math.round(predDxDs || 0) | 0;
  let py0 = Math.round(predDyDs || 0) | 0;
  if (px0 < -maxPredX) px0 = -maxPredX;
  else if (px0 > maxPredX) px0 = maxPredX;
  if (py0 < -maxPredY) py0 = -maxPredY;
  else if (py0 > maxPredY) py0 = maxPredY;

  // Tile bounds guaranteeing (tx + sx) in [0 .. w - TILE_SIZE] and (ty + sy) in [0 .. h - TILE_SIZE]
  const minTx = Math.max(2, (SEARCH_RADIUS + 2 - px0)) | 0;
  const maxTx = Math.min(w - TILE_SIZE - 2, (w - TILE_SIZE - SEARCH_RADIUS - 2 - px0)) | 0;
  const minTy = Math.max(2, (SEARCH_RADIUS + 2 - py0)) | 0;
  const maxTy = Math.min(h - TILE_SIZE - 2, (h - TILE_SIZE - SEARCH_RADIUS - 2 - py0)) | 0;

  if (maxTx < minTx || maxTy < minTy) {
    prev.set(curDsLuma.length === nPx ? curDsLuma : curDsLuma.subarray(0, nPx));
    flowState.dxFullPx = 0;
    flowState.dyFullPx = 0;
    flowState.conf = 0;
    flowState.tilesAccepted = 0;
    flowState.tilesTried = 0;
    flowState.tFlowMs = measure ? performance.now() - t0 : 0;
    return 0;
  }

  const tileDxQ8 = flowState.tileDxQ8;
  const tileDyQ8 = flowState.tileDyQ8;
  const tileQualQ8 = flowState.tileQualQ8;
  let tried = 0;
  let accepted = 0;
  let qualSumQ8 = 0;

  const spanX = (maxTx - minTx) | 0;
  const spanY = (maxTy - minTy) | 0;

  for (let gy = 0; gy < TILE_GRID; gy++) {
    const ty = (minTy + ((Math.imul(spanY, (gy << 1) + 1) / (TILE_GRID << 1)) | 0)) | 0;
    for (let gx = 0; gx < TILE_GRID; gx++) {
      const tx = (minTx + ((Math.imul(spanX, (gx << 1) + 1) / (TILE_GRID << 1)) | 0)) | 0;

      // Texture check on prev tile (2x2 subsampled |Gx| + |Gy|)
      let texSum = 0;
      const w2 = w << 1;
      let pRow = (Math.imul(ty, w) + tx) | 0;
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 30; c += 2) {
          const v = prev[(pRow + c) | 0];
          const dx = (prev[(pRow + c + 2) | 0] - v) | 0;
          const dy = (prev[(pRow + w2 + c) | 0] - v) | 0;
          texSum = (texSum + (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)) | 0;
        }
        pRow = (pRow + w2) | 0;
      }
      if (texSum < TEXTURE_MIN_SUM) continue;
      tried++;

      // Stage 1: Coarse search (step 2 ds-px) in [-SEARCH_RADIUS .. +SEARCH_RADIUS]
      let bestSad = 0x7fffffff;
      let secondSad = 0x7fffffff;
      let bestSx = px0;
      let bestSy = py0;

      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 2) {
        const sy = (py0 + dy) | 0;
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 2) {
          const sx = (px0 + dx) | 0;
          const sad = tileSadSub2(prev, curDsLuma, w, tx, ty, sx, sy);
          if (sad < bestSad) {
            bestSad = sad;
            bestSx = sx;
            bestSy = sy;
          }
        }
      }

      // Stage 2: Fine search (±1 ds-px around coarse winner)
      const cSx = bestSx;
      const cSy = bestSy;
      for (let dy = -1; dy <= 1; dy++) {
        const sy = (cSy + dy) | 0;
        if (sy < py0 - SEARCH_RADIUS || sy > py0 + SEARCH_RADIUS) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const sx = (cSx + dx) | 0;
          if (sx < px0 - SEARCH_RADIUS || sx > px0 + SEARCH_RADIUS) continue;
          const sad = tileSadSub2(prev, curDsLuma, w, tx, ty, sx, sy);
          if (sad < bestSad) {
            bestSad = sad;
            bestSx = sx;
            bestSy = sy;
          }
        }
      }

      // Second-best SAD at least 2 ds-px away from best peak (avoids counting same trough)
      for (let dy = -SEARCH_RADIUS; dy <= SEARCH_RADIUS; dy += 2) {
        const sy = (py0 + dy) | 0;
        const ady = sy > bestSy ? (sy - bestSy) : (bestSy - sy);
        for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; dx += 2) {
          const sx = (px0 + dx) | 0;
          const adx = sx > bestSx ? (sx - bestSx) : (bestSx - sx);
          if (adx < 2 && ady < 2) continue;
          const sad = tileSadSub2(prev, curDsLuma, w, tx, ty, sx, sy);
          if (sad < secondSad) secondSad = sad;
        }
      }

      const margin = (secondSad - bestSad) | 0;
      const qualQ8 = margin > 0 ? (((margin << 8) / (bestSad + 256)) | 0) : 0;
      if (qualQ8 < MIN_QUAL_Q8) continue;

      // Stage 3: Parabolic sub-pixel refinement in Q8 along X and Y
      let fracXQ8 = 0;
      if (bestSx > px0 - SEARCH_RADIUS && bestSx < px0 + SEARCH_RADIUS) {
        const sadL = tileSadSub2(prev, curDsLuma, w, tx, ty, bestSx - 1, bestSy);
        const sadR = tileSadSub2(prev, curDsLuma, w, tx, ty, bestSx + 1, bestSy);
        const denomX = (sadL - (bestSad << 1) + sadR) | 0;
        if (denomX > 0) {
          fracXQ8 = (((sadL - sadR) << 7) / denomX) | 0;
          if (fracXQ8 < -128) fracXQ8 = -128;
          else if (fracXQ8 > 128) fracXQ8 = 128;
        }
      }

      let fracYQ8 = 0;
      if (bestSy > py0 - SEARCH_RADIUS && bestSy < py0 + SEARCH_RADIUS) {
        const sadU = tileSadSub2(prev, curDsLuma, w, tx, ty, bestSx, bestSy - 1);
        const sadD = tileSadSub2(prev, curDsLuma, w, tx, ty, bestSx, bestSy + 1);
        const denomY = (sadU - (bestSad << 1) + sadD) | 0;
        if (denomY > 0) {
          fracYQ8 = (((sadU - sadD) << 7) / denomY) | 0;
          if (fracYQ8 < -128) fracYQ8 = -128;
          else if (fracYQ8 > 128) fracYQ8 = 128;
        }
      }

      tileDxQ8[accepted] = ((bestSx << 8) + fracXQ8) | 0;
      tileDyQ8[accepted] = ((bestSy << 8) + fracYQ8) | 0;
      tileQualQ8[accepted] = qualQ8;
      qualSumQ8 = (qualSumQ8 + qualQ8) | 0;
      accepted++;
    }
  }

  // Always update prevLuma in-place without allocating
  for (let i = 0; i < nPx; i++) prev[i] = curDsLuma[i];

  flowState.tilesTried = tried;
  flowState.tilesAccepted = accepted;

  if (accepted > 0) {
    const medDxQ8 = medianInt(tileDxQ8, accepted, flowState.sortBuf);
    const medDyQ8 = medianInt(tileDyQ8, accepted, flowState.sortBuf);
    const scale = 1 << (dsShift | 0);
    flowState.dxFullPx = (medDxQ8 * scale) / 256;
    flowState.dyFullPx = (medDyQ8 * scale) / 256;

    const acceptFrac = tried > 0 ? accepted / tried : 0;
    const meanQual = Math.min(1, (qualSumQ8 / accepted) / 256);
    flowState.conf = acceptFrac * meanQual;
    flowState.tFlowMs = measure ? performance.now() - t0 : 0;
    return 1;
  }

  flowState.dxFullPx = 0;
  flowState.dyFullPx = 0;
  flowState.conf = 0;
  flowState.tFlowMs = measure ? performance.now() - t0 : 0;
  return 0;
}
