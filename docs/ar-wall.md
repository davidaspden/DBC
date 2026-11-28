# AR Wall Mode Specification (`docs/ar-wall.md`)

AR Wall Mode lets the real phone camera (optics, noise, auto-exposure, frame rate, motion blur, rolling shutter, ISP compression, and real hand motion) test the DBC barcode decoder and array mapper against a **known ground-truth wall** at home before stepping onto the FC floor.

A flat home wall is marked with high-contrast circular dots at known tote-grid positions. In Wave 1 (`M7a`), `ar.html` records **raw dotted-wall tapes** (uncomposited luma frames + sensor stream + camera metadata + layout sidecar). In Waves 2–3 (`M2–M10`), the tracker detects the dots, solves a homography and camera pose, estimates photometry (PSF, black/white points, shading, noise), composites synthetic Code 128 labels into the luma frame, and scores both the decoder and the array mapper against marker ground truth.

---

## 1. Feature Flags (All Default OFF)

All AR Wall Mode switches live in `src/sim/simflags.js` (resolution order: defaults < `localStorage['dbc.simflags']` < URL `?sim=...`):

| Flag | Default | Purpose |
| :--- | :---: | :--- |
| `arWall` | `false` | Enables `ar.html` and the AR dotted-wall workflow. When off, `ar.html` displays `"AR wall mode is disabled"` and never starts the camera or sensors. |
| `arCompose` | `false` | Enables photometry-matched synthetic label compositing (Waves 2–3). |
| `arGyroPrior` | `false` | Pre-rotates predicted dot positions using inter-frame gyro deltas (Wave 2). |
| `arRecordRaw` | `false` | Records raw uncomposited frames + tracker metadata into `.dbct` tapes (M8). |
| `arShowDots` | `false` | Draws detected dots, landmarks, and reprojection overlay in `ar.html`. |

`ar.html` is reachable by direct URL only (e.g. `ar.html?sim=arWall` or `ar.html?sim=arWall,arRecordRaw`); there is intentionally no navigation link from `index.html`, `array.html`, or `sim.html`.

---

## 2. Wall Coordinate Frame & Configuration

- **Origin `(0, 0)`:** Top-left outer corner of the tote wall.
- **Axes:** `+x` to the right, `+y` downward, measured in **inches**.
- **Configurable Wall Geometry:**
  - `cols` (default `4`), `rows` (default `4`): supports smaller home walls (`2×2`, `3×3`, etc. — OQ10).
  - `pitchX` (default `16` in), `pitchY` (default `14` in): centre-to-centre tote pitch.
  - **UNCONFIRMED (OQ1):** Physical FC tote face orientation (`16×14 in` vs `14×16 in`) and exact interlocked label-to-label pitch are unconfirmed. Never hard-code pitch or wall size; always pass `pitchX`, `pitchY`, `cols`, and `rows` as layout parameters.
  - Wall extent: `wallWidthIn = cols * pitchX`, `wallHeightIn = rows * pitchY` (e.g. `64 × 56 in` for `4×4` at `16×14 in`, or `32 × 28 in` for a `2×2` subset).

---

## 3. Marker Dot Specification

- **Shape:** Solid filled discs.
- **Nominal diameter:** `1.0 in` (`25.4 mm`) by default; acceptable range `0.75–1.5 in`. Values outside `[0.75, 1.5]` emit a layout warning.
- **Polarity (`polarity` field):**
  - `'dark-on-light'` (default): solid matte black discs on a plain light matte wall (white/cream).
  - `'light-on-dark'`: solid matte white discs on a plain dark matte wall.

### Tier A — Hand-Drawn (Minimum)

Designed for hand-marking a blank wall with a tape measure and marker/stickers, suited for mid-range and stand-back work (`> ~20 in`):

- **Tote-corner dots:** `(cols + 1) × (rows + 1)` dots at `(c * pitchX, r * pitchY)` for `c = 0..cols`, `r = 0..rows` (`25` dots for `4×4`).
- **Label-offset dots:** `cols × rows` dots placed **`2.5 in` to the left** of each tote's label centre:
  - `x = (c + 0.5) * pitchX - 2.5`
  - `y = (r + 0.5) * pitchY`
  - (`16` dots for `4×4`; `41` dots total). Keeping the dot offset to the left leaves the real label centre unobstructed (for M12 label-twin testing and clean wall photometry).

### Tier B — Printed Fine Lattice

Designed for close-range capture (`8–12 in`), where the Galaxy A53 5G (`~70.7°` HFOV) only sees roughly `17 × 10 in` (or `~10 × 17 in` in portrait), requiring denser markers so every `8 × 9 in` field of view contains **at least 6 dots**:

