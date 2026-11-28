# R7 — array mapper in the loop

`src/sim/array-loop.js` + `tests/array-loop.test.js` + `tools/array-loop.mjs` (+ `tools/gate/array-legacy.mjs`).

Real decoder detections from CPU-rendered sim frames, plus synthesised 60 Hz orientation sensors, go through the
real `createOrientationTracker`, `createPanArrayMapper`, `createAutoZeroStateMachine`, `solveAxisRemap` and
`createSlideWallMapper`, wired as `array.html` wires them, and are scored against the sim's truth. Nothing in
`src/array` or `src/wallmap.js` is changed. Test/tool code only (never imported by the app or the worker).

Two stages: `recordStandbackRun` / `recordSlideRun` (render + decode once, flag independent) then `runArrayLoop` /
`runSlideLoop` (replay for one flag set).

Run: `node tools/array-loop.mjs` (`--only s01|s12|standoff|singles|s07`, `--legacy`, `--native`, `--json out.json`).

## What is scored
- **Attribution**: every placed read vs the true cell of that payload (`correct`, `wrong`, `attribution`).
- **Cells**: READ cells that carry the right payload, READ cells with the wrong payload, CONFLICT cells (the sim has no
  duplicate payloads, so every CONFLICT is a false one).
- **Drift (in)**: distance between where the mapper thinks the optical axis hits the wall and where it truly does, per
  frame (mean / p95 / max / final).
- **Time to zero**: first time from which that error stays under 0.3 x the smaller tote pitch to the end of the run.
- **Start orientations (F3)**: `upright`, `rot90/180/270` (sensor frame rotated about the view axis by the screen
  angle), `tilted` (camera held 25 deg rolled).

## What is synthetic (read the scores with this in mind)
- The sensor stream is generated from the sim pose: yaw drift 2 deg/min plus 0.03 deg white noise by default. These are
  parameters, not measurements of a phone.
- How a rotated start shows up in the sensor frame follows the tracker's own documentation (`qCur = qTrue * Rz(screen
  angle)`, world +Z up in gravity mode). That `orientGravityZero` recovers a rotated start therefore confirms the
  tracker and mapper compose correctly; it does not prove a real device reports orientation that way.
- Slide mode flow is derived from the pose delta (flow quality has its own test); gyro is the pose rate plus noise.
- `wTotalDps` for auto-zero is the synthetic gyro magnitude (the headless tracker gets no gyro events).
- The 4 original presets are not stand-back presets (three are close-range translation presets). For the loop they run as
  stand-back variants: their own camera size/fps/noise/jitter/speed on a 30 in, 26 deg rig.
- Frames default to 960x540. Coverage is decoder limited (corner tiles are too oblique at 30 in), so absolute cell counts
  are not an array-mapper score; attribution, wrong cells and drift are.

## Acceptance (plan R7)
- Flags off, the 4 presets map cells identical to the `d917944` mapper (loaded from git history), plus the harder
  tilted and rot90 runs (`tests/array-loop.test.js`, "R7 S01").
- Flags on is no worse (attribution, wrong cells, false conflicts, drift bound) on the 4 presets, and the wrong-start
  orientation gain shows (legacy attribution 0-5% on rot90/180/270, 38% tilted; `orientGravityZero` 100%).

## Findings the loop surfaced (none fixed here; they need a decision)
1. `axisRemapAuto` never fires on the page: `array.html` pushes `{rx, ry, wz}` and passes `dIn`, but `solveAxisRemap`
   reads `{tx, ty, expectedX, expectedY}` and `distanceIn`. With solver-format observations it still cannot recover a
   rotated start (the expected cell is the one the wrong projection snapped to). The wrong-start gain comes from
   `orientGravityZero`, not from `axisRemapAuto`.
2. `driftFromLabel` is a no-op: nothing reads the flag and `anchorObservationToCell` is never called by the page.
3. `nudgeDamp` hurts when the standoff is mis-set (22.5 in vs 30 in true: attribution 71% vs 97% off).
4. `panKalman` repairs a mis-set standoff (ends within 3 in of truth, drift 2.8-3.5 in to 1.2 in) but adds about 0.5 in
   of drift when the standoff is already right.
5. `autoZeroFromLabel` estimates standoff from `roiMajorLen / labelLenIn`, which over-reads (about 37 in for a true 30 in
   on the 6 in label) because the bar span is shorter than the label; it also refuses (`size-mismatch`) when the dialled
   standoff is more than 45% off.
