# Zero-Alloc Buffer Strategies for DBC Enhancements
## Keeping the Hot Path Allocation-Free

**Context**: All Stage 1–5 buffers are allocated once in `create*State()` and reused. Hot loops (`processFrame`, extractors, consensus) perform zero heap allocations and minimise V8 HeapNumber float boxing. New features (module estimate, blur edges, matched filter, soft DP, multi-scale tensor) must follow the same discipline.

---

## Core Patterns Already in Use

| Pattern | Example | Why |
|---------|---------|-----|
| Flat TypedArray banks | `lumaBank: new Uint8Array(MAX_SCANLINES * MAX_SCANLINE_LEN)` | Index as `line * MAX + i`; no per-line objects |
| Scratch reuse | `avgLumaBuf`, `scratchLuma`, `deriv`, `absDeriv`, `localEnv` | Overwrite in place; dual-use where safe |
| Fixed-point integers | Q8 run widths, Q16 line steps, Q10 confidences | Avoids float boxing in inner loops |
| Pre-sized worst-case | `MAX_RUNS`, `MAX_SCANLINES`, `MAX_CODE128_SYMBOLS` | Bounds are known; no growth |
| State object holds everything | `createScanlineState()`, `createConsensusState()`, `createRoiSubState()` | Single allocation site; worker lifetime |

**Rule**: If a new algorithm needs temporary storage, add the buffer to the relevant `create*State()` and never `new` inside the per-frame / per-scanline path.

---

## Task-by-Task Buffer Plans

### Task 1 – Module-Width Autocorrelation
**State**: `createScanlineState()`

```js
// Add:
corrLags: new Int32Array(64),          // or 48; fixed lag count
moduleWidthQ8: 0,                      // scalar result
modulePeakStrength: 0,                 // scalar
```

- Compute autocorrelation into `corrLags` (overwrite each call).
- No extra buffers needed if you accumulate on the fly from `absDeriv` or `lumaBank`.
- Optional: a second small `Int32Array` only if you want a normalised copy; usually unnecessary.

**Hot-path rule**: One pass to fill `corrLags`, one pass to find peak. Both pure integer.

---

### Task 2 – Blur-Resilient Edge Fusion
**State**: `createScanlineState()`

Reuse existing:
- `deriv`, `absDeriv`, `localEnv` (already sized to `MAX_SCANLINE_LEN`)
- `edgePosQ8`, `edgePol`, `edgeMag` (sized to `MAX_RUNS + 2`)

Add only if fusion needs a third edge list:

```js
// Optional third edge bank (only if you keep all three before merging)
edgePosQ8B: new Int32Array(MAX_RUNS + 2),
edgePolB: new Int8Array(MAX_RUNS + 2),
edgeCountB: 0,
```

**Preferred approach**: Generate the LoG / second-derivative edges directly into the existing `edgePosQ8` after a first pass, or merge on the fly while scanning. Avoid a full third copy if possible.

**Scratch**: `scratchLuma` is already available for any temporary filtered signal.

---

### Task 3 – Matched-Filter Templates
**State**: `createScanlineState()` or a small dedicated object inside it

Templates are static (or generated once from `moduleWidthQ8`):

```js
// Pre-allocated template bank (fixed max template length)
templateBank: new Int16Array(8 * 64),   // e.g. 8 templates × 64 samples
templateLens: new Uint8Array(8),
templateCount: 0,
```

Correlation scratch (per scanline, overwrite):

```js
corrScratch: new Int32Array(MAX_SCANLINE_LEN),  // or smaller window if you only search near ends
```

- Generate or select templates once when module width is known (still outside the inner sample loop).
- Correlate into `corrScratch`; find peaks with a simple scan.
- Start/stop hits can be stored as a few scalars (`startPosQ8`, `stopPosQ8`, `startScore`, `stopScore`) on the state.

**Economy**: Only allocate the template bank once; correlation window can be limited to the first/last N modules.

---

### Task 4 – Soft / DP Run Decoding
**State**: `createCode128State()` or new fields on consensus state

