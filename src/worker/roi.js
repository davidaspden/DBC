/**
 * Stage 1: Fast RoI & Angle Estimation (Target: 2–4 ms, Hard Gate: < 5 ms, Angle Error <= ±3°).
 *
 * Pipeline:
 *  1. Adaptive integer box downsample:
 *       - 4x4 box (1280x720 -> 320x180) for HD frames (max dim >= 960), suppressing aliased
 *         1-module waves while preserving unaliased 2–4 module energy at true bar angle.
 *       - 2x2 box (640x480 -> 320x240) for lower-res VGA feeds so narrow 1.7 px bars survive.
 *  2. Fused 3x3 Scharr gradient (Gx, Gy) + 8x8 block 2D Structure Tensor accumulation
 *     (Jxx, Jyy, Jxy) + bipolarity & active-edge counting in pure 32-bit integer arithmetic.
 *  3. Orientation-consistent 8-connected component clustering (zero-allocation BFS) retaining
 *     the Top-K (K=4) highest-coherence candidate clusters so printed text paragraphs or
 *     packaging crimp ridges never mask a real barcode.
 *  4. Coherence-weighted Structure Tensor angle extraction (theta in [0, 180) deg) and
 *     full-resolution RoI bounding box + oriented extent projection.
 *
 * Zero-Allocation Guarantee:
 *  All TypedArrays and Top-K cluster tables are allocated once in `createRoiState()`.
 *  `estimateRoi()` performs strictly zero heap allocations per frame.
 */

const BLOCK_SHIFT = 3; // 8x8 downsampled blocks
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export const MAX_ROI_CLUSTERS = 24;
export const FLAG_ROI_SMALL_CODES = 1 << 9;

/**
 * Default RoI confidence threshold separating real barcode clusters from background clutter.
 */
export const ROI_CONFIDENCE_THRESHOLD = 0.55;

function createRoiSubState(width, height, dsShift, cropX0, cropY0, minClusterBlocks, minActivePixels, minTrace) {
  const dsW = width >> dsShift;
  const dsH = height >> dsShift;
  const gridW = dsW >> BLOCK_SHIFT;
  const gridH = dsH >> BLOCK_SHIFT;
  const gridSize = gridW * gridH;

  return {
    width: width | 0,
    height: height | 0,
    dsShift: dsShift | 0,
    activeShift: dsShift | 0,
    dsW: dsW | 0,
    dsH: dsH | 0,
    gridW: gridW | 0,
    gridH: gridH | 0,
    gridSize: gridSize | 0,
    cropX0: cropX0 | 0,
    cropY0: cropY0 | 0,
    flags: 0,
    noRoiStreak: 0,
    minClusterBlocks: minClusterBlocks | 0,
    minActivePixels: minActivePixels | 0,
    minTrace: minTrace | 0,
    minCoherence: 0.56,
    minBipolarity: 0.26,

    // Downsampled luma buffer (320x180 = 57,600 B for 720p; 320x240 = 76,800 B for VGA)
    downsampled: new Uint8Array(dsW * dsH),

    // Per-block 2D Structure Tensor accumulators (Int32 safe: max ~2.66e8 << 2.14e9)
    blockJxx: new Int32Array(gridSize),
    blockJyy: new Int32Array(gridSize),
    blockJxy: new Int32Array(gridSize),

    // Per-block normalized features & BFS state
    blockCoherence: new Float32Array(gridSize),
    blockScore: new Float32Array(gridSize),
    blockDirCos2: new Float32Array(gridSize),
    blockDirSin2: new Float32Array(gridSize),
    blockState: new Uint8Array(gridSize),

    // Zero-allocation BFS queue & cell scratch
    queue: new Int32Array(gridSize),
    curCells: new Int32Array(gridSize),
    bestCells: new Int32Array(gridSize),
    bestCellCount: 0,

    // Pre-allocated Top-K candidate cluster table (sorted descending by rank score)
    clusterCount: 0,
    clusterRankScore: new Float32Array(MAX_ROI_CLUSTERS),
    clusterX: new Int32Array(MAX_ROI_CLUSTERS),
    clusterY: new Int32Array(MAX_ROI_CLUSTERS),
    clusterW: new Int32Array(MAX_ROI_CLUSTERS),
    clusterH: new Int32Array(MAX_ROI_CLUSTERS),
    clusterCenterX: new Float32Array(MAX_ROI_CLUSTERS),
    clusterCenterY: new Float32Array(MAX_ROI_CLUSTERS),
    clusterMajorLen: new Float32Array(MAX_ROI_CLUSTERS),
    clusterMinorLen: new Float32Array(MAX_ROI_CLUSTERS),
    clusterThetaDeg: new Float32Array(MAX_ROI_CLUSTERS),
    clusterConfidence: new Float32Array(MAX_ROI_CLUSTERS),
    small2x: null,
  };
}

