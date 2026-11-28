# DBC Baseline (GR0 — commit `d917944`)

Recorded on clean checkout of `d917944daaf5425ca3aca69697aec0459d3d8e98` (`2026-11-28T04:23:25Z`, Node `v24.19.0`, Windows).

## Automated Node Suite (Baseline)

| Suite | Result | Key Metrics |
| :--- | :--- | :--- |
| `tests/array.test.js` | **7/7 PASS** | Ray-plane, 16-cell sweep, TL/TR corner zero, 2-corner cal, conflict guard |
| `tests/sim.test.js` | **4/4 PASS** | 14×16 in totes, 2×6 in Code 128B (231 mod), optics PPM, 6 paths, mat4 |
| `tests/diag.test.js` | **9/9 PASS** | SHA-256 hash, zero raw deviceId leak, A53 & tele recommendations |
| `tests/harness.js` (Phase 2 RoI) | **14/14 PASS** | `maxErr = 0.68°`, `2/2` negatives clean, `p50 = 0.697 ms`, `p95 = 0.850 ms` |
| `tests/harness.js` (Phase 3 Full) | **14/14 (100%)** | `0/2` false positives, `p50 = 0.742 ms`, `p95 = 0.996 ms`, `p99 = 1.061 ms`, heap `16.11 B/frame` |

## Headless CPU Sim Presets (`tools/simgate.mjs`, F3/G3 `cpu-baseline`, 3 loops × 5 seeds, flags OFF)

Captured at commit `80cbcf5` (`renderer: "cpu"`, `status: "cpu-baseline"`, `profile: "ideal"`, `fidelityStatus: "uncalibrated"`, dynamically measured `deviceFactorA53 = 8.093` from `tsX07wz7py1` still fixture `nodeP50Ms = 4.696 ms` vs `phoneMs = 38 ms`, machine `LapDancer2026` / `Intel(R) Core(TM) Ultra 9 275HX`, `win32/x64`, Node `v24.19.0`; saved in `baseline/sim-presets.json` and separate Windows archive `baseline/sim-presets-win32-80cbcf5.json`). R6 GL-to-CPU parity will upgrade status to `gl-verified`.

### Original 4 Presets (2×6 in labels, 231 modules)

| Preset | 16/16 Locked | Coverage | Time to 16/16 median (s) | FP (5 seeds) | Worker node p50 / p95 / max (ms) | A53 scaled p50 / p95 (ms) | PPM |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `a53-8-720` | **5/5** | 16/16 | 12.40 (12.37–12.41) | 0 | 1.63 / 2.13 / 41.30 | 13.2 / 17.3 | 2.343 |
| `a53-8-1080` | **5/5** | 16/16 | 11.09 (11.06–11.10) | 0 | 3.23 / 4.25 / 52.32 | 26.1 / 34.4 | 2.929 |
| `tele-30` | **5/5** | 16/16 | 10.01 (10.00–10.04) | 0 | 3.23 / 3.97 / 28.30 | 26.2 / 32.1 | 3.600 |
| `full-wall` | 0/5 (sub-Nyquist) | 0/16 | -- | 0 | 6.87 / 7.72 / 31.75 | 55.6 / 62.5 | 0.676 |

### FC 3.5 in Presets & `snake-h-fast-step` (2×3.5 in `tsX` labels, 187 modules)

| Preset | 16/16 Locked | Coverage | Time to 16/16 median (s) | FP (5 seeds) | Worker node p50 / p95 / max (ms) | A53 scaled p50 / p95 (ms) | PPM |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fc-8-3p5` | **5/5** | 16/16 | 16.01 (15.98–16.03) | 0 | 3.16 / 3.83 / 25.85 | 25.6 / 31.0 | 3.166 |
| `fc-12-3p5-auto` | **5/5** | 16/16 | 15.79 (15.78–15.84) | 0 | 2.95 / 3.68 / 26.86 | 23.9 / 29.8 | 2.111 |
| `fc-tele-30-3p5` | **5/5** | 16/16 | 12.18 (12.17–12.20) | 12* | 2.98 / 3.59 / 23.09 | 24.1 / 29.0 | 2.594 |
| `fc-30-1x-fail` | 0/5 (sub-Nyquist) | 0/16 | -- | 0 | 3.28 / 4.80 / 25.43 | 26.5 / 38.8 | 0.844 |
| `fc-jitter-hard` | **5/5** | 16/16 | 13.93 (13.89–13.98) | 0 | 2.92 / 3.71 / 25.65 | 23.6 / 30.0 | 2.533 |
| `snake-h-fast-step` | **5/5** | 16/16 | 15.83 (15.79–15.86) | 0 | 3.04 / 3.88 / 24.74 | 24.6 / 31.4 | 2.111 |

_*Baseline finding (`fc-tele-30-3p5`, flags OFF): 12 oblique-angle misreads across 5,805 frames (5 seeds × 3 loops) decoded cell R4C1 (`tsX41A00013B`) as `tsX41A00013!` passing Mod 103 + 2-scanline consensus. Recorded honestly as flags-off baseline (eliminated when `stopGuard` is enabled in `W-fc`/`W-all`/`strict`); do not mask._

## Live Phone Baseline (Galaxy A53 5G — fill in after field run)

- `diag.html` report captured: _yes (`cc0f88`, 2026-11-28)_
- `index.html` screen recording: _pending_
- `array.html` screen recording: _pending_

## Pass Bar for Every PR
- All Node tests pass with identical or higher pass counts (`0` false positives).
- `node tools/verify.mjs` exits `0` in same-machine interleaved A/B mode (`--legacy-json` for historical Windows comparison against `baseline/baseline-d917944.json`).
- With all flags OFF, behaviour and sim presets equal baseline within tolerance (`time <= 1.10x`, `FP <= baseline`, `worker median <= baseline + 1 ms`).
