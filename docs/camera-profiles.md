# Camera profiles (K9)

A camera profile bundles the K1-K7 models into one name so the sim, the Labs A/B and the SimGate can ask
"what would the phone see?" instead of "what would a perfect camera see?".

| id | what it is | delivered fps (2 s run, CPU, 1080p preset) |
|---|---|---|
| `ideal` | all off, equals the pre-K9 output byte for byte | the preset's `fpsCap` |
| `a53-fc-normal` | fluorescent warehouse, AE about 16 ms, ISO about 180, rolling 25 ms, mild sharpening, JPEG 85 | about 30 |
| `a53-fc-lowlight-10fps` | about 25 lux: AE at the 100 ms ceiling, ISO about 480, heavy noise, JPEG 75 | about 10 |
| `a53-fc-lowlight-locked` | same light, PP2 behaviour: 5 ms, ISO 3200, min fps 30 (about 1.6 EV dark) | about 30 |
| `a53-torch-glare` | torch on (about +900 lux at 12 in), glossy labels, moving hotspot, fast AE | about 30 |

All numbers are **provisional priors**; G7 fits them against real tapes. `a53-fc-lowlight-locked` predicts
what PP2 would buy; it is only real once PP2 exists in `src/camera.js`. The same bundle lives in
`src/sim/camera-model/profiles.js` and `profiles/<id>.json` (a test fails if they drift).

## Per frame (headless gate and Labs A/B)
`src/sim/camera-model/profile-run.js` is the one loop both use:

1. K2 exposure (AE or locked) and K1 scheduler decide when the frame starts, how long it lasts (the frame
   period is `max(1/fps, exposure)`) and whether the busy worker takes it. The worker time is a fixed
   virtual value (`workerMsModel`), so drops are deterministic.
2. The CPU renderer draws the frame in rolling-shutter bands (K4, 4 bands), each band blurred over the
   exposure window with 1, 5 or 7 sub-poses.
3. K7 glare, K5 optics (defocus/AF hunting, vignette, distortion, sharpening), K3 sensor (shot/read noise, gain
   and tone), K6 JPEG.

## Where it shows up
- `node tools/simgate.mjs --profiles --quick` runs the five profiles (1 seed, 2 s). `--only prof-<profile>` runs one.
  Profile scenarios are opt-in (group `prof`, preset `fc-12-3p5-auto`), so the default matrix and the G3
  baseline are unchanged. Results carry a `camera` block (camera fps, delivered fps, drops, exposure, ISO).
- Labs panel select (live page: post-process on the read-back luma; A/B and scenario JSON: full camera clock).
  A downloaded scenario records `camera: { profile }`.

## Limits
- A profile frame costs about one second at 1080p on a slow box (bands x sub-poses + optics), so the profile runs are short.
- The GL live page has no rolling-shutter bands and uses the real worker for drops.
- The profile is A53 only for now (OQ11).