/**
 * Pre-allocates all Stage 1 buffers once for a given frame resolution.
 * @param {number} width  Full-res luma width (default 1280)
 * @param {number} height Full-res luma height (default 720)
 */
export function createRoiState(width = 1280, height = 720) {
  const dsShift = (width >= 960 || height >= 960) ? 2 : 1; // 4x for 720p+, 2x for VGA
  const state = createRoiSubState(width, height, dsShift, 0, 0, 8, 22, 14000);
  if (dsShift === 2) {
    // W9 (`roiSmallCodes`): pre-allocate center 60% 2x pass once (zero hot-loop allocations)
    const cw = Math.max(64, ((width * 0.6) | 0) & ~15);
    const ch = Math.max(64, ((height * 0.6) | 0) & ~15);
    const cx0 = ((width - cw) >> 1) & ~1;
    const cy0 = ((height - ch) >> 1) & ~1;
    state.small2x = createRoiSubState(cw, ch, 1, cx0, cy0, 6, 18, 10000);
    state.small2x.minCoherence = 0.52;
    state.small2x.minBipolarity = 0.24;
  }
  return state;
}

/**
 * Pass 1a: 4x4 integer box downscaler (1280x720 -> 320x180).
 */
function downsample4x(luma, width, state) {
  const dsW = state.dsW | 0;
  const dsH = state.dsH | 0;
  const dst = state.downsampled;
  const w = width | 0;
  const w2 = (w << 1) | 0;
  const w3 = (w2 + w) | 0;

  let dstIdx = 0;
  for (let dy = 0; dy < dsH; dy++) {
    const row0 = Math.imul(dy << 2, w);
    const row1 = (row0 + w) | 0;
    const row2 = (row0 + w2) | 0;
    const row3 = (row0 + w3) | 0;
    for (let dx = 0; dx < dsW; dx++) {
      const sx = dx << 2;
      const sum =
        (luma[row0 + sx] + luma[row0 + sx + 1] + luma[row0 + sx + 2] + luma[row0 + sx + 3] +
         luma[row1 + sx] + luma[row1 + sx + 1] + luma[row1 + sx + 2] + luma[row1 + sx + 3] +
         luma[row2 + sx] + luma[row2 + sx + 1] + luma[row2 + sx + 2] + luma[row2 + sx + 3] +
         luma[row3 + sx] + luma[row3 + sx + 1] + luma[row3 + sx + 2] + luma[row3 + sx + 3]) | 0;
      dst[dstIdx++] = (sum + 8) >> 4;
    }
  }
}

/**
 * Pass 1b: 2x2 integer box downscaler (640x480 -> 320x240) for lower-resolution feeds.
 */
function downsample2x(luma, width, state) {
  const dsW = state.dsW | 0;
  const dsH = state.dsH | 0;
  const dst = state.downsampled;
  const w = width | 0;

  let dstIdx = 0;
  for (let dy = 0; dy < dsH; dy++) {
    const row0 = Math.imul(dy << 1, w);
    const row1 = (row0 + w) | 0;
    for (let dx = 0; dx < dsW; dx++) {
      const sx = dx << 1;
      const sum = (luma[row0 + sx] + luma[row0 + sx + 1] + luma[row1 + sx] + luma[row1 + sx + 1]) | 0;
      dst[dstIdx++] = (sum + 2) >> 2;
    }
  }
}

