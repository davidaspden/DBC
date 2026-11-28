# M6 — AR label compositor (`src/ar/compose.js`), flag `arCompose` (sim registry, default off)

```js
const comp = createCompositor({ width, height, scene });          // enabled by arCompose, or { enabled: true }
comp.compose(rawLuma, trackerStatus.H, photometryResult, outLuma, frameSeed);  // returns labels drawn
```

- **Inputs:** the M4 tracker's wall->image homography (wall frame: inches, top-left origin, +y down), the M5
  photometry record (`whitePoint`, `blackPoint`, `shadingGx/Gy`, `noiseSigma`, `psfSigmaPx`) and a sim
  `scene` (`src/sim/scene.js`) for label size, pitch, orientation, offsets and payloads.
- **Per label:** inverse-map each pixel of the padded box through H^-1; module-integrated coverage with the
  exact pixel footprint (`sampleBarcodeIntegrated1D`, the CPU renderer's function); luma between measured
  black and paper (x `labelPaperRel`, default 0.95) times the shading plane; 1 px anti-aliased edge onto the
  real wall; separable Gaussian PSF (radius <= 8 px); matched seeded noise; optional sharpening
  (`sharpenGain`, default 0, since M5 doesn't measure overshoot yet).
- **Flag off:** `compose` only copies the raw frame (bit-for-bit) and draws nothing.
- **Memory:** buffers sized once in `createCompositor` (3 x Float32 W*H by default, `maxBoxPx` caps it); no
  per-frame allocation.

## Measured (`tests/ar-compose.test.js`, this box)

| Check | Result | Limit |
|---|---|---|
| Composite vs R5 CPU render, same geometry (after gain/offset fit) | 0.10/255 mean | < 6/255 |
| Lowest decoding px/module, composite vs CPU render | 1.10 vs 1.10 | within 0.1 |
| PSF sigma 1.5 vs reference 2D Gaussian of the sharp composite | 0.26/255 mean | < 6/255 |
| Paper luma / noise sigma (target 4) | bias 0.45, sd 3.7 | within 15% |
| 1080x1920, 4 labels, sigma 1.2 + noise | 4.9 ms median | <= 6 ms (A53 figure: M11) |

## Not drawn yet (follow-ups)

Lips and shadow bands (L4), label defects (L7), negatives (L6), a per-row rolling-shutter pose, and a
direction-aware (motion) PSF. M5 only reports `psfSigmaMin/Max`, not a direction. A thin ring of real wall
pixels within the PSF radius of each label is blurred a second time.
