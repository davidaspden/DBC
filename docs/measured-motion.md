# T3 — Motion statistics to jitter model (`simMeasuredMotion`)

Real hand motion from real tapes in place of the sim's fixed "jitter %" wobble. Sim flag `simMeasuredMotion`, default OFF.

## Fit a tape

    node tools/tape-motion.mjs tapes/<name>.dbct --out model.json [--distance 10]

Prints, per axis (pan / tilt / roll): rms, p99 and peak angular rate (deg/s), the sweep rate (rms of the 2 s moving average), the pan-vs-tilt-vs-roll split of the motion power, and the sweep along the scan axis in in/s at `--distance`. It fits two models per axis, an AR(2) (Yule-Walker) and the Welch rate spectrum, keeps AR(2) only when its six log-band powers over 0.5-10 Hz are within 10% of the Welch estimate (else the Welch table), writes a `dbc-motion-model` JSON, and self-checks the generator against the tape (acceptance 20%).

Rates come from `wPanDps / wPitchDps / wRollDps` in the tape, else from the derivative of the recorded quaternion. The band's upper edge is clipped to 0.9 x Nyquist (a 13 fps low-light tape only covers up to about 5.9 Hz).

## Use it in the sim

- Headless: `enableMeasuredMotion(model, { enabled: true, seed })` (or with the `simMeasuredMotion` sim flag on); `disableMeasuredMotion()` to go back. R5/R7/`runScenarioSeed` then see the measured wobble through `sampleCameraPose`.
- `sim.html`: tick `simMeasuredMotion` in Labs; a "Motion model (.json)" row appears. Until a model is loaded the built-in default is used.
- Flag off: nothing is installed and `sampleCameraPose` is bit-identical (tested).

## What it replaces, and what it does not

The generator replaces the slider's yaw/pitch/roll wobble only (the slider is then ignored for angles). Breathing in z (distance) stays slider-driven, because a tape's IMU does not measure translation. Moving paths are unchanged.

The generator is a sum of about 325 sinusoids per axis (one per 0.04 Hz cell, each carrying the PSD power of its cell, seeded random phases and small frequency offsets), so it is a pure function of time: any `t` can be asked in any order (sub-frame shutter poses, repeated seeds) and gives the same answer. A recursive AR(2) filter could not do that. Rate amplitude to angle amplitude is `A / (2 pi f)`.

## Conservative default

Until real tapes exist the model is the current slider's wobble written as sinusoid lines at jitter 0.25 (the median of the presets' jitter: 0.15 to 0.30). With the flag on and the default model, poses equal the slider at 0.25 to 1e-9 (tested on three paths).

## Numbers (synthetic 3 min tape at 30 fps: one AR(2) resonance on pan, two resonances on tilt, a broad one on roll)

- The generator's band powers over 0.5-10 Hz (6 log bands) are within **13.2%** of the tape's worst case across 3 seeds x 3 axes x 6 bands, both for the exact sinusoid power and for a Welch estimate of a 600 s generated record (acceptance 20%).
- pan: AR(2) chosen; tilt (two resonances, AR(2) cannot fit): Welch table chosen automatically.
- rms/peak rates, split and sweep match direct computation from the source series within 2%.

## Caveats

- Checked only on synthetic tapes (no real tapes yet). A real tape's rates include the intended sweep: its power below 0.5 Hz is left out of the generator (the path supplies the sweep), but any sweep content above 0.5 Hz is in the model as well as in the path, a small double count.
- The tape has one sample per frame, so the spectrum stops at half the frame rate.
- The wobble model is angular only; it does not correlate with the path.

## Files

`src/sim/measured-motion.js`, `tools/tape-motion.mjs`, `tests/measured-motion.test.js`, `setMeasuredMotionHook` in `src/sim/paths.js` (an empty hook), the Labs row in `sim.html`.
