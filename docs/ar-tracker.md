# M4 — AR wall tracker and pose (`src/ar/pose.js`, `src/ar/tracker.js`), flag `arWall`

Third stage of the AR wall chain: M2 dots -> M3 matcher/homography -> **M4 pose + tracker**.
Nothing in the live scan path imports it yet; `createWallTracker` is inert unless the `arWall` sim flag
(default OFF) or `cfg.enabled` is on (a disabled tracker returns `DISABLED` at once, reads nothing).

## `pose.js`

`createPoseSolver().solve(H, fx, fy, cx, cy, refX, refY, out)` decomposes the wall->image homography with the
pinhole intrinsics (`K^-1 H = lambda [r1 r2 t]`, nearest rotation by polar iteration). `(refX, refY)` is a wall
point known to be in view (it fixes the sign of `H`; the wall origin itself may be behind the camera).
Output (reused record, `createPoseResult()`): `R`, `C` (camera centre in the wall frame, inches),
`distanceIn`, `aimX/aimY` (where the optical axis meets the wall), `yawDeg/pitchDeg/rollDeg`
(yaw right +, pitch up +, roll about the optical axis; same convention as the sim camera).
Exact on noise-free homographies (200 random poses incl. 45 deg tilts and any roll: < 1e-6).

## `tracker.js`

`createWallTracker({ layout, width, height, hfovDeg | fx, enabled, maxCoast = 6, minInliers = 6, maxRmsPx = 1 })`,
`update(luma, rotDelta?)` returns a reused status record (`state, dots, inliers, rmsPx, coast, poseValid, pose, H`).

| State | Meaning |
|---|---|
| `LOCKED` | the previous map, moved by the measured image velocity (or the gyro increment), re-fits to the dots with `matcher.track` (~0.04 ms) |
| `COASTING` | re-fit failed (blur, occlusion, too few dots): pose predicted from the last map + damped velocity, up to `maxCoast` frames |
| `LOST` | coasting ran out: a cold-start `matcher.match` runs every frame with priors (`setPriors(...)`, else the last good pose with wide tolerances) |
| `DISABLED` | flag off |

`setPriors(centerX, centerY, centerTolIn, axisAngleDeg, axisTolDeg)` supplies the stance and the gyro roll for the
first acquisition (the periodic wall is otherwise ambiguous, see `docs/ar-lattice.md`).
`rotDeltaFromGyro(wx, wy, wz, dt, out)` builds a camera rotation increment (`w` in rad/s in the camera frame; +y = camera
turns right; verified against two rendered cameras with the same centre). Passing it to `update` pre-rotates the previous
map (`K Rd K^-1 H`), i.e. the `arGyroPrior` behaviour. **Unverified on a real phone: the sign of the raw sensor rates.**

## Measured (synthetic walls, 360x640 / 540x960; `tests/ar-tracker.test.js`)

| Acceptance (plan 3) | Result |
|---|---|
| Position error <= 0.3 in at 12 in | worst 0.007 in (13/14 poses locked) |
| Position error <= 1 in at 30 in | worst 0.004 in (14/14 locked) |
| Angle error <= 1 deg | worst 0.010 deg |
| Reprojection RMS <= 0.5 px | worst 0.024 px |
| LOCKED >= 95% | 90/90 frames of a hand-motion path at 20 in |
| Coasting recovers after a 5-frame dropout | 5 COASTING frames, LOCKED on the first good frame, centre error 0.00 in |
| Dropout longer than `maxCoast` | goes LOST, cold start re-acquires |
| Fast pan (4 deg/frame) | gyro prior keeps 7/7 frames locked; without it 0/7 |
| Zero allocation | -65 B/frame after JIT warm-up over 600 updates (i.e. none) |
| Speed (1080x1920, ~29 dots) | update best 2.6 ms, median 2.9 ms (detector ~2.5 ms + track/pose ~0.1 ms) |

The errors are tiny because the synthetic frames carry no lens distortion, rolling shutter or ISP effects; they bound the
algorithmic error only. Real-wall acceptance (M11) needs a recorded wall tape.

## Memory

Per AGENTS.md: all buffers are allocated in `createWallTracker`; scalar state lives in a `Float64Array` (a closure-captured
`let` holding a double boxes a heap number on every write); no literals, closures or `subarray()` on the frame path.
