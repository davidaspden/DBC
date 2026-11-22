# AGENTS.md — Sub-100ms 1D Barcode Scanner Guardrails & Standards

This repository implements a zero-dependency, browser-based 1D barcode scanner optimized for Android Chrome, targeting **sub-100ms end-to-end lock-on** and **10–30ms per-frame processing** (<25ms budget per `1280x720` frame).

All agents and contributors MUST strictly follow the rules below.

---

## 1. Runtime, Stack & Dependencies

- **Language:** Vanilla JavaScript using standard ES Modules (`import` / `export` with explicit `.js` file extensions).
- **Execution Context:** All image processing, RoI estimation, scanline extraction, decoding, and consensus run inside a dedicated Web Worker using `TypedArray` buffers (`Uint8Array`, `Int32Array`, `Float32Array`).
- **Zero External Runtime Dependencies:** Do NOT add ZXing, OpenCV.js, Quagga, UI frameworks, or any third-party runtime packages.
- **Zero Build Step:** Source files must execute directly in modern browsers (Android Chrome) and offline Node.js ESM runners without bundlers, transpilers, or compilers.

---

## 2. Memory Discipline — Zero-Allocation Hot Loop

To eliminate V8 Garbage Collection (GC) pauses on mobile devices:

1. **Pre-allocate Everything Once:** All scratch buffers, downsampled luma grids, gradient planes (`Gx`, `Gy`), structure tensor accumulators, scanline luma arrays, derivative/edge transition buffers, module width arrays, symbol vote tables, and result structs MUST be allocated once during Web Worker / pipeline initialization (or explicitly on frame-dimension change).
2. **Zero Allocations in Per-Frame / Per-Scanline Loops:** Inside the hot decode path:
   - NO object literals (`{ ... }`).
   - NO array literals (`[ ... ]`) or `new Array(...)`.
   - NO closures, bound functions, or per-frame callback allocations.
   - NO `TypedArray.prototype.slice()` or unnecessary `.subarray()` view allocations inside inner loops (pass `(buffer, offset, length)` explicitly instead).
   - NO string building or template literals except when emitting a validated final decode result.
   - Reuse fixed-size pre-allocated result objects/TypedArrays and return numeric status codes or counts.

---

## 3. Numeric Performance

- Prefer **32-bit integer (`| 0`, `Math.imul`, `Int32Array`) and bitwise (`>>`, `<<`, `&`) arithmetic** inside all inner pixel and scanline loops over floating-point operations wherever applicable.
- Keep trigonometry (`Math.cos`, `Math.sin`, `Math.atan2`) strictly outside inner pixel loops (compute once per block/RoI or scanline setup, then step with fixed-point integer increments).
- Favor linear, cache-friendly memory access patterns over strided random access when possible.

---

## 4. Explicit Anti-Goals (Do NOT Implement)

- **NO 2D reverse-keystone barcode rendering or pixel diffing:** Wastes frame budget and fails under glare/shadows; mathematical checksums + multi-scanline consensus guarantee near-zero false positives.
- **NO full-frame global thresholding (e.g., Otsu):** Fails under ambient shadows, uneven lighting, and glare. Use local 1D first-derivative peak detection / zero-crossing edge extraction.
- **NO blind format exhaustion:** Never iterate across all 1D/2D symbologies on failed frames. Strictly restrict decoding to an explicit active symbology allowlist (**active scope: `CODE_128` only**).
- **NO WebAssembly (WASM) by default:** Stay in pure Vanilla JS unless empirical profiling demonstrates a full-frame 2D stage exceeding its allocated frame budget.

---

## 5. Pipeline Architecture & Performance Budgets (720p Input)

Target total per-frame processing budget: **< 25 ms** on `1280x720` luma frames.

