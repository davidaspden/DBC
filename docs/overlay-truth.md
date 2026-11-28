# R8 — overlay ground-truth check

`src/sim/overlay-truth.js` + `tests/overlay-truth.test.js` + `tools/overlay-truth.mjs`.

The sim projects each label's 3D corners to image pixels (same matrices as `cpu-render.js`), so the
true label position is known. For frames 720x1280, 1080x1920, 1080x2400, 1920x1080 × poses
(head-on, oblique, rolled) × full frame / crop-at-source × five display boxes
(cover/contain, DPR) it reports:

| metric | meaning | status |
|---|---|---|
| `mappingErrCssPx` | product `createFrameToScreenMapper` (the `overlayAlign` path) vs an independently written CSS object-fit model, on the true label corners | acceptance: <= 3 CSS px (measured ~1e-13) |
| `legacyStretchErrCssPx`, `legacyAssumedSizeErrCssPx` | models of the pre-fix overlay-off defects (canvas stretched to the box; mapping assuming 1920x1080) | documented baseline, up to ~230 / ~700 CSS px |
| `centreErrFracLabel`, `roiIouBars`, `thetaErrDeg` | worker ROI centre/box/angle vs truth, frame px | **separate finding**: ROI centre sits 4-25% of the label length off along the scan axis |
| `overlayErrCssPx` | detection centre mapped by the product mapper vs truth mapped by the true display | end to end; dominated by the detector offset above |

Run: `node tools/overlay-truth.mjs` (add `--json`). Pure test/tool code: not imported by the app or
worker, no flags, no baseline files touched.

The "off" models describe the B2 defect from its description; confirming the exact offset on a real
device is R9's job.
