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

- **NO 2D reverse-keystone barcode rendering or pixel diffing:** Wastes frame budget and fails under glare/shadows; mathematical checksums + multi-scanline consensus guarantee near-zero false positives. *(Clarification: this rule applies to barcode rendering; block-matching optical flow on already-downsampled luma in `src/worker/flow.js` is allowed behind the `flowOn` flag.)*
- **Feature-Flag Guardrail (`src/flags.js`):** All new behaviour changes ship behind a named flag defaulting to `false` (overridable via `?flags=...` or `localStorage['dbc.flags']`, passed to the worker as a 32-bit integer bitmask). Verify baseline parity with `node tools/verify.mjs` after every change.
- **NO full-frame global thresholding (e.g., Otsu):** Fails under ambient shadows, uneven lighting, and glare. Use local 1D first-derivative peak detection / zero-crossing edge extraction.
- **NO blind format exhaustion:** Never iterate across all 1D/2D symbologies on failed frames. Strictly restrict decoding to an explicit active symbology allowlist (**active scope: `CODE_128` only**).
- **NO WebAssembly (WASM) by default:** Stay in pure Vanilla JS unless empirical profiling demonstrates a full-frame 2D stage exceeding its allocated frame budget.

---

## 5. Pipeline Architecture & Performance Budgets (720p / 1080p Input)