/**
 * Pass 1c (W9): 2x2 integer box downscaler over a cropped center region `(cropX0, cropY0)`.
 */
function downsample2xRegion(luma, fullWidth, cropX0, cropY0, subState) {
  const dsW = subState.dsW | 0;
  const dsH = subState.dsH | 0;
  const dst = subState.downsampled;
  const w = fullWidth | 0;
  const x0 = cropX0 | 0;
  const y0 = cropY0 | 0;

  let dstIdx = 0;
  for (let dy = 0; dy < dsH; dy++) {
    const row0 = (Math.imul((y0 + (dy << 1)) | 0, w) + x0) | 0;
    const row1 = (row0 + w) | 0;
    for (let dx = 0; dx < dsW; dx++) {
      const sx = dx << 1;
      const sum = (luma[row0 + sx] + luma[row0 + sx + 1] + luma[row1 + sx] + luma[row1 + sx + 1]) | 0;
      dst[dstIdx++] = (sum + 2) >> 2;
    }
  }
}

/**
 * Pass 2: Fused 3x3 Scharr gradient & 8x8 block 2D Structure Tensor evaluation.
 */
function computeBlockTensors(state) {
  const img = state.downsampled;
  const dsW = state.dsW | 0;
  const dsH = state.dsH | 0;
  const gridW = state.gridW | 0;
  const gridH = state.gridH | 0;

  const blockJxx = state.blockJxx;
  const blockJyy = state.blockJyy;
  const blockJxy = state.blockJxy;
  const blockCoherence = state.blockCoherence;
  const blockScore = state.blockScore;
  const blockDirCos2 = state.blockDirCos2;
  const blockDirSin2 = state.blockDirSin2;
  const blockState = state.blockState;

  const maxX = (dsW - 2) | 0;
  const maxY = (dsH - 2) | 0;

  const MIN_EDGE_MAG = 28;
  const MIN_ACTIVE_PIXELS = state.minActivePixels | 0;
  const MIN_TRACE = state.minTrace | 0;
  const MIN_COHERENCE = state.minCoherence;
  const MIN_BIPOLARITY = state.minBipolarity;

  let bIdx = 0;
  for (let by = 0; by < gridH; by++) {
    let y0 = (by << BLOCK_SHIFT) | 0;
    let y1 = (y0 + BLOCK_SIZE) | 0;
    if (y0 < 1) y0 = 1;
    if (y1 > maxY + 1) y1 = (maxY + 1) | 0;

    for (let bx = 0; bx < gridW; bx++, bIdx++) {
      let x0 = (bx << BLOCK_SHIFT) | 0;
      let x1 = (x0 + BLOCK_SIZE) | 0;
      if (x0 < 1) x0 = 1;
      if (x1 > maxX + 1) x1 = (maxX + 1) | 0;

      let jxx = 0;
      let jyy = 0;
      let jxy = 0;
      let sumGx = 0;
      let sumGy = 0;
      let sumAbsGx = 0;
      let sumAbsGy = 0;
      let activePx = 0;

      for (let y = y0; y < y1; y++) {
        const rPrev = Math.imul(y - 1, dsW);
        const rCurr = (rPrev + dsW) | 0;
        const rNext = (rCurr + dsW) | 0;

        for (let x = x0; x < x1; x++) {
          const xm = (x - 1) | 0;
          const xp = (x + 1) | 0;

          const tl = img[rPrev + xm];
          const tc = img[rPrev + x];
          const tr = img[rPrev + xp];
          const ml = img[rCurr + xm];
          const mr = img[rCurr + xp];
          const bl = img[rNext + xm];
          const bc = img[rNext + x];
          const br = img[rNext + xp];

          const gx = (Math.imul(3, (tr + br - tl - bl) | 0) + Math.imul(10, (mr - ml) | 0)) >> 1;
          const gy = (Math.imul(3, (bl + br - tl - tr) | 0) + Math.imul(10, (bc - tc) | 0)) >> 1;

          const absGx = gx < 0 ? -gx : gx;
          const absGy = gy < 0 ? -gy : gy;
          if (((absGx + absGy) | 0) >= MIN_EDGE_MAG) {
            activePx = (activePx + 1) | 0;
          }

          jxx = (jxx + Math.imul(gx, gx)) | 0;
          jyy = (jyy + Math.imul(gy, gy)) | 0;
          jxy = (jxy + Math.imul(gx, gy)) | 0;
          sumGx = (sumGx + gx) | 0;
          sumGy = (sumGy + gy) | 0;
          sumAbsGx = (sumAbsGx + absGx) | 0;
          sumAbsGy = (sumAbsGy + absGy) | 0;
        }
      }

      blockJxx[bIdx] = jxx;
      blockJyy[bIdx] = jyy;
      blockJxy[bIdx] = jxy;

      const trace = jxx + jyy;
      if (trace < MIN_TRACE || activePx < MIN_ACTIVE_PIXELS) {
        blockCoherence[bIdx] = 0;
        blockScore[bIdx] = 0;
        blockState[bIdx] = 0;
        continue;
      }

      const diff = jxx - jyy;
      const twoJxy = 2.0 * jxy;
      const mag = Math.sqrt(diff * diff + twoJxy * twoJxy);
      const coherence = mag / trace;

      const absSumG = (sumGx < 0 ? -sumGx : sumGx) + (sumGy < 0 ? -sumGy : sumGy);
      const sumAbsG = sumAbsGx + sumAbsGy;
      const bipolarity = sumAbsG > 0 ? 1.0 - absSumG / sumAbsG : 0.0;

      blockCoherence[bIdx] = coherence;

      if (coherence >= MIN_COHERENCE && bipolarity >= MIN_BIPOLARITY && mag > 1e-6) {
        const invMag = 1.0 / mag;
        blockDirCos2[bIdx] = diff * invMag;
        blockDirSin2[bIdx] = twoJxy * invMag;

        // Strong coh^4 exponent favors razor-sharp parallel barcode bars (C ~ 0.95)
        // over multi-line text paragraphs (C ~ 0.65-0.78).
        const c2 = coherence * coherence;
        const fill = activePx * (1.0 / 64.0);
        const energyWeight = Math.log(1.0 + trace * 1e-5);
        blockScore[bIdx] = c2 * c2 * bipolarity * fill * energyWeight;
        blockState[bIdx] = 1;
      } else {
        blockScore[bIdx] = 0;
        blockState[bIdx] = 0;
      }
    }
  }
}

