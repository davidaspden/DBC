# The gate: `node tools/verify.mjs --gate` (G6)

`verify` already runs every unit suite and the same-machine harness A/B. `--gate` adds the SimGate on top:
the quick subset is run through the CPU renderer and the real worker, and every row is judged by the rules in
`baseline/thresholds.json`.

```
node tools/verify.mjs --gate                 # quick subset, about 2.5 minutes on 8 cores
node tools/verify.mjs --gate --full          # the whole default matrix + profile group at full length (long, opt-in)
node tools/verify.mjs --gate-only            # just the gate, skip unit suites and the harness A/B
node tools/verify.mjs --gate-only --capture-thresholds   # re-capture references (after an intended change)
node tools/gate/thresholds.mjs --check gate-results/<commit>-gate-quick-<machine>.json   # re-judge a saved run
```

## What the quick subset runs (12 runs)
- the existing SimGate quick set: S01 x4 (10 s, flags off) and `fc-tele-30-3p5` off + `W-fc` at full length;
- the **verticalMode canary**: `S01-a53-8-720` with `single:verticalMode` (10 s);
- the **K9 profile rows**: `prof-ideal` and the four A53 profiles, 2 s, 1 seed, flags off.

## The rules (plan 10.3, provisional)
1. **Flags off, against the reference.** Decode set and coverage identical to the recorded reference, FP not
   above the reference (the documented `fc-tele-30-3p5[off]` oblique-tail FP is in the reference, not hidden),
   time-to-first sum and time-to-all within +/-10%, camera profiles' delivered fps within 5%. These are
   deterministic (seeded, sim-time), so they compare across machines. A changed `deterministicHash` only
   **warns** (the metrics decide); re-capture if the change is intended.
2. **Flags on, against flags off in the same run.** Coverage not worse, FP 0 on FP-gated rows (else not above
   off), time-to-all <= off + 5%, node p50 <= off + 20% (`W-fc`) / + 30% (others), plus 0.5 ms slack.
3. **The canary.** `verticalMode` has no coverage effect on these scenes, so it is held to the reference
   per label: no label may arrive more than 0.1 s later than recorded (about one frame). Breaking the vertical
   cluster window (`src/worker/scanner.worker.js`, the `thetaDeg < 65 || > 115` test) moves every label
   0.2-0.4 s later and fails this check; the label-time sum alone moved only 3.8% and would not.
4. **Absolute floors, all `uncalibrated` until G7**: low-light profile delivers 8.5-11.5 fps (the 10 fps the
   phone showed), locked / normal / torch >= 27 fps, locked >= 2.5x the low-light rate in the same scenario,
   FP 0 on every profile row. The plan's coverage floors (S03 >= 15/16, S04 >= 12/16) need a full snake pass
   per profile (about 8 minutes per seed); they are listed as `report-only` and shown as a warning on `--full`.
5. **Timing** (p50 +10%, p95 +25%, heap not worse) is compared only against `timing[<machine>]` in the
   thresholds file (capture with `--capture-thresholds --capture-timing` on a quiet machine). With no
   baseline for this machine it is skipped and not guessed.

The report JSON goes to `gate-results/<commit>-gate-<mode>-<machine>.json` (git-ignored).

## Known limits
- References were captured on the CPU renderer on a Linux box; the win32 `sim-presets.json` baseline is
  unchanged and is still compared by humans, not by this gate.
- The quick profile rows are 2 s long, so every profile decodes the same 3/16; they gate the camera clock
  (fps, drops) and determinism, not decode quality. Decode quality per profile needs `--full` and G7.