DP tables are the main risk. Bound them tightly:

```js
// Example bounds: max symbols ~ 48, max modules-per-symbol ~ 6–8, candidate widths ~ 4–5
dpScore: new Int32Array(48 * 8),       // or flattened [symbol][moduleCount]
dpPrev: new Uint8Array(48 * 8),
dpBestWidth: new Uint8Array(48),
```

- Reuse the existing `runWidthsQ8` / `runIsBar` as input.
- Soft symbol probabilities can go into the already-allocated `softConfsQ10` / `softSymbols` in consensus.
- If you need a temporary observation likelihood array, size it to `MAX_RUNS` and add it to the decoder state.

**Rule**: DP dimensions are known at init time (Code 128 max length is bounded). Never grow tables.

---

### Task 5 – Multi-Scale Structure Tensor
**State**: `createRoiState()` / `createRoiSubState()`

You already have a secondary `small2x` sub-state for the centre crop. Options:

1. **Reuse the existing `small2x` path** when the primary clusters are weak (already zero-alloc).
2. **Add one extra coarser grid** only if needed:

```js
// Inside createRoiState, optional:
coarse: createRoiSubState(width, height, dsShift + 1, 0, 0, ...),
```

- All block arrays (`blockJxx`, etc.) are already sized to the grid. A coarser grid is smaller, so it is cheap.
- Do not allocate per-frame; the sub-state is created once.

**Energy score**: Can be written into the existing `blockScore` or a new `blockEnergy: new Float32Array(gridSize)` if you want to keep them separate.

---

## Cross-Cutting Rules

1. **Allocate only in `create*State()`**.  
   The per-frame functions (`processFrame`, `extractRuns*`, `estimateModuleWidthQ8`, DP step, etc.) receive the state and only write into pre-allocated arrays.

2. **Prefer overwrite to extra copies**.  
   Dual-use buffers (`deriv` as both derivative and temporary max) are already common. Document the reuse contract in a comment.

3. **Fixed-point in inner loops**.  
   Q8 for sub-pixel positions and widths, Q16 for line stepping, integer accumulators for correlation and DP scores. Convert to float only for final reporting if needed.

4. **Bound everything by existing constants**.  
   `MAX_SCANLINE_LEN`, `MAX_RUNS`, `MAX_SCANLINES`, `MAX_CODE128_SYMBOLS`, `MAX_ROI_CLUSTERS`. New buffers must use these or smaller fixed sizes.

5. **Flag-gated paths still use the same buffers**.  
   The extra arrays exist even when the flag is off; they are simply not written. This keeps the allocation site unique and the hot path branch-free where possible.

6. **Worker lifetime**.  
   The state objects live for the lifetime of the worker. No per-frame `new`, no growing `Array`, no closures that capture new arrays.

---

## Minimal Buffer Additions Summary

| Task | New buffers (added once in create*) | Reuses existing |
|------|-------------------------------------|-----------------|
| 1. Module est | `corrLags` (Int32, ~64) | `absDeriv` or `lumaBank` |
| 2. Blur edges | Optional third edge bank (or none) | `deriv`, `absDeriv`, `edgePosQ8*`, `scratchLuma` |
| 3. Matched filter | `templateBank`, `templateLens`, `corrScratch` | `lumaBank` / normalised line |
| 4. Soft DP | `dpScore`, `dpPrev` (bounded) | `runWidthsQ8`, consensus soft banks |
| 5. Multi-scale tensor | Optional extra `RoiSubState` | Existing `small2x` path, block arrays |

Total extra memory is a few tens of KB at most, all allocated once.

---

## Verification

- Add a debug counter or assertion (dev only) that no `new` occurs inside `processFrame` / extractors when the new flags are on.
- Existing zero-alloc tests (if any) or a simple “heap snapshot before/after 100 frames” in the sim harness.
- `flag-coverage` and performance numbers on the still/defect suites should show no allocation-related regressions.

---

*These strategies keep the new blur-rejection features inside the same zero-allocation contract the rest of the pipeline already obeys.*
