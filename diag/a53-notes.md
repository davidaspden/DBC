# Samsung Galaxy A53 5G (`SM-A536B`) — Real Diagnostics Findings (D2)

Captured `2026-11-28 04:51 GMT` (`id:cc0f88`, Android 16.0.0, Chrome 160.0.8181.0, `412×915 CSS px`, DPR `2.625`, `portrait-primary`, `screen.orientation.lock` supported).

## Key Hardware Findings

1. **Camera Ordering Trap:** Chrome lists `camera 2, facing back` (ultrawide, `4000×3000`, `focusMode: ["manual"]`, **no torch**) *before* `camera 0, facing back` (64MP/16MP binned main, `4624×3468`, `focusMode: ["manual", "single-shot", "continuous"]`, **`torch: true`**). Camera selection must prefer the rear camera with `continuous` AF + `torch` (`camera 0`).
2. **Full Manual Exposure & Focus Support on Main Rear (`camera 0`):**
   - `exposureMode: ["continuous", "manual"]`
   - `exposureTime: 0.42–1000 step 0.1` (100 µs units → **1/500 s = 20 units** works natively!)
   - `iso: 50–3200 step 1`
   - `focusDistance: 0.1–3.6 step 0.01` (10 cm close focus works natively!)
   - `zoom: 1–8 step 0.1` (lossless ~2× ISP sensor crop from the `4624×3468` main sensor; no physical telephoto lens)
   - True portrait resolutions: `720×1280@30`, `1080×1920@30`, **`2160×3840@30` (4K portrait)**, with WebCodecs `VideoFrame` **`I420` direct Y-plane copy**.
3. **10.1 fps Auto-Exposure Floor:** `rVFC` measured `10.1 fps` in ambient indoor light under auto exposure — locking manual fast shutter (`1/250 s – 1/500 s`, C4) both kills motion blur and unlocks higher frame rate.
4. **Critical Sensor Finding (`RelativeOrientationSensor` stalled at 1 Hz!):**
   - `Gyroscope`: **59.8 Hz** (56 samples/s) — reliable!
   - `Accelerometer`: **60.4 Hz** (57 samples/s) — reliable!
   - `RelativeOrientationSensor`: **1 sample / 1 Hz** — stalled on A53!
   - `GravitySensor`: **1 sample / 1 Hz** — stalled on A53!
   - **Action taken:** `src/array/orient.js` now validates live streaming rate (`>= 3` samples in `450 ms`) before trusting `RelativeOrientationSensor`, falling through cleanly to **60 Hz `Gyroscope` + 60 Hz `Accelerometer` low-pass gravity fusion**!

## Confirmed FC Floor Spec (OQ1–OQ3)
- Tote face: **`16 in wide × 14 in high`** (`16Wx14H`, 4×4 wall = `64 in × 56 in`).
- Barcodes: **Ladder** orientation (horizontal stripes, vertical `90°` scan), ~`2 in × 3.5 in`, all starting with **`tsX`**.
- Sweep strategy: **Horizontal row passes** (sideways across the stripes = near-zero scanline blur), quick vertical step between rows.
