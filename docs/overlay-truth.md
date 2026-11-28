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

## B8 — `decodeAnchor` (fix for the detector offset)

R8 showed the worker's reported centre sat 4-25% of the label length off along the scan axis.
Cause: decoded symbol positions are measured from run 0, but the derivative run extractor starts
run 0 at the first *edge*, not sample 0, when a scanline begins on a bar->space edge (tote
background -> label paper). Every start/stop span was therefore shifted by the lead-in distance.

`?flags=decodeAnchor` (worker bit 14, default off) adds the run origin to the span and reports the
mean midpoint of the decoded start-stop spans on the winning scanlines as the label centre (also
corrects `roiX/Y/W/H`, `x0..y1`). Payloads, symbols, angle, confidence and span length are untouched.
Compare: `node tools/overlay-truth.mjs` vs `node tools/overlay-truth.mjs --anchor`.

| R8 matrix (24 cases) | off | `decodeAnchor` |
|---|---|---|
| worst centre error, % of label length | 24.7 | 3.0 |
| worst end-to-end overlay error, CSS px | 104.6 | 13.8 |

The remaining ~3% floor is perspective (the midpoint of a foreshortened span is not the projection
of the 3D midpoint) plus the across-axis position, which comes from where the ROI cluster placed the
scanlines.

### B8 part 2 — default (non-vertical-mode) path

On the real tote still the default path decodes via Tier C (aligned profile averaging) and used to
report the Stage 1 RoI-cluster box and centre. `decodeAnchor` now records the decoded start/stop
positions of the winning Tier C profile, slides the RoI box/centre along the scan axis onto the
decoded bars (the across-axis position stays the RoI's), trims the box length to the decoded span
and reports the decoded span length. `node tools/still-anchor-check.mjs` prints the real-image table
(bars truth measured by eye: y 897..1345, centre (530, 1121)).

| real still, 6 crops | default | `decodeAnchor` |
|---|---|---|
| worst centre error | 98 px | 7 px |
| span length reported (true 448) | 531-756 | 445 |
| box along the scan axis | 552-776 | 470 |

The sim never routes through Tier C (even with noise or blur), so this path is verified on the real
still only.
