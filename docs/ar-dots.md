# M2 — AR dot detector (`src/ar/dots.js`)

Finds the solid dark discs of the AR wall layout (`src/ar/layout.js`, M0) in a luma frame. It is the
first stage of the wall-tracking chain: M2 dots -> M3 lattice + homography -> M4 pose tracker.
Nothing in the live scan path imports it yet (that is M4, behind the `arWall` flag), so flags-off
behaviour is unchanged.

```js
import { createDotDetector } from './src/ar/dots.js';
const det = createDotDetector({ width: 1080, height: 1920 });   // allocates everything once
const r = det.detect(lumaUint8Array);                           // r === det.result (reused every call)
for (let i = 0; i < r.count; i++) use(r.x[i], r.y[i], r.diameter[i], r.sizeClass[i]);
```

## How it works

1. 1/4-resolution box downscale (every second row of each 4x4 block; one 32-bit load per 4 pixels when the
   buffer is 4-byte aligned, otherwise the byte-load path, same result within rounding).
2. Local mean from an integral image (radius 10 small pixels); a pixel is ink when it is darker than the
   local mean by `delta`. `delta = max(24, 5 sigma)` where sigma is a robust (median) wall-noise estimate.
3. Connected components (4-connected, two-pass union-find), per component: area, darkness-weighted
   centroid, second moments.
4. Filters: area band, moment-ellipse fill ratio, elongation (<= 3, so motion-blurred dots survive), and
   dots touching the frame border are dropped (clipped dots would bias the centroid).
5. Full-resolution refinement: darkness-weighted centroid in a window against the window ring background
   (the faint 15% tail is ignored so noise does not pull it). Also gives a full-res diameter.
6. Size class (x1 / x1.25 / x1.5 / x2) from the ratio of the dot's diameter to the median diameter of its
   6 nearest dots. **This is a coarse hint**: perspective changes neighbour sizes by tens of percent at
   oblique poses. M3 re-checks the classes against the homography-predicted diameters.

Output (`r`): `count`, `x`, `y` (full-res px, pixel centre at +0.5), `area`, `diameter`, `major`, `minor`,
`angleDeg`, `elongation`, `fill`, `contrast`, `sizeRatio`, `sizeClass`, plus `delta`, `sigma`,
`components` and `rejected{area,fill,elongation,border,overflow}`. `maxDots` defaults to 256.

## Performance rules

Zero allocation per frame (all typed arrays created in `createDotDetector`; the only allocation is a
32-bit view when the caller hands in a different buffer than last time). Integer maths in the pixel loops.

## Measured (synthetic walls, `tests/helpers/ar-dot-render.js`, exact discs + PSF + noise)

| Acceptance (plan 3) | Result |
|---|---|
| Centroid error static <= 0.15 px | max 0.047 px, rms 0.016 px (178 dots, 8 poses, noise sigma 3, PSF 1 px) |
| Centroid error, 3 px motion blur <= 0.5 px | max 0.184 px (712 dots, 4 blur directions) |
| Recall >= 98% | 100% static, 100% blurred, 100% with +-25% shading |
| 0 false dots on a clean wall | 0 (empty wall, noise sigma 4, with and without shading) |
| Heap delta per frame | none measurable (-3 KB over 300 frames after GC) |
| <= 3 ms at 1080x1920 | best 2.5 ms, median 2.6 ms on the build box (the test asserts best <= 3 ms) |

Size-class hint: 87% of all dots, 83% of landmark dots (20 of 24) on strongly oblique poses.

Test truth: dots that are fully inside the frame (6 px margin) and >= 6 px across. Dots clipped by the
border are not reported; that is deliberate.

## Not covered

Real camera frames (no recorded wall tape exists yet): lens distortion, glare, and real PSF are not in the
synthetic renderer. The detector has no flag of its own; it is inert until M4 wires it behind `arWall`.
