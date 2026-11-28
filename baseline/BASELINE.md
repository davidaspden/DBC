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

## Headless CPU Sim Presets (`tools/simgate.mjs`, G3 `cpu-baseline`, 3 loops × 5 seeds, flags OFF)

Captured at commit `ce8b33e` (`renderer: "cpu"`, `status: "cpu-baseline"`, `profile: "ideal"`, `fidelityStatus: "uncalibrated"`, provisional `deviceFactorA53 = 5.8`, Node `v24.19.0`, Windows x64; raw archive in `baseline/sim-presets.json` and `baseline/sim-presets-cpu-ce8b33e.json`). R6 GL-to-CPU parity will upgrade status to `gl-verified`.

### Original 4 Presets (2×6 in labels, 231 modules)

| Preset | 16/16 Locked | Coverage | Time to 16/16 median (s) | FP (5 seeds) | Worker node p50 / p95 / max (ms) | A53 scaled p50 / p95 (ms) | PPM |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `a53-8-720` | **5/5** | 16/16 | 12.40 (12.37–12.41) | 0 | 1.69 / 2.22 / 42.46 | 9.8 / 12.9 | 2.343 |
| `a53-8-1080` | **5/5** | 16/16 | 11.09 (11.06–11.10) | 0 | 3.51 / 4.62 / 76.60 | 20.3 / 26.8 | 2.929 |
| `tele-30` | **5/5** | 16/16 | 10.01 (10.00–10.04) | 0 | 3.43 / 4.24 / 30.48 | 19.9 / 24.6 | 3.600 |
| `full-wall` | 0/5 (sub-Nyquist) | 0/16 | -- | 0 | 7.55 / 8.23 / 63.17 | 43.8 / 47.7 | 0.676 |

### FC 3.5 in Presets & `snake-h-fast-step` (2×3.5 in `tsX` labels, 187 modules)

| Preset | 16/16 Locked | Coverage | Time to 16/16 median (s) | FP (5 seeds) | Worker node p50 / p95 / max (ms) | A53 scaled p50 / p95 (ms) | PPM |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `fc-8-3p5` | **5/5** | 16/16 | 16.01 (15.98–16.03) | 0 | 3.40 / 4.13 / 27.44 | 19.7 / 23.9 | 3.166 |
| `fc-12-3p5-auto` | **5/5** | 16/16 | 15.79 (15.78–15.84) | 0 | 3.15 / 3.94 / 26.15 | 18.3 / 22.9 | 2.111 |
| `fc-tele-30-3p5` | **5/5** | 16/16 | 12.18 (12.17–12.20) | 12* | 2.93 / 3.72 / 22.99 | 17.0 / 21.6 | 2.594 |
| `fc-30-1x-fail` | 0/5 (sub-Nyquist) | 0/16 | -- | 0 | 3.49 / 4.96 / 24.29 | 20.2 / 28.8 | 0.844 |
| `fc-jitter-hard` | **5/5** | 16/16 | 13.93 (13.89–13.98) | 0 | 3.07 / 3.93 / 30.41 | 17.8 / 22.8 | 2.533 |
| `snake-h-fast-step` | **5/5** | 16/16 | 15.83 (15.79–15.86) | 0 | 3.10 / 3.97 / 25.12 | 18.0 / 23.0 | 2.111 |

_*Baseline finding (`fc-tele-30-3p5`, flags OFF): 12 oblique-angle misreads across 5,805 frames (5 seeds × 3 loops) decoded cell R4C1 (`tsX41A00013B`) as `tsX41A00013!` passing Mod 103 + 2-scanline consensus. Recorded honestly as flags-off baseline; do not mask._

## Live Phone Baseline (Galaxy A53 5G — fill in after field run)

- `diag.html` report captured: _pending_
- `index.html` screen recording: _pending_
- `array.html` screen recording: _pending_

## Pass Bar for Every PR
- All Node tests pass with identical or higher pass counts (`0` false positives).
- `node tools/verify.mjs` exits `0` against `baseline/baseline-d917944.json`.
- With all flags OFF, behaviour and sim presets equal baseline within tolerance (`time <= 1.10x`, `FP <= baseline`, `worker median <= baseline + 1 ms`).
