# M5 — wall photometry estimator (`src/ar/photometry.js`), flag `arCompose`

Last stage of Wave 2B: from one luma frame and the M2 dots, estimate what the camera and wall did to the picture so a
synthetic label composited into the frame (M6) can be matched to it. Inert until M6 wires it behind `arCompose`
(default OFF; a disabled estimator returns `valid = false` and reads nothing).

```js
const ph = createPhotometryEstimator({ width, height });   // enabled by the arCompose flag or { enabled: true }
const e = ph.estimate(luma, detector.result);              // e === ph.result (reused)
if (e.valid) use(e.psfSigmaPx, e.noiseSigma, e.whitePoint, e.blackPoint, e.shadingGx, e.shadingGy);
```

| Output | How |
|---|---|
| `shadingGx/Gy`, `whitePoint` | plane `a (1 + gx (x/W-0.5) + gy (y/H-0.5))` fitted to dot-free 12x12 blocks, with one robust re-fit; white = plane value at the image centre |
| `blackPoint` | mean of the dot cores (0.3 of the minor semi-axis), divided by the local shading, median over up to 16 big round dots |
| `noiseSigma` | white noise from horizontal pixel differences on clean blocks (median over blocks; uint8 rounding variance removed) |
| `psfSigmaPx` | Gaussian sigma from the 16%-84% edge width along 8 rays per dot (pixel-box variance removed); `psfSigmaMin/Max` = smallest / largest per-direction median |

`psfSigmaMax / psfSigmaMin` well above 1 means motion blur (or an astigmatic lens). The noise figure is the pixel-difference
level, so it under-reports on cameras whose noise is spatially correlated after ISP smoothing.

## Measured (24 random synthetic walls: PSF 0.8-2.6 px, noise 1.5-6, paper 150-205, ink 10-60, shading up to +-0.4)

| Acceptance (plan 3) | Result |
|---|---|
| PSF within 15% | worst 12.7% |
| Noise within 15% | worst 0.5% |
| Black / white within 5/255 | worst 0.32 / 0.15 |
| Shading | gradient error <= 0.002 of the frame |
| Motion blur visible | direction ratio 1.03 still vs 1.54 with 4 px blur |
| Zero allocation | -76 B/call after warm-up over 600 calls (none) |
| Speed | 1.1 ms median at 1080x1920 (run on key frames, ~1 Hz) |

## Limits

Synthetic walls only: the renderer has Gaussian PSF, white noise and a planar shading, which is exactly the model the
estimator fits. Real frames add JPEG/ISP smoothing, vignetting (not planar), glare and lens distortion; the PSF figure then
absorbs ISP sharpening. Needs at least two big round dots (>= 12 px) and 6 clean blocks, otherwise `valid = false`.
