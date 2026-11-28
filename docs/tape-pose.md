# T1 — Tape-driven camera pose (`simTapePose`)

A sim camera path `tape:<name>` whose orientation comes from the sensors recorded in a `.dbct` tape. The flag is a sim flag (`?sim=simTapePose`, or the Labs panel in `sim.html`) and is OFF by default; with it off the path is never listed and `PATH_DEFINITIONS` / `sampleCameraPose` behave exactly as before (the only change in `paths.js` is an empty registry check).

## What it does

- Rotation from the tape; position from a **stance model** (an IMU cannot give translation):
  - `fixed` (default): standing distance `D` (the scenario's `distanceIn`) at the wall origin; optional slow sway `swayInPerMs2 x low-pass(accel)` (default 0 = none; the gain is a heuristic, not calibrated);
  - `log`: the tape's own pose log (`sensorSample.simPose`).
- Orientation source: `integrated` (default, from `wPanDps/wPitchDps/wRollDps`, trapezoid, starting at the first recorded `q`), `recorded` (the tape's `q`), or `simPose`.
- Honours the tape clock: sampled by time with linear interpolation (dropped or irregular frames are fine); `originSec` says which sim time the first tape frame plays (`'header'` for sim-exported tapes, so the round trip is exact). Past the end the last pose holds and `finished` is set; with `loop` it wraps (the wrap is a jump).
- Works headless: `registerTapePath(name, tape, { enabled: true, ... })` then use `tape:<name>` as `scenario.path` (R5/R7/`runScenarioSeed`). The path's `fixedDurationSec` is the tape length so loop duration comes out right.
- Works in `sim.html`: turn the flag on in Labs, a "Tape pose (.dbct)" file row appears; choosing a tape adds and selects the path.

## Numbers

- Integrating the gyro of a 10 s tape at 30 fps (jittery pan-snake: pan, tilt and roll all moving) reproduces the recorded quaternion within **0.20 deg** max (acceptance 1 deg).
- Gyro bias adds bias x time: 0.05 dps stays inside 1 deg over 10 s; 0.3 dps gives about 3 deg. A real phone gyro needs its at-rest bias removed (the A-stream zeroing does this) or a periodic re-anchor to `q`.
- sim -> tape -> sim: a sim-exported `fc-8-3p5` tape drives the same camera path back within 1e-3 (the tape stores 4 decimals), and the headless gate run on the tape path decodes the same labels (3 vs 3, 0 FP).

## Caveats

- Not checked on a real phone tape (none exist yet): the field names follow the AR and array recorders (`q`, `wPanDps`, `wPitchDps`, `rotRate`, `accel`), and roll from raw `rotRate.alpha` is off unless you give a `rollSign` (its sign on a real device is unverified).
- The per-frame `sensorSample` is one sample per frame, so content above half the frame rate is not in the tape (the 9 Hz tremor is partly lost when integrating at 30 fps; the test tape includes it and still passes).
- The jitter slider is ignored on a tape path (the tape carries its own motion).

## Files

`src/sim/tape-pose.js`, `tests/tape-pose.test.js`, a registry in `src/sim/paths.js`, `fixedDurationSec` in `computePresetLoopDurationSec` (`tools/gate/scenarios.mjs`, `src/sim/labs-scenario.js`), the file row in `sim.html`, an append to `tools/tape-format.md`.
