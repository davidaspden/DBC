# DBC Frame & Sensor Tape Format (`.dbct` v1)

Zero-dependency binary container for recording live phone Y-plane luma frames + sensor samples (`src/tape/record.js`) and replaying them deterministically in Node.js (`tools/replay.mjs`).

## Binary Layout

| Offset | Field | Format |
| :--- | :--- | :--- |
| `0..3` | Magic | ASCII `"DBCT"` |
| `4..7` | Version | `uint32 LE` (`1`) |
| `8..11` | Header JSON length `H` | `uint32 LE` |
| `12..12+H-1` | Header JSON (UTF-8) | `{ version: 1, createdUtc, width, height, codec: "gzip" \| "raw", sensorCount, frameCount, meta }` |
| Followed by `frameCount` Frame Records: | | |
| `+0..3` | Frame meta JSON length `M` | `uint32 LE` |
| `+4..7` | Luma payload byte length `L` | `uint32 LE` |
| `+8..8+M-1` | Frame meta JSON (UTF-8) | `{ frameId, tFrameMs, width, height, cropX, cropY, expectedPayloads, sensorSample }` |
| `+8+M..8+M+L-1` | Luma bytes (`width * height`) | Gzip-compressed (`codec === "gzip"`) or raw `Uint8Array` (`codec === "raw"`) |

## `sensorSample` fields read by the sim (T1, append-only)

`src/sim/tape-pose.js` (`readTapeSensors`) reads only the header and each frame's meta, never the luma. Fields used from `frameMeta.sensorSample` (all optional):

| Field | Meaning |
| :--- | :--- |
| `q` | `[x, y, z, w]` orientation, wall-normal frame (`quatFromPanTiltRollDeg`: pan right +, tilt up +, roll CCW +) |
| `wPanDps`, `wPitchDps` | angular rates in deg/s (pan right +, tilt up +) |
| `wRollDps` | roll rate in deg/s (roll CCW +) |
| `rotRate.alpha` | raw device roll rate; only used when the caller passes a `rollSign` |
| `accel` | `{x, y, z}` m/s^2; only used for the optional stance sway |
| `simPose` | `{x, y, z, yawDeg, pitchDeg, rollDeg}`, written by `tools/sim-to-tape.mjs` and the A10 slide-map log |

The tape clock is `frameMeta.tFrameMs`.
