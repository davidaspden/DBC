/**
 * K6 — 8x8 Separable DCT & JPEG-Style Luma Quantization Compression
 * (`src/sim/camera-model/compress.js`).
 *
 * Pure-JS 8x8 DCT -> JPEG luminance quantization (scaled by `quality` in [1, 100])
 * -> 8x8 IDCT on 8-bit luma frames, using pre-allocated cosine and scratch typed arrays
 * for zero hot-loop allocations.
 *
 * Gated by `enabled` / `simCompress` (default OFF).
 */

export const DEFAULT_COMPRESS_CONFIG = Object.freeze({
  enabled: false,
  quality: 85, // JPEG quality in [1, 100]
});

// Standard ITU-T T.81 (Annex K.1) 8x8 luminance quantization matrix (Q=50)
export const JPEG_LUMA_Q50 = new Int32Array([
  16, 11, 10, 16,  24,  40,  51,  61,
  12, 12, 14, 19,  26,  58,  60,  55,
  14, 13, 16, 24,  40,  57,  69,  56,
  14, 17, 22, 29,  51,  87,  80,  62,
  18, 22, 37, 56,  68, 109, 103,  77,
  24, 35, 55, 64,  81, 104, 113,  92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103,  99,
]);

// Shared immutable 8x8 orthonormal DCT-II basis matrix C[u * 8 + x]
const DCT_COS = new Float32Array(64);
{
  const invSqrt8 = Math.sqrt(1.0 / 8.0);
  const sqrt2Over8 = Math.sqrt(2.0 / 8.0);
  for (let u = 0; u < 8; u++) {
    const alpha = u === 0 ? invSqrt8 : sqrt2Over8;
    for (let x = 0; x < 8; x++) {
      DCT_COS[u * 8 + x] = alpha * Math.cos(((2 * x + 1) * u * Math.PI) / 16.0);
    }
  }
}

/**
 * Populates a 64-entry IJG-scaled quantization table (`Float32Array`) for `quality` in [1, 100].
 *
 * @param {number} quality
 * @param {Float32Array} outTable
 */
export function buildQuantTable(quality, outTable) {
  const q = quality < 1 ? 1 : (quality > 100 ? 100 : quality);
  const scale = q < 50 ? (5000.0 / q) : (200.0 - 2.0 * q);
  for (let i = 0; i < 64; i++) {
    let val = Math.floor((JPEG_LUMA_Q50[i] * scale + 50.0) / 100.0);
    if (val < 1) val = 1;
    else if (val > 255) val = 255;
    outTable[i] = val;
  }
  return outTable;
}

/**
 * Computes Peak Signal-to-Noise Ratio (dB) between two `Uint8Array` luma frames.
 * Returns `Infinity` for bit-identical frames.
 *
 * @param {Uint8Array} ref
 * @param {Uint8Array} test
 * @param {number} [len]
 * @returns {number}
 */
export function computePsnr(ref, test, len = ref.length) {
  let mseSum = 0;
  for (let i = 0; i < len; i++) {
    const d = ref[i] - test[i];
    mseSum += d * d;
  }
  if (mseSum === 0) return Infinity;
  const mse = mseSum / len;
  return 10.0 * Math.log10((255.0 * 255.0) / mse);
}

/**
 * Creates a reusable, zero-allocation DCT/JPEG compression state.
 *
 * @param {Partial<typeof DEFAULT_COMPRESS_CONFIG>} [config]
 */
export function createCompressState(config = {}) {
  const quality = config.quality ?? DEFAULT_COMPRESS_CONFIG.quality;
  const quantTable = new Float32Array(64);
  const invQuantTable = new Float32Array(64);
  buildQuantTable(quality, quantTable);
  for (let i = 0; i < 64; i++) invQuantTable[i] = 1.0 / quantTable[i];

  return {
    enabled: Boolean(config.enabled ?? DEFAULT_COMPRESS_CONFIG.enabled),
    quality,
    _cachedQuality: quality,

    // Pre-allocated scratch buffers (zero hot-loop alloc)
    cosTable: DCT_COS,
    quantTable,
    invQuantTable,
    blockIn: new Float32Array(64),
    blockTmp: new Float32Array(64),
    blockDct: new Float32Array(64),
  };
}

