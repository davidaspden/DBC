#!/usr/bin/env node
/**
 * R8 CLI: prints the overlay ground-truth matrix (see src/sim/overlay-truth.js).
 *   node tools/overlay-truth.mjs [--preset fc-8-3p5] [--cell 5] [--json]
 * Exit code 1 if the overlayAlign mapping error exceeds 3 CSS px in any case.
 */
import { createSceneForPreset } from '../src/sim/presets.js';
import { runOverlayMatrix, OVERLAY_MAPPING_TOL_CSS_PX } from '../src/sim/overlay-truth.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const preset = opt('--preset', 'fc-8-3p5');
const cellIndex = Number(opt('--cell', '5'));
const { rows, summary } = runOverlayMatrix({ scene: createSceneForPreset(preset), cellIndex });

if (args.includes('--json')) {
  console.log(JSON.stringify({ preset, cellIndex, summary, rows }, null, 2));
} else {
  const f = (v, n = 1) => (v == null ? '-' : v.toFixed(n));
  console.log(`overlay ground truth: preset ${preset} cell ${cellIndex}`);
  console.log('frame      pose          crop  ctrErr%lbl  iouBars  thErr  mapErr(max)  legacyStretch(max)  legacyAssumed(max)  e2e(max)');
  for (const r of rows) {
    if (!r.ok) {
      console.log(`${r.frame.padEnd(10)} ${r.pose.padEnd(13)} ${r.crop ? 'crop' : 'full'}  skipped: ${r.reason}`);
      continue;
    }
    const d = r.detection;
    const mx = (k) => Math.max(...r.displays.map((x) => x[k] || 0));
    console.log(
      `${r.frame.padEnd(10)} ${r.pose.padEnd(13)} ${(r.crop ? 'crop' : 'full').padEnd(5)} ` +
        `${d ? f(d.centreErrFracLabel * 100) : '-'}`.padEnd(11) +
        ` ${d ? f(d.roiIouBars, 2) : '-'}`.padEnd(9) +
        ` ${d ? f(d.thetaErrDeg) : '-'}`.padEnd(7) +
        ` ${mx('mappingErrCssPx').toExponential(1)}`.padEnd(13) +
        ` ${f(mx('legacyStretchErrCssPx'))}`.padEnd(20) +
        ` ${f(mx('legacyAssumedSizeErrCssPx'))}`.padEnd(20) +
        ` ${f(mx('overlayErrCssPx'))}`
    );
  }
  console.log('summary', JSON.stringify(summary));
}
const pass = summary.maxMappingErrCssPx <= OVERLAY_MAPPING_TOL_CSS_PX && summary.skipped === 0;
console.error(pass ? 'R8 PASS: mapping error within 3 CSS px' : 'R8 FAIL');
process.exit(pass ? 0 : 1);