- **720p (`1280x720`) Target:** median `t_total <= 25 ms`.
- **1080p (`1920x1080`) or native-resolution crop:** median `<= 25 ms` and `p95 <= 33 ms` (one 30 fps frame interval).
- **Wall mapping:** adds at most `3 ms` median to `t_total`.
- **FC Target Labels:** Code 128 Set B, ~`2 in × 3.5 in` (typically `tsX...`, ~187 modules) on tote walls (config-driven pitch `14×16 in` or `16×14 in`; never hard-code).

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
├── diag.html                   # Standalone device diagnostics page (Step D0; exempt from 25 ms scan budget)
├── sim.html                    # WebGL 4×4 tote wall camera motion simulator (14×16 in totes, 2×6 in Code 128)
├── array.html                  # Live Tilt & Pan Array Scanner page (Part 3 stand-back gyro/ray-plane test)
├── src/
│   ├── main.js                 # App entry, UI state machine, frame dispatch loop
│   ├── camera.js               # getUserMedia setup, track constraints, focus lock, C4 exposure API
│   ├── flags.js                # Central feature-flag registry & worker bitmask (GR1; all default OFF)
│   ├── scanner.js              # Headless drop-in Code 128 scanner API (cross-origin Blob worker support)
│   ├── wallmap.js              # Part 2 close-range slide-mode wall mapper (A10 `slideMap`)
│   ├── capture/                # Exposure, lens probe & crop helpers (C4/C5/C6/C7)
│   │   ├── exposure.js         # Max safe along-scan speed & exposure HUD formatter
│   │   ├── crop.js             # Even-aligned VideoFrame rect crop & predicted 4K label crop (C5/C7)
│   │   └── lensprobe.js        # Rear lens capability probe & standback profile selector (C6)
│   ├── ui/                     # Main-page UI helpers (U2/U4/overlayAlign)
│   │   ├── frame-map.js        # Unified mapFrameToScreen(x,y), DPR sizing & live frame-size reader
│   │   ├── overlay-dim.js      # Flagged Normal/Dim/Min overlay & auto-fade controller
│   │   └── pause.js            # Hold-to-pause & face-down gravity pause controller (U4)
│   ├── tape/                   # Frame/sensor `.dbct` recorder (GR3)
│   │   └── record.js           # Gzip CompressionStream tape recorder for Node replay
│   ├── array/                  # Stand-back Tilt & Pan Array Scanner modules (zero dependencies)
│   │   ├── orient.js           # Fused RelOrient/60Hz Gyro+Accel tracker, gravity-zero & ring buffer
│   │   ├── pan-mapper.js       # Ray-plane projection, 2-corner cal, A2–A5/A8/A9 & C7 pixel projection
│   │   ├── kalman.js           # A8 angle-compensated D, 2-read Gauss-Newton f/D & 3-state Kalman filter
│   │   ├── autozero.js         # Auto tote-zero state machine from first square centred label (A6)
│   │   ├── config.js           # FC 2×3.5 in & confirmed 16×14 in tote orientation config profiles (A1)
│   │   ├── optics.js           # Pixels-per-module (PPM) evaluator (A1)
│   │   ├── setup.js            # Hold attitude preflight classifier & 8-way D4 axis remap solver (A7)
│   │   ├── blur.js             # Scan-angle-aware shutter blur-modules gate (B1)
│   │   └── viewmap.js          # Exact contain/cover camera-to-HUD view transform (B2)
│   ├── sim/                    # WebGL 4×4 tote wall simulator modules (zero dependencies)
│   │   ├── paths.js            # Exact 14×16 in wall geometry, optics/PPM, camera paths & mat4 math
│   │   └── webgl-wall.js       # WebGL2/1 analytical Code 128 shader, shutter blur & GPU luma pack
│   ├── diag/                   # Standalone device diagnostics modules (D0/D1/D3; zero network calls)
│   │   ├── probe.js            # Environment, screen orientation & full diagnostics orchestration
│   │   ├── cameras.js          # Exclusive per-device probing, zoom sweep & lens heuristics
│   │   ├── capture.js          # rVFC/rAF fps, VideoFrame copyTo & worker transferability check
│   │   ├── sensors.js          # Generic Sensor / DeviceMotion / gravity & referenceFrame probes
│   │   ├── decode-test.js      # Optional live Code 128 decode test & D3 3.5 in label PPM summary
│   │   ├── recommend.js        # Deterministic mode recommendation engine
│   │   ├── report.js           # Plain-text + JSON (v1) report formatter, copy & share helpers
│   │   └── hash.js             # 12-char SHA-256 deviceId hashing (no raw deviceIds in reports)
│   └── worker/
│       ├── scanner.worker.js   # Pipeline orchestrator, flags bitmask, W9/W10/W13 & TypedArray pool
│       ├── roi.js              # Downscaler, Gx/Gy pass, Structure Tensor & W9 small-code 2x pass
│       ├── scanline.js         # Oriented luma sampler, W1/W6/W7/W8/W12 & derivative edge detector
│       ├── consensus.js        # Multi-scanline voting, W4 prefix gate & W5 prefix-aligned stacking
│       ├── flow.js             # W13 downsampled 3×3 tile block-matching optical flow (`flowOn`)
│       └── decoders/
│           ├── code128.js      # Code 128 guard pattern anchor, W3 tsX crib & Mod 103 checksum
│           └── ean13.js        # EAN-13/UPC-A guard anchor & Mod 10 checksum
├── baseline/                   # Recorded clean d917944 baseline metrics & sim templates (GR0)
├── diag/                       # Real device hardware notes (D2: Galaxy A53 5G SM-A536B)
├── tools/
│   ├── verify.mjs              # Automated regression verification gate against baseline (GR2)
│   ├── replay.mjs              # Node.js `.dbct` frame/sensor tape replay runner (GR3)
│   └── tape-format.md          # Binary `.dbct` v1 tape specification
└── tests/
    ├── harness.js              # Offline runner & synthetic/real test image generator
    ├── array.test.js           # Unit tests for A1–A7/B1/B2 array orientation, mapping & blur
    ├── capture-ui.test.js      # Unit tests for C2/C3/C5/C6/C7 zoom/focus/crop/lensProbe & U4 pause
    ├── diag.test.js            # Unit tests for D0/D1/D2/D3 diagnostics & real A53 fixture
    ├── exposure.test.js        # Unit tests for C4 exposure info, two-step setter & speed budget
    ├── flags.test.js           # Unit tests for GR1 feature flags & worker bitmask
    ├── flow.test.js            # Unit tests for W13 downsampled optical flow (accuracy & <=3 ms)
    ├── overlay-align.test.js   # Unit tests for unified mapFrameToScreen(x,y) overlay alignment
    ├── panmodel.test.js        # Unit & 200-run Monte-Carlo tests for A8 panKalman & A9 allocCleanup
    ├── sim.test.js             # Unit tests for WebGL simulator geometry, F1 FC realism & F2 paths
    ├── tape.test.js            # Unit tests for GR3 `.dbct` gzip record & Node replay
    ├── w1-vertical.test.js     # Unit tests for W11 geometry/flags & W1 vertical fallback scanlines
    ├── w2-decoder.test.js      # Unit tests for W2/W3/W4/W6/W7/W10 flagged decoder upgrades
    ├── w3-worker.test.js       # Unit tests for W5/W8/W9/W12/W13 Wave 3 worker upgrades
    └── wallmap.test.js         # Unit & 200-run Monte-Carlo tests for A10 slide-mode wall mapper
```

---

## 8. Phased Delivery & Verification Gates

Do not advance to a later phase until the current phase's acceptance criteria are verified:

1. **Phase 1 — Benchmark & Fixture Harness:** Synthetic + real test image generator (`0°`, `15°`, `37°`, `90°`, shadow gradients, mild motion blur) and baseline timing/allocation profiler.
2. **Phase 2 — RoI & Structure Tensor Angle Estimator:** `< 5 ms` on `1280x720` inputs; orientation error within `±3°`; debug overlay verification in harness.
3. **Phase 3 — Oriented Scanlines, 1D Decoders & Consensus:** `> 95%` decode accuracy across the test matrix in `< 20 ms/frame` with verified zero hot-loop allocations.
4. **Phase 4 — Android Chrome Live Pipeline & Telemetry:** Stable `1280x720` capture, active continuous autofocus, live HUD telemetry, and `< 100 ms` end-to-end physical barcode lock-on.
