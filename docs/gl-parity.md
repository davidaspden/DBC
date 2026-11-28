# R6 — GL to CPU parity

SimGate scores with the CPU renderer (`src/sim/cpu-render.js`); `sim.html` shows the WebGL renderer (`src/sim/webgl-wall.js`). R6 checks the two agree, so CPU scores can be trusted for what David sees.

Six fixed cases (`PARITY_CASES` in `src/sim/gl-parity.js`): legacy 2x6 in and FC 2x3.5 in labels, head-on, oblique, rolled, and one stand-back tele view (30 in, 26 deg), 640x360 or 1280x720, noise and glare off. Accept: mean absolute luma difference <= 6/255 inside label rectangles, <= 10/255 elsewhere, and the real worker decodes the same payloads on both frames.

## What is built

- `src/sim/gl-parity.js` — the cases, render options, comparison rules, PGM codec (browser and Node).
- `tools/gl-parity.html` — the GL half. Renders the six poses with the WebGL renderer, reads the luma back, renders the same poses on the CPU in the same page, shows a table (labels / elsewhere / max difference / decodes / PASS or FAIL, and "image is upside down" if a flip would fix it), and offers the GL frames as downloads.
- `tools/gl-parity-check.mjs` — Node check of the downloaded files (re-renders the CPU side and judges).
- `tests/gl-parity.test.js` — CPU side (deterministic, target label decodes on all six cases, GL cells equal the scene cells), the comparison rules (thresholds, flip, blank frame), the checker, and the GL half once `tests/fixtures-sim/gl-parity/` has frames. `--require-gl` makes missing frames a failure.

## The GL half: what David does (about two minutes)

1. In the repo folder: `python3 -m http.server 8000` (the page uses ES modules, so `file://` will not work).
2. In Chrome on the machine with the GPU open `http://localhost:8000/tools/gl-parity.html` and press **1. Run parity**. The page shows the GPU name and a PASS/FAIL table. A red FAIL tells you the case and whether the image is upside down.
3. Press **2. Download results**: it saves `manifest.json` and six `*.pgm.gz` files (allow multiple downloads if Chrome asks).
4. In the repo: `node tools/gl-parity-check.mjs ~/Downloads --install` (use the folder the files went to). On PASS it copies them into `tests/fixtures-sim/gl-parity/`.
5. `node tests/gl-parity.test.js --require-gl`, then commit the fixtures. That is the evidence for changing `baseline/sim-presets.json` status from `cpu-baseline` to `gl-verified`; this patch does not touch the baseline.

If it FAILs, send the downloaded files (or a screenshot of the table) and the difference can be diagnosed.

## What has been run here

The build box has no GPU, but it has Chrome, so the page was run headless on Chrome's software GL (SwiftShader, WebGL2): **all six cases pass.** Mean difference inside labels 0.55 / 3.11 / 0.71 / 0.73 / 1.76 / 1.08 (limit 6), elsewhere 0.23-0.27 (limit 10), and the decoded payload set matches on every case (max single-pixel difference 188 on label edges). Software GL is not a real GPU (precision and texture filtering can differ on a phone or laptop GPU), so the page marks such a run "SOFTWARE renderer" and the checker refuses to count it for `gl-verified`; the status therefore stays `cpu-baseline` until David's GPU run. The headless command used (drop the two SwiftShader flags on a machine with a GPU):

    python3 -m http.server 8765 &
    google-chrome --headless=new --no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader \
      --virtual-time-budget=60000 --dump-dom "http://localhost:8765/tools/gl-parity.html?auto=1"

## Notes

- The GL renderer only takes cells, label height and shadow/noise/glare from the page, so the parity cases stick to the stock legacy and FC scenes (the test asserts the GL cells equal the CPU scene's cells).
- Noise is off because the two renderers seed it differently; glare is off for the same reason (the GL page uses 0.16 live).
