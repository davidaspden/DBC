# Recorded Tapes (`tapes/`)

This folder stores real-world and exported `.dbct` frame + sensor tapes for deterministic offline replay (`tools/replay.mjs`) and fidelity scoring (Master Plan 3, stream T / G7).

## Folder Contract

Every tape consists of a matched pair of files sharing the same `<name>` stem:

```text
tapes/
├── README.md
├── <name>.dbct   # Binary v1 gzip-compressed Y-plane + sensor tape (see tools/tape-format.md)
└── <name>.json   # Human/machine-readable metadata sidecar describing capture conditions
```

Choose short, lowercase, hyphen-separated `<name>` stems (for example `a53-fc-row1-dim-20261201`).

## Sidecar JSON Schema (`tapes/<name>.json`)

```json
{
  "version": 1,
  "name": "a53-fc-row1-dim-20261201",
  "recordedUtc": "2026-12-01T14:22:00Z",
  "device": {
    "model": "SM-A536B",
    "diagReportId": "cc0f88",
    "cameraLabel": "camera 0, facing back",
    "resolution": "1080x1920",
    "exposureMode": "manual",
    "exposureMs": 4.0,
    "iso": 1600,
    "torch": false
  },
  "lighting": {
    "condition": "dim-warehouse",
    "lux": null,
    "notes": "Overhead fluorescent aisles, slight overhead glare"
  },
  "distance": {
    "nominalIn": 10,
    "rangeIn": [8, 12],
    "measuredBy": "tape-measure"
  },
  "labels": [
    {
      "payload": "tsX07wz7py1",
      "cell": "R1C1",
      "orientation": "ladder",
      "sizeIn": [2.0, 3.5]
    }
  ],
  "notes": "Single horizontal sweep across top row; no deliberate pauses."
}
```

### Field Reference

| Field | Required | Description |
| :--- | :--- | :--- |
| `device` | Yes | Phone model, optional `diag.html` report id, camera label, resolution, exposure/ISO/torch settings (use `null` or `"unknown"` if not recorded). |
| `lighting` | Yes | Lighting condition (`bright`, `normal-warehouse`, `dim-warehouse`, `low-light`, `torch`), optional measured `lux`, and free-text observations. |
| `distance` | Yes | Approximate standoff distance in inches (`nominalIn`, optional `rangeIn`) and how it was measured. |
| `labels` | Yes | Expected barcode payloads visible in the tape (empty array `[]` for negative/no-label tapes). Each entry gives `payload` and optional `cell`, `orientation`, and physical `sizeIn`. |
| `notes` | Optional | Motion pattern, focus behaviour, defects, tote pitch/lip observations, or anomalies. |

## Replaying a Tape

```bash
node tools/replay.mjs tapes/<name>.dbct
node tools/replay.mjs tapes/<name>.dbct --flags=verticalMode,cribMatch,requirePrefix
```

Flags-on replay must decode a superset of the flags-off payload set with zero new wrong payloads (verified against `labels` in the sidecar when present).

## Scoring tapes (T2, gate scenario S15)

```bash
node tools/gate/tape-score.mjs                       # every tapes/*.dbct, flag sets off, W-fc, W-all
node tools/gate/tape-score.mjs tapes/<name>.dbct --sets off,W-fc,verticalMode,cribMatch
node tools/gate/tape-score.mjs --json out.json       # save a result; later: --baseline out.json
node tools/gate/tape-score.mjs --golden              # also require each frame's golden payloads to decode again
```

Per tape and flag set it prints the decode set, time to first decode per payload (tape clock), false-positive detections, worker ms (p50/p95/max) and the tape's recorded fps / exposure / ISO (`unknown` when the tape has none). Exit code 1 on a violation. See `docs/tape-score.md`.