| Stage | Module | Technique | Target Budget |
| :--- | :--- | :--- | :--- |
| **Stage 1** | `src/worker/roi.js` | 4x downscale (`320x180`), `Gx`/`Gy` gradients, block-level 2D Structure Tensor (`Gx²`, `Gy²`, `Gx·Gy`), RoI bounding box & dominant angle `θ` (`0°–180°`) | **2–4 ms** (Hard gate: `< 5 ms`, angle error `±3°`) |
| **Stage 2** | `src/worker/scanline.js` | 7–15 parallel oriented 1D scanlines along `θ` within RoI; fallback fan (`0°`, `+15°`, `-15°`, `90°`) across center strip on low confidence | **1–3 ms** |
| **Stage 3** | `src/worker/scanline.js` | 1D first-derivative peak detection & sub-pixel zero-crossing edge transitions (no global threshold) | **2–5 ms** |
| **Stage 4** | `src/worker/consensus.js` + `decoders/*` | Guard pattern anchoring, normalized module-width ratio scoring, cross-scanline character voting (or aligned profile averaging) | **1–5 ms** |
| **Stage 5** | `src/worker/decoders/*` | Strict mathematical checksum gate (Code 128 Mod 103) + consensus `>= 2` agreeing scanlines | **< 0.1 ms** |

---

## 6. Camera Capture & Live Telemetry Standards (Android Chrome)

- **Camera Constraints (`src/camera.js`):**
  - Rear camera (`facingMode: 'environment'`), target resolution `1280x720` (avoid 4K overhead and 480p bar-merging).
  - Apply `focusMode: 'continuous'` via `track.applyConstraints()` when supported.
  - Log `track.getSettings()` on startup for diagnostic verification.
- **Luma Frame Extraction (`src/main.js`):**
  - **Primary Path:** WebCodecs `new VideoFrame(video)` + `frame.copyTo()` extracting the raw `Y` (luma) plane into a pre-allocated/recycled `Uint8Array` (zero RGBA-to-gray conversion, avoids `getImageData` readback stalls).
  - **Fallback Path:** `OffscreenCanvas` / 2D Canvas `getImageData()` for contexts lacking WebCodecs.
- **Telemetry HUD (`index.html` + `src/main.js`):**
  - Continuous per-frame display of `t_capture`, `t_roi`, `t_decode`, `t_total` (ms).
  - Active camera resolution and verified `focusMode`.
  - Detected dominant angle `θ` (degrees) and scanline consensus agreement counts.

---

## 7. Workspace Layout

```text
/
├── AGENTS.md                   # Workspace rules, performance guardrails, and agent standards
├── index.html                  # Mobile viewport, video layer, canvas HUD overlay
├── src/
│   ├── main.js                 # App entry, UI state machine, frame dispatch loop
│   ├── camera.js               # getUserMedia setup, track constraints, focus lock
│   └── worker/
│       ├── scanner.worker.js   # Pipeline orchestrator & pre-allocated TypedArray pool
│       ├── roi.js              # Downscaler, Gx/Gy pass, Structure Tensor theta estimator
│       ├── scanline.js         # Oriented luma sampler & derivative edge detector
│       ├── consensus.js        # Multi-scanline character voting & validation engine
│       └── decoders/
│           ├── code128.js      # Code 128 guard pattern anchor & Mod 103 checksum
│           └── ean13.js        # EAN-13/UPC-A guard anchor & Mod 10 checksum
└── tests/
    └── harness.js              # Offline runner & synthetic/real test image generator
```

---

## 8. Phased Delivery & Verification Gates

Do not advance to a later phase until the current phase's acceptance criteria are verified:

1. **Phase 1 — Benchmark & Fixture Harness:** Synthetic + real test image generator (`0°`, `15°`, `37°`, `90°`, shadow gradients, mild motion blur) and baseline timing/allocation profiler.
2. **Phase 2 — RoI & Structure Tensor Angle Estimator:** `< 5 ms` on `1280x720` inputs; orientation error within `±3°`; debug overlay verification in harness.
3. **Phase 3 — Oriented Scanlines, 1D Decoders & Consensus:** `> 95%` decode accuracy across the test matrix in `< 20 ms/frame` with verified zero hot-loop allocations.
4. **Phase 4 — Android Chrome Live Pipeline & Telemetry:** Stable `1280x720` capture, active continuous autofocus, live HUD telemetry, and `< 100 ms` end-to-end physical barcode lock-on.
