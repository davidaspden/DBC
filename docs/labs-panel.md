# R3 — Labs panel in the sim

`sim.html` now has a collapsible **Labs** card (top of the right-hand column), the same idea as the B6 Labs panel in `array.html`.

## What it does

- **Worker flags**: every flag in `src/flags.js` as a checkbox. Toggling writes the flag (same `dbc.flags` storage as the other pages) and the next frame message to the worker carries the new mask, so you can flip a flag while a run is playing. The mask is shown in the header.
- **Sim / AR flags** (`src/sim/simflags.js`): checkboxes too, tagged `[headless]` (the flag has an effect in the CPU/headless run — today only `simFcLabel`) or `[no effect yet]` (the later T/M/L items add their behaviour behind these). None has a live effect in the WebGL page yet.
- **Run parameters**: preset, path, distance, FOV, speed, fps, shutter, jitter, frame size, label — read from the page controls.
- **Camera profile** (K9): a select with the five profiles (`ideal` default). On the live page it post-processes the read-back luma (glare, optics, sensor noise, JPEG) and sets the frame period and shutter blur from the profile's exposure; the A/B run and the downloaded scenario use the full camera clock (rolling-shutter bands too). See `docs/camera-profiles.md`.
- **Run A/B**: renders the current path on the CPU renderer and runs the real scanner worker code twice over the same frames and seed: A = every worker flag off, B = the flags as ticked. Shows decoded/total, false positives, time to all, worker p50 and the mask for both. "half size (fast)" runs at half resolution for a quick look (the numbers are then not what the downloaded scenario will reproduce).
- **Download scenario JSON**: a `dbc-scenario` file (preset, path, camera, label/scene overrides, flags worker + sim, seeds, duration, and the A/B result the page showed if the run was full size).
- **Reset all flags OFF**.

## Reproducing a downloaded scenario headless

    node tools/run-scenario.mjs --scenario dbc-scenario-<preset>.json [--seeds 1,2] [--json out.json]

It runs the same two flag sets through SimGate's own `runScenarioSeed` and prints the same numbers. If the file carries the page's result, each line ends `== page result` or `!= page result` and the exit code is 1 on any difference. `tests/labs-panel.test.js` proves that the browser runner (`src/sim/ab-run.js`) and SimGate give identical decodes, false positives and time-to-all.

`tools/run-scenario.mjs` is a separate file on purpose: `tools/simgate.mjs` is not touched (F6 edits it). After F6 lands, `--scenario` can be one line in simgate that calls `loadScenarioFile`.

## Files

- `src/sim/labs-panel.js` — panel (DOM via injected `document`, so it is tested with a fake DOM) and its pure model.
- `src/sim/labs-scenario.js` — JSON format, validation, and `specFromScenarioJson`.
- `src/sim/ab-run.js` — browser-safe copy of the SimGate seed runner (same seed phase, render options, sub-pose shutter, vertical-mode scanline setting, scoring); pinned to the Node runner by a test.
- `tools/gate/scenario-file.mjs`, `tools/run-scenario.mjs` — headless loader and CLI.
- `tests/labs-panel.test.js`.

## Notes

- Flags-off is unchanged: mounting the panel changes no flag; the page posts `toWorkerMask()` exactly as before.
- The A/B run is CPU-rendered, not the WebGL image, so absolute numbers differ from the live view; it is for comparing flag sets on identical frames.
- Not run in a real browser here (no GPU/display in the build box): the module graph is checked to be free of Node imports, `sim.html`'s script parses, and the panel runs under a fake DOM. David: open `sim.html`, expand Labs, tick a flag, press Run A/B.
