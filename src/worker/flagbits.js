/**
 * H3 — Single Source of Truth for Worker Feature-Flag Bitmasks (`src/worker/flagbits.js`).
 *
 * Pure constants only (no UI/DOM/localStorage dependencies) so both `src/flags.js`
 * and dedicated Web Workers (`src/worker/*.js`) import the exact same 32-bit integer
 * bit definitions cleanly. Hot loops check `(state.flags & FLAG_*) !== 0` with zero allocations.
 */

export const FLAG_VERT_FALLBACK = 1 << 0;          // W1
export const FLAG_EXTRA_LINES = 1 << 1;            // W2
export const FLAG_CRIB_MATCH = 1 << 2;             // W3
export const FLAG_REQUIRE_PREFIX = 1 << 3;         // W4
export const FLAG_REQUIRE_PREFIX_STRICT = 1 << 4;  // W4 (exclusive strict mode)
export const FLAG_PREFIX_STACK = 1 << 5;           // W5
export const FLAG_ILLUM_NORM = 1 << 6;             // W6
export const FLAG_SUBPIX_EDGES = 1 << 7;           // W7
export const FLAG_SCAN_SMOOTH = 1 << 8;            // W8
export const FLAG_ROI_SMALL_CODES = 1 << 9;        // W9
export const FLAG_VERTICAL_MODE = 1 << 10;         // W10
export const FLAG_DEBLUR_1D = 1 << 11;             // W12
export const FLAG_FLOW_ON = 1 << 12;               // W13
export const FLAG_STOP_GUARD = 1 << 13;            // F1
export const FLAG_DECODE_ANCHOR = 1 << 14;         // B8

export const WORKER_FLAG_BITS = Object.freeze({
  vertFallback:        FLAG_VERT_FALLBACK,
  extraLines:          FLAG_EXTRA_LINES,
  cribMatch:           FLAG_CRIB_MATCH,
  requirePrefix:       FLAG_REQUIRE_PREFIX,
  requirePrefixStrict: FLAG_REQUIRE_PREFIX_STRICT,
  prefixStack:         FLAG_PREFIX_STACK,
  illumNorm:           FLAG_ILLUM_NORM,
  subpixEdges:         FLAG_SUBPIX_EDGES,
  scanSmooth:          FLAG_SCAN_SMOOTH,
  roiSmallCodes:       FLAG_ROI_SMALL_CODES,
  verticalMode:        FLAG_VERTICAL_MODE,
  deblur1d:            FLAG_DEBLUR_1D,
  flowOn:              FLAG_FLOW_ON,
  stopGuard:           FLAG_STOP_GUARD,
  decodeAnchor:        FLAG_DECODE_ANCHOR,
});
