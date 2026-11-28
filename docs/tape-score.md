# T2 — Golden-tape replay scoring

`tools/gate/tape-score.mjs` replays every `tapes/*.dbct` through the real worker pipeline (via `tools/replay.mjs`) once per flag set and enforces the Plan 1 rule: **the decode set with a flag on must be a superset of the flags-off set, with no new wrong payloads.**

    node tools/gate/tape-score.mjs [tapes...] [--dir tapes] [--sets off,W-fc,W-all]
         [--baseline prev.json] [--json out.json] [--golden] [--require-tapes]

## Output per tape and flag set

decoded payloads, time to first decode per payload (tape clock, seconds from the first frame), false-positive detections (decodes that are not an expected payload; only when the expected payloads are known), worker ms p50/p95/max, and the tape's recorded fps / exposure / ISO. Anything the tape does not carry prints as `unknown` (PP2 will write these; older tapes and real tapes without them are still scored). Tapes from the sim exporter (T4) carry `fps` only.

## Where the expected payloads come from

1. the sidecar `tapes/<name>.json`: `labels[].payload` (an empty list = negative tape, so every decode is wrong);
2. else a sim-exported tape's header `meta.expectedPayloads`;
3. else unknown: R2 is then reported as `unchecked` and only R1 applies.

## Rules (any violation exits 1)

| Rule | Meaning |
|---|---|
| R1 superset | everything flags-off decoded is still decoded with the flag set |
| R2 no new wrong | wrong payloads of the flag set are inside the flags-off wrong set |
| R3 baseline (`--baseline`) | per tape and set, the decode set still contains the baseline's and no new wrong payloads vs the baseline |
| R4 golden (`--golden`) | replays with the tape's own recorded worker mask; every frame's golden payload must decode again |

An empty `tapes/` passes with "no tapes to score" (use `--require-tapes` to fail instead). The scanline stage is put in vertical mode the way the live worker does it: only when the flag set has `verticalMode` and the label orientation is `ladder` (the default; set `labels[].orientation` in the sidecar otherwise).

## `tools/replay.mjs` changes (backwards compatible)

`replayTape(parsed, mask, opts)` gains `opts.vertical`; results gain `maxMs`, `decodedPayloads`, `payloadFrameCounts`, `firstSeen`; new `describeTapeCamera(parsed)`; CLI gains `--vertical`. The old fields and the CLI's output line are unchanged (tested).

## Numbers

On a sim-exported `fc-8-3p5` tape (2.5 s, 960x540): off, W-fc and W-all each decode 3/16 labels, no wrong payloads, no violations. There are no real tapes in the repo yet, so real-tape behaviour is untested; the sidecar contract is `tapes/README.md`.
