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