- A dot every **`s` inches** along every horizontal tote grid line (`y = r * pitchY`) and every vertical tote grid line (`x = c * pitchX`).
- Default spacing: `sX = pitchX / 4`, `sY = pitchY / 4` (`~3.5–4.0 in`). A custom scalar `s` (in inches) is also supported.
- Tote-corner intersections are deduplicated (one dot per `(x, y)` intersection).

### Landmarks (Global Identification)

Three visibly distinct sizes let the tracker resolve global lattice translation and orientation without coded patterns, while remaining easy to draw by hand:

| Landmark | Position | Diameter Scale | Default Diameter |
| :--- | :--- | :---: | :---: |
| **Origin** (`origin`) | Top-left corner `(0, 0)` (`corner-r0-c0`) | **`×2.0`** | `2.00 in` (`50.8 mm`) |
| **Axis** (`axis`) | Top-right corner `(cols * pitchX, 0)` (`corner-r0-c{cols}`) | **`×1.5`** | `1.50 in` (`38.1 mm`) |
| **Tier-B Tote Corner** (`corner`) | All other tote corners `(c * pitchX, r * pitchY)` in Tier B | **`×1.25`** | `1.25 in` (`31.75 mm`) |
| **Standard dot** | All remaining dots (Tier A corners, label-offset, Tier B grid-line dots) | `×1.0` | `1.00 in` (`25.4 mm`) |

Every layout has **exactly one origin dot** and **exactly one axis dot**.

---

## 4. Measured-Spacing Overrides & Tolerance Warnings

Hand-drawn walls and taped paper tiles are never exact. `src/ar/layout.js` accepts a `measured` override object alongside nominal parameters:

```json
{
  "xs": [0, 16.05, 32.10, 47.95, 64.15],
  "ys": [0, 14.00, 28.05, 42.10, 56.00],
  "dots": [
    { "id": "label-r1-c2", "x": 37.65, "y": 21.10 }
  ]
}
```

- `measured.xs` / `measured.ys`: tape-measured dot-column and dot-row positions in inches.
  - In Tier A, `xs` has length `cols + 1` and `ys` has length `rows + 1` (tote grid columns/rows). Label-offset dots automatically shift with the measured centre of their enclosing tote cell (`(xs[c] + xs[c+1]) / 2 + labelOffsetXIn`).
  - In Tier B, `xs` / `ys` may specify either every lattice column/row OR only the `cols + 1` / `rows + 1` tote grid lines (intermediate lattice dots are piecewise-linearly interpolated between measured tote lines).
- `measured.dots`: optional per-dot `{ id, x, y }` overrides applied after column/row overrides.
- **Tolerance warning:** Whenever any measured `x`, `y`, or per-dot override differs from its nominal coordinate by **more than `0.5 in`** (configurable via `warningToleranceIn`), `createArLayout` records a structured warning in `layout.warnings`.
- **Persistence:** Serialised layout JSON is stored in `localStorage['dbc.ar.layout']` by `ar.html` and saved alongside every recorded tape as a downloadable `.layout.json` sidecar.

---

## 5. Wall & Capture Quality Rules

1. **Visibility:** At least **4 non-collinear dots** in view at all times (≥ 6 recommended for Tier B close range and single-view focal refinement).
2. **Dot size in pixels:** Apparent dot area **≥ 40 px** (diameter ≥ ~7 px) for reliable sub-pixel centroiding and second-moment PSF estimation.
3. **Surface:** Flat, matte wall with even, diffuse lighting. Avoid glossy paint, shiny clear tape over dots, or harsh specular hotspots.
4. **Ink contrast:** Solid matte black ink (or opaque matte vinyl stickers) on light walls so dot cores accurately measure the optical black point and PSF.
5. **Printing (`tools/ar-markers.mjs`):** Always print SVG tiles at **100% / "Actual Size"** (disable "Fit to Page"). Verify the printed `100 mm` / `4 in` scale bar with a ruler before taping. Align adjacent tiles using the `10 mm` overlap strips and corner registration crosshairs.

---

## 6. Honest Limits (Design Decision 9.0(6))

AR Wall Mode is a **camera-realism and pipeline test**, **not** a 3D geometry test of physical totes. Specifically:

1. **Flat wall only — no 3D parallax:** Tote lips and recessed panels are rendered as flat painted shading and depth cues, not true 3D occlusion. Real physical lip parallax at steep oblique yaw/pitch angles is only approximated (and tested in the 3D sim via `simLips`).
2. **Pinhole intrinsics:** Camera intrinsics are estimated from HFOV / frame size and zoom (radial lens distortion correction is optional).
3. **Synthetic lens glare/gloss:** Composited labels do not experience physical light reflection on sticker stock through the camera lens; the compositor synthesises a glare term from measured wall highlights when present.
4. **Drawn lip shadows:** Shadows cast onto labels by upper tote lips are painted by the compositor rather than optically cast by physical geometry.

