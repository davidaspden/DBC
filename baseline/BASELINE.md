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

## WebGL Sim Presets (`sim.html`, 3 loops each — fill in on GPU browser)

| Preset | 16/16 Locked | Time to 16/16 (s) | FP | Worker median / worst (ms) | PPM |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `a53-8-720` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| `a53-8-1080` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| `tele-30` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| `full-wall` | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

## Live Phone Baseline (Galaxy A53 5G — fill in after field run)

- `diag.html` report captured: _pending_
- `index.html` screen recording: _pending_
- `array.html` screen recording: _pending_

## Pass Bar for Every PR
- All Node tests pass with identical or higher pass counts (`0` false positives).
- `node tools/verify.mjs` exits `0` against `baseline/baseline-d917944.json`.
- With all flags OFF, behaviour and sim presets equal baseline within tolerance (`time <= 1.10x`, `FP <= baseline`, `worker median <= baseline + 1 ms`).
