# GL parity fixtures (R6)

Empty until the GL half has been run on a machine with a real GPU. Then it holds `manifest.json` and one
`<case>.pgm.gz` per case, produced by `tools/gl-parity.html` and installed with
`node tools/gl-parity-check.mjs <download dir> --install`. `tests/gl-parity.test.js` picks them up
automatically. Steps: `docs/gl-parity.md`.