/**
 * Applies 8x8 separable DCT + JPEG luminance quantization + IDCT to `src` (`Uint8Array`)
 * and writes the reconstructed frame into `out`. Supports in-place (`out === src`) and
 * zero heap allocations.
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof createCompressState>} state
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function applyCompression(src, width, height, state, out = src) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);

  if (!state || !state.enabled) {
    if (out !== src) {
      for (let i = 0; i < n; i++) out[i] = src[i];
    }
    return out;
  }

  if (state._cachedQuality !== state.quality) {
    buildQuantTable(state.quality, state.quantTable);
    for (let i = 0; i < 64; i++) state.invQuantTable[i] = 1.0 / state.quantTable[i];
    state._cachedQuality = state.quality;
  }

  const C = state.cosTable;
  const Q = state.quantTable;
  const invQ = state.invQuantTable;
  const bIn = state.blockIn;
  const bTmp = state.blockTmp;
  const bDct = state.blockDct;
  const wm1 = w - 1;
  const hm1 = h - 1;

  for (let by = 0; by < h; by += 8) {
    const maxY = by + 8 <= h ? 8 : (h - by);
    for (let bx = 0; bx < w; bx += 8) {
      const maxX = bx + 8 <= w ? 8 : (w - bx);

      // 1) Load 8x8 level-shifted block ([-128, 127]), edge-replicating partial border blocks
      for (let y = 0; y < 8; y++) {
        const sy = by + y <= hm1 ? (by + y) : hm1;
        const srcRow = Math.imul(sy, w);
        const dstRow = y << 3;
        for (let x = 0; x < 8; x++) {
          const sx = bx + x <= wm1 ? (bx + x) : wm1;
          bIn[dstRow + x] = src[srcRow + sx] - 128.0;
        }
      }

      // 2) Forward 1D DCT on rows: bTmp = bIn * C^T
      for (let y = 0; y < 8; y++) {
        const rOff = y << 3;
        const r0 = bIn[rOff], r1 = bIn[rOff + 1], r2 = bIn[rOff + 2], r3 = bIn[rOff + 3];
        const r4 = bIn[rOff + 4], r5 = bIn[rOff + 5], r6 = bIn[rOff + 6], r7 = bIn[rOff + 7];
        for (let u = 0; u < 8; u++) {
          const cOff = u << 3;
          bTmp[rOff + u] =
            r0 * C[cOff] + r1 * C[cOff + 1] + r2 * C[cOff + 2] + r3 * C[cOff + 3] +
            r4 * C[cOff + 4] + r5 * C[cOff + 5] + r6 * C[cOff + 6] + r7 * C[cOff + 7];
        }
      }

      // 3) Forward 1D DCT on cols + Quantize + Dequantize: bDct = round((C * bTmp) / Q) * Q
      for (let u = 0; u < 8; u++) {
        const c0 = bTmp[u], c1 = bTmp[8 + u], c2 = bTmp[16 + u], c3 = bTmp[24 + u];
        const c4 = bTmp[32 + u], c5 = bTmp[40 + u], c6 = bTmp[48 + u], c7 = bTmp[56 + u];
        for (let v = 0; v < 8; v++) {
          const cOff = v << 3;
          const coeff =
            c0 * C[cOff] + c1 * C[cOff + 1] + c2 * C[cOff + 2] + c3 * C[cOff + 3] +
            c4 * C[cOff + 4] + c5 * C[cOff + 5] + c6 * C[cOff + 6] + c7 * C[cOff + 7];
          const qIdx = (v << 3) + u;
          const qVal = Math.round(coeff * invQ[qIdx]);
          bDct[qIdx] = qVal * Q[qIdx];
        }
      }

      // 4) Inverse 1D DCT on cols: bTmp = C^T * bDct
      for (let u = 0; u < 8; u++) {
        const d0 = bDct[u], d1 = bDct[8 + u], d2 = bDct[16 + u], d3 = bDct[24 + u];
        const d4 = bDct[32 + u], d5 = bDct[40 + u], d6 = bDct[48 + u], d7 = bDct[56 + u];
        for (let y = 0; y < 8; y++) {
          bTmp[(y << 3) + u] =
            d0 * C[y] + d1 * C[8 + y] + d2 * C[16 + y] + d3 * C[24 + y] +
            d4 * C[32 + y] + d5 * C[40 + y] + d6 * C[48 + y] + d7 * C[56 + y];
        }
      }

      // 5) Inverse 1D DCT on rows + shift +128 + clamp to [0, 255]
      for (let y = 0; y < maxY; y++) {
        const rOff = y << 3;
        const t0 = bTmp[rOff], t1 = bTmp[rOff + 1], t2 = bTmp[rOff + 2], t3 = bTmp[rOff + 3];
        const t4 = bTmp[rOff + 4], t5 = bTmp[rOff + 5], t6 = bTmp[rOff + 6], t7 = bTmp[rOff + 7];
        const outRow = Math.imul(by + y, w) + bx;
        for (let x = 0; x < maxX; x++) {
          const val =
            t0 * C[x] + t1 * C[8 + x] + t2 * C[16 + x] + t3 * C[24 + x] +
            t4 * C[32 + x] + t5 * C[40 + x] + t6 * C[48 + x] + t7 * C[56 + x] + 128.5;
          const u8 = val | 0;
          out[outRow + x] = u8 < 0 ? 0 : (u8 > 255 ? 255 : u8);
        }
      }
    }
  }

  return out;
}
