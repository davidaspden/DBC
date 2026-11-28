# M3 — homography toolbox and wall matcher (`src/ar/homography.js`, `src/ar/lattice.js`)

Stage 2 of the AR wall chain: M2 dots -> **M3 correspondences + homography** -> M4 pose tracker.
Inert until M4 wires it behind `arWall` (flags-off behaviour unchanged). Both modules follow the
AGENTS.md memory rules: every buffer, view and option record is created once; per-call code has no
object/array literals, closures, `subarray()` or string building (checked by heap tests).

## `homography.js`

`H` = 3x3 row-major `Float64Array(9)`, wall inches -> image px. `createHomographySolver(maxN)`:

- `fit(sx, sy, dx, dy, idx, n, Hout, opts)` Hartley-normalised DLT, then Gauss-Newton with Huber weights
  on the pixel reprojection error (`opts.huberPx`, `opts.iters`); returns RMS px or -1;
- `fitAffine(...)` least-squares affine (used while a patch is small);
- `ransac(sx, sy, dx, dy, m, Hout, opts, inlierOut)` seeded 4-point RANSAC, then a Huber refit.
- helpers `project`, `invert3`, `jacobianScale` (px^2 per in^2), `rmsPx`.

## `lattice.js` — `createWallMatcher({ layout })`

Layout-agnostic (Tier A and Tier B): the model is just the layout's dot list.

- `match(dots, { width, height, ...priors })` cold start. Seeds on a detected dot and two non-collinear
  neighbours, hypothesises every model dot with a non-collinear neighbour pair, scores each by local
  affine inliers, then grows the best few into full homographies (region growth, local affine while a
  patch is small, outlier dropping, tightening tolerance). Result is a reused object:
  `ok, H, inliers, rmsPx, detToModel[], landmarksSeen, sizeRms, offset, ambiguous`.
- `track(dots, Hprior, opts)` re-fit from a prior homography (what M4 runs every frame): 0.04 ms.
- `evaluate(dots, assignment)` judges any labelling (used to prove shifted labellings are rejected).
- **Priors** resolve the symmetries of the periodic wall: `centerX/centerY/centerTolIn` (wall point under
  the image centre, e.g. the stance) and `axisAngleDeg/axisTolDeg` (image angle of the wall +x axis, e.g.
  from the gyro roll). Without them a view with no origin/axis dot in it is genuinely ambiguous (whole-tote
  copies and a 180 degree turn fit equally well): `match` reports `ambiguous = true, ok = false`
  rather than guessing.
- **Offset check**: observed dot diameter vs `model diameter x local scale` (landmarks are 1.25 / 1.5 / 2 x).
  `offset` is OK / WRONG / UNVERIFIED (no measurable landmark).
- `ok` also needs RMS <= 1 px and at least half of the detections explained.

## Measured (synthetic walls; `tests/ar-homography.test.js`, `tests/ar-lattice.test.js`)

| Acceptance (plan 3) | Result |
|---|---|
| Reprojection RMS <= 0.4 px, yaw/pitch/roll to 40 deg, 6-40 in | worst 0.25 px (298 poses, centroid noise 0.15 px); vs noise-free truth 0.20 px |
| Robust to 20% missing + 10% outlier blobs | worst inlier RMS 0.26 px, outliers accepted <= 1 (105 runs) |
| Wrong-offset detection >= 99% with a landmark visible | one-step shifts 438/438 (100%); whole-tote shifts 62/62 when the origin/axis dot is in view; 0 false "wrong" on correct labellings |
| Zero allocation | heap delta ~0 (fit/ransac 8800 calls; match+track 800 calls: -752 B) |
| Speed | fit 0.025 ms (68 pts); track 0.037 ms; cold-start match 2.7 ms (only on acquisition) |

Cold-start matching quality (with stance + gyro priors): tilt <= 20 deg 54/59 exact, 5 refused, **0 wrong
accepted**; tilt <= 35 deg 30/60 exact, 30 refused, 0 wrong accepted.

## Limits

- Cold-start acquisition is the weak part at strong perspective (tilt > ~25 deg at close range, few dots in view):
  it refuses (`ok = false`) instead of guessing. M4 therefore tracks from a prior pose (`track`) and only
  falls back to `match` when it has lost the wall.
- Whole-tote shifts are indistinguishable unless the origin (x2) or axis (x1.5) dot is in view.
- Verified on synthetic renders only (no recorded wall tape yet).