Because of these limits, passing AR Wall Mode cannot replace floor validation; it complements the repeatable headless sim by supplying genuine camera noise, auto-exposure, frame-rate collapse, rolling shutter, optics blur, and human hand motion.

---

## 7. Performance Budgets (Design Decision 9.0(7))

Main-thread AR budgets on Samsung Galaxy A53 5G (`1080×1920`), reported **separately** and never added to the 25 ms barcode decoder budget:

- **Tracker (`M2–M4`):** ≤ `3 ms` median per frame (falls back to 1/4-resolution dot pass if needed).
- **Compositor (`M5–M6`):** ≤ `6 ms` median per frame (capped to labels inside a margin around the guide if needed).
- **Hot-loop memory:** Zero per-frame heap allocations in tracker, photometry, and compositor inner loops.

---

## 8. Raw Tape Recording & File-Size Guidance (`M7a` / `M8`)

`ar.html` records **raw uncomposited Y-plane luma frames** (no labels drawn) plus orientation/motion sensor samples and per-frame `meta.camera` (`exposureTime`, `iso`, measured `fps`, `width`, `height`, `zoom`, `focusDistance`) into a `.dbct` v1 tape (via `src/ar/tape.js`, wrapping `src/tape/record.js`), paired with a downloadable JSON layout sidecar.

### Estimated Tape Sizes & Practical Limits

A single uncompressed Y-plane luma frame is `width × height` bytes:

| Capture Mode | Raw Frame Size | Est. Gzipped Frame (matte wall) | 30 s @ 30 fps (900 f) | 60 s @ 30 fps (1800 f) | Notes |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`1920×1080` (1080p full)** | 2.07 MB | ~0.12–0.22 MB (low noise) / ~0.5–0.9 MB (high ISO) | ~110–200 MB | ~220–400 MB | Fits `< 400 MB` target for 60 s in normal light; high-ISO noisy footage compresses worse. |
| **`1280×720` (720p full)** | 0.92 MB | ~0.06–0.12 MB (low noise) / ~0.25–0.45 MB (high ISO) | ~55–110 MB | ~110–220 MB | **Recommended for long sessions (> 60 s)** or low-light high-ISO tests. |
| **Centre-band crop (e.g. 60%)** | 0.75 MB (1080p) / 0.33 MB (720p) | ~0.04–0.15 MB | ~35–135 MB | ~70–270 MB | Cuts memory & download size by ~2.5× while keeping the centre strip at full native resolution. |
| **Subsample (`everyNth = 2`, 15 fps)** | Same per frame | Half frame count | ~55–100 MB | ~110–200 MB | Useful for slow stand-back sweeps when keeping full 1080p. |

**Guidance for mobile Chrome (Android):**
- Because `.dbct` frames are buffered in RAM until **Stop & Save**, keep sessions within ~300–350 MB on 6–8 GB phones (e.g. 60 s at 1080p in normal light, or switch to **720p** / **guide-band crop** for longer sessions or dim high-ISO scenes).
- Always download **both** the `.dbct` tape and its `.layout.json` sidecar together so offline replay (`M9`) knows the exact measured wall coordinates.

---

## 9. Printable & Hand-Draw Workflow (`M1`)

Generate printable 1:1 SVG tiles, a taping overview, and a Tier-A hand-draw ruler table with Node built-ins only:

```bash
# Tier B printed lattice (A4 tiles, 10 mm overlap)
node tools/ar-markers.mjs --pitchX 16 --pitchY 14 --cols 4 --rows 4 --tier B --paper A4 --out out/ar-markers

# Tier A hand-draw ruler table + Letter overview (e.g. 3x3 home wall subset)
node tools/ar-markers.mjs --pitchX 16 --pitchY 14 --cols 3 --rows 3 --tier A --paper Letter --out out/ar-tierA
```

---

## 10. Open Questions & Wave 4 Acceptance Placeholders

- **OQ10 (Home wall):** Confirm wall colour/finish, usable wall width/height (`2×2`, `3×3`, or `4×4`), and whether printed Tier B A4/Letter tiles or hand-drawn Tier A marks are used.
- **M11 (Real home-wall acceptance — Wave 4):** *Pending hardware capture & M2–M7b.* Record 3 raw tapes (normal light, dim, torch), verify ≥ 90% tracker availability at 12 in, ≤ 0.5 in ruler-verified pose error at 16th cell edge, and A53 AR timing within budget.
- **M12 (Label-twin validation — Wave 4):** *Pending hardware capture & M6/M9.* Compare one physical printed `tsX` 2×3.5 in label against a composited twin in the same frames (target: decode success within 10 pp, time-to-lock within 25%).