/**
 * Copies candidate cluster slot `clusterIdx` from `roiState` into `result` in-place.
 */
export function selectRoiCluster(roiState, clusterIdx, result) {
  result.roiX = roiState.clusterX[clusterIdx];
  result.roiY = roiState.clusterY[clusterIdx];
  result.roiW = roiState.clusterW[clusterIdx];
  result.roiH = roiState.clusterH[clusterIdx];
  result.roiCenterX = roiState.clusterCenterX[clusterIdx];
  result.roiCenterY = roiState.clusterCenterY[clusterIdx];
  result.roiMajorLen = roiState.clusterMajorLen[clusterIdx];
  result.roiMinorLen = roiState.clusterMinorLen[clusterIdx];
  result.thetaDeg = roiState.clusterThetaDeg[clusterIdx];
  result.roiConfidence = roiState.clusterConfidence[clusterIdx];
}

/**
 * Pass 3 & 4: Orientation-consistent 8-connected BFS clustering retaining Top-K clusters
 * sorted by barcode-likeness rank score, and coherence-weighted angle estimation.
 */
function extractTopClusters(state, result) {
  const gridW = state.gridW | 0;
  const gridH = state.gridH | 0;
  const gridSize = state.gridSize | 0;
  const fullW = state.width | 0;
  const fullH = state.height | 0;
  const blockPx = BLOCK_SIZE << state.dsShift; // 32 px for 4x, 16 px for 2x
  const padPx = state.dsShift === 2 ? 24 : 16;

  const blockJxx = state.blockJxx;
  const blockJyy = state.blockJyy;
  const blockJxy = state.blockJxy;
  const blockCoherence = state.blockCoherence;
  const blockScore = state.blockScore;
  const blockDirCos2 = state.blockDirCos2;
  const blockDirSin2 = state.blockDirSin2;
  const blockState = state.blockState;
  const queue = state.queue;
  const curCells = state.curCells;
  const bestCells = state.bestCells;

  const clusterRankScore = state.clusterRankScore;
  const clusterX = state.clusterX;
  const clusterY = state.clusterY;
  const clusterW = state.clusterW;
  const clusterH = state.clusterH;
  const clusterCenterX = state.clusterCenterX;
  const clusterCenterY = state.clusterCenterY;
  const clusterMajorLen = state.clusterMajorLen;
  const clusterMinorLen = state.clusterMinorLen;
  const clusterThetaDeg = state.clusterThetaDeg;
  const clusterConfidence = state.clusterConfidence;

  // Tighter orientation consistency (±20° -> cos(40°) ≈ 0.766) prevents barcode clusters
  // from bleeding into adjacent perpendicular text or packaging crimp lines.
  const ORIENT_DOT_MIN = 0.76;
  const MIN_CLUSTER_BLOCKS = state.minClusterBlocks | 0;

  let clusterCount = 0;
  state.bestCellCount = 0;

  for (let start = 0; start < gridSize; start++) {
    if (blockState[start] !== 1) continue;

    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = start;
    blockState[start] = 2;

    let cellCount = 0;
    let totalScore = 0;
    let minBx = gridW;
    let maxBx = 0;
    let minBy = gridH;
    let maxBy = 0;

    let sumCos2 = 0;
    let sumSin2 = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sumCx = 0;
    let sumCy = 0;
    let weightSum = 0;

    while (qHead < qTail) {
      const idx = queue[qHead++];
      curCells[cellCount++] = idx;

      const by = (idx / gridW) | 0;
      const bx = (idx - Math.imul(by, gridW)) | 0;
      if (bx < minBx) minBx = bx;
      if (bx > maxBx) maxBx = bx;
      if (by < minBy) minBy = by;
      if (by > maxBy) maxBy = by;

      const sc = blockScore[idx];
      const coh = blockCoherence[idx];
      totalScore += sc;
      sumCos2 += blockDirCos2[idx] * sc;
      sumSin2 += blockDirSin2[idx] * sc;

      const angW = coh * coh * coh;
      sxx += blockJxx[idx] * angW;
      syy += blockJyy[idx] * angW;
      sxy += blockJxy[idx] * angW;

      sumCx += (bx + 0.5) * sc;
      sumCy += (by + 0.5) * sc;
      weightSum += sc;

      const refMag = Math.sqrt(sumCos2 * sumCos2 + sumSin2 * sumSin2);
      const refCos2 = refMag > 1e-6 ? sumCos2 / refMag : blockDirCos2[idx];
      const refSin2 = refMag > 1e-6 ? sumSin2 / refMag : blockDirSin2[idx];

      const ny0 = by > 0 ? by - 1 : 0;
      const ny1 = by < gridH - 1 ? by + 1 : gridH - 1;
      const nx0 = bx > 0 ? bx - 1 : 0;
      const nx1 = bx < gridW - 1 ? bx + 1 : gridW - 1;

      for (let ny = ny0; ny <= ny1; ny++) {
        const rowOff = Math.imul(ny, gridW);
        for (let nx = nx0; nx <= nx1; nx++) {
          const nIdx = (rowOff + nx) | 0;
          if (blockState[nIdx] !== 1) continue;
          const dot = blockDirCos2[nIdx] * refCos2 + blockDirSin2[nIdx] * refSin2;
          if (dot >= ORIENT_DOT_MIN) {
            blockState[nIdx] = 2;
            queue[qTail++] = nIdx;
          }
        }
      }
    }

    if (cellCount < MIN_CLUSTER_BLOCKS || weightSum <= 0) continue;

    // Evaluate cluster coherence & quality-weighted rank score
    const diff = sxx - syy;
    const twoSxy = 2.0 * sxy;
    const trace = sxx + syy;
    const clusterCoherence = trace > 1e-6 ? Math.sqrt(diff * diff + twoSxy * twoSxy) / trace : 0;
    const meanBlockScore = totalScore / cellCount;
    const scoreFactor = totalScore / (totalScore + 2.8);
    const confidence = clusterCoherence * scoreFactor;

    if (confidence < ROI_CONFIDENCE_THRESHOLD) continue;

    // Rank score favors high-coherence dense barcode clusters over sprawling mediocre text blocks
    const c2 = clusterCoherence * clusterCoherence;
    const rankScore = totalScore * c2 * (0.4 + meanBlockScore);

    // Check if cluster enters Top-K table (insertion sort into fixed size MAX_ROI_CLUSTERS)
    let insertPos = -1;
    if (clusterCount < MAX_ROI_CLUSTERS) {
      insertPos = clusterCount;
      clusterCount++;
    } else if (rankScore > clusterRankScore[MAX_ROI_CLUSTERS - 1]) {
      insertPos = MAX_ROI_CLUSTERS - 1;
    }
    if (insertPos < 0) continue;

    while (insertPos > 0 && rankScore > clusterRankScore[insertPos - 1]) {
      const prev = insertPos - 1;
      clusterRankScore[insertPos] = clusterRankScore[prev];
      clusterX[insertPos] = clusterX[prev];
      clusterY[insertPos] = clusterY[prev];
      clusterW[insertPos] = clusterW[prev];
      clusterH[insertPos] = clusterH[prev];
      clusterCenterX[insertPos] = clusterCenterX[prev];
      clusterCenterY[insertPos] = clusterCenterY[prev];
      clusterMajorLen[insertPos] = clusterMajorLen[prev];
      clusterMinorLen[insertPos] = clusterMinorLen[prev];
      clusterThetaDeg[insertPos] = clusterThetaDeg[prev];
      clusterConfidence[insertPos] = clusterConfidence[prev];
      insertPos = prev;
    }

    let thetaDeg = 0.5 * Math.atan2(twoSxy, diff) * RAD_TO_DEG;
    if (thetaDeg < 0) thetaDeg += 180.0;
    if (thetaDeg >= 180.0) thetaDeg -= 180.0;

    let rx0 = Math.imul(minBx, blockPx) - padPx;
    let ry0 = Math.imul(minBy, blockPx) - padPx;
    let rx1 = Math.imul(maxBx + 1, blockPx) + padPx;
    let ry1 = Math.imul(maxBy + 1, blockPx) + padPx;
    if (rx0 < 0) rx0 = 0;
    if (ry0 < 0) ry0 = 0;
    if (rx1 > fullW) rx1 = fullW;
    if (ry1 > fullH) ry1 = fullH;

    const cx = (sumCx / weightSum) * blockPx;
    const cy = (sumCy / weightSum) * blockPx;

    const rad = thetaDeg * DEG_TO_RAD;
    const cosT = Math.cos(rad);
    const sinT = Math.sin(rad);
    let minU = 1e9;
    let maxU = -1e9;
    let minV = 1e9;
    let maxV = -1e9;
    for (let i = 0; i < cellCount; i++) {
      const cIdx = curCells[i];
      const by = (cIdx / gridW) | 0;
      const bx = (cIdx - Math.imul(by, gridW)) | 0;
      const px = (bx + 0.5) * blockPx - cx;
      const py = (by + 0.5) * blockPx - cy;
      const u = px * cosT + py * sinT;
      const v = -px * sinT + py * cosT;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    clusterRankScore[insertPos] = rankScore;
    clusterX[insertPos] = (rx0 + state.cropX0) | 0;
    clusterY[insertPos] = (ry0 + state.cropY0) | 0;
    clusterW[insertPos] = (rx1 - rx0) | 0;
    clusterH[insertPos] = (ry1 - ry0) | 0;
    clusterCenterX[insertPos] = cx + state.cropX0;
    clusterCenterY[insertPos] = cy + state.cropY0;
    clusterMajorLen[insertPos] = (maxU - minU) + blockPx + padPx * 2;
    clusterMinorLen[insertPos] = (maxV - minV) + blockPx;
    clusterThetaDeg[insertPos] = thetaDeg;
    clusterConfidence[insertPos] = confidence;

    if (insertPos === 0) {
      state.bestCellCount = cellCount;
      for (let i = 0; i < cellCount; i++) {
        bestCells[i] = curCells[i];
      }
    }
  }

  state.clusterCount = clusterCount;

  if (clusterCount === 0) {
    result.roiX = 0;
    result.roiY = 0;
    result.roiW = 0;
    result.roiH = 0;
    result.roiCenterX = 0;
    result.roiCenterY = 0;
    result.roiMajorLen = 0;
    result.roiMinorLen = 0;
    result.roiConfidence = 0;
    result.thetaDeg = 0;
    return 0;
  }

  selectRoiCluster(state, 0, result);
  return 1;
}

/**
 * Executes Stage 1 (Fast RoI & Angle Estimation) in-place with zero heap allocations.
 * Populates Top-K candidate clusters in `state` and writes the top cluster into `result`.
 */
export function estimateRoi(luma, width, height, state, result) {
  if (state.dsShift === 2) {
    downsample4x(luma, width, state);
  } else {
    downsample2x(luma, width, state);
  }
  state.activeShift = state.dsShift;
  computeBlockTensors(state);
  const found = extractTopClusters(state, result);
  if (found === 1) {
    state.noRoiStreak = 0;
    return 1;
  }

  // W9 (flagged `roiSmallCodes`): after 3 consecutive frames with no 4x ROI, alternate a
  // pre-allocated 2x center-60% pass (MIN_CLUSTER_BLOCKS = 6) to catch small/far labels.
  if ((state.flags & FLAG_ROI_SMALL_CODES) !== 0 && state.small2x !== null) {
    state.noRoiStreak = (state.noRoiStreak + 1) | 0;
    if (state.noRoiStreak >= 3 && (state.noRoiStreak & 1) === 1) {
      const sub = state.small2x;
      downsample2xRegion(luma, width, sub.cropX0, sub.cropY0, sub);
      computeBlockTensors(sub);
      const subFound = extractTopClusters(sub, result);
      if (subFound === 1) {
        const cnt = sub.clusterCount | 0;
        state.clusterCount = cnt;
        for (let i = 0; i < cnt; i++) {
          state.clusterRankScore[i] = sub.clusterRankScore[i];
          state.clusterX[i] = sub.clusterX[i];
          state.clusterY[i] = sub.clusterY[i];
          state.clusterW[i] = sub.clusterW[i];
          state.clusterH[i] = sub.clusterH[i];
          state.clusterCenterX[i] = sub.clusterCenterX[i];
          state.clusterCenterY[i] = sub.clusterCenterY[i];
          state.clusterMajorLen[i] = sub.clusterMajorLen[i];
          state.clusterMinorLen[i] = sub.clusterMinorLen[i];
          state.clusterThetaDeg[i] = sub.clusterThetaDeg[i];
          state.clusterConfidence[i] = sub.clusterConfidence[i];
        }
        state.activeShift = 1;
        return 1;
      }
    }
  }
  return 0;
}
