/**
 * M6 — AR label compositor (`src/ar/compose.js`), behind the `arCompose` sim flag (default OFF).
 *
 * Draws the scene's synthetic labels into a live (or taped) camera luma frame, using the tracker's
 * wall->image homography (M4) and the measured wall photometry (M5), so the worker sees labels that
 * look like they were really stuck on the dotted wall.
 *
 * Wall frame: inches, origin at the top-left outer corner of the tote wall, +x right, +y down (the M0
 * layout frame). Cell (r, c) centre = ((c + 0.5) pitchX, (r + 0.5) pitchY), plus the scene's per-cell
 * label offset (scene cells are wall-centred with +y up; converted once at create time).
 *
 * Per label whose projected quad meets the frame:
 *   1. every pixel of the padded bounding box is mapped through H^-1 to the label plane; the
 *      module-integrated coverage uses the CPU renderer's `sampleBarcodeIntegrated1D` with the pixel
 *      footprint taken from the exact derivative of H^-1 (same function, same footprint rule);
 *   2. coverage -> luma between the measured black and paper (paper x `labelPaperRel`, default 0.95),
 *      both multiplied by the measured shading plane;
 *   3. the label edge is anti-aliased over 1 px (coverage alpha) onto the real wall pixels, and that sharp
 *      composite is blurred with the measured PSF (separable Gaussian, sigma = `psfSigmaPx`, radius <= 8 px,
 *      clamp-to-edge). Only pixels within the PSF radius of the label are written back, so the blur
 *      feathers into the wall; real wall pixels in that thin ring are blurred once more (accepted: <= r px);
 *   4. matched noise (seeded integer PRNG, sigma = `noiseSigma`) is added, weighted by alpha;
 *   5. optional ISP sharpening (`sharpenGain`, default 0 = off: M5 does not measure overshoot yet).
 *
 * Not drawn (documented in docs/ar-compose.md): lips/shadow bands (L4), defects (L7), negatives (L6),
 * rolling-shutter per-row pose and anisotropic (motion) PSF direction. These are follow-ups.
 *
 * Memory: all buffers are allocated in `createCompositor`; `compose` allocates nothing.
 */
import { encodeCode128B, sampleBarcodeIntegrated1D } from '../sim/label.js';
import { invert3 } from './homography.js';
import { isSimOn } from '../sim/simflags.js';

const MAX_RADIUS = 8;

/**
 * @param {{ width: number, height: number, scene: object, enabled?: boolean, labelPaperRel?: number,
 *           sharpenGain?: number, maxBoxPx?: number }} cfg
 */
export function createCompositor(cfg) {
  const W = cfg.width | 0;
  const Hh = cfg.height | 0;
  const scene = cfg.scene;
  const enabled = cfg.enabled === undefined ? isSimOn('arCompose') : Boolean(cfg.enabled);
  const paperRel = cfg.labelPaperRel ?? 0.95;
  const sharpenGain = cfg.sharpenGain ?? 0;
  const lbl = scene.label;
  const isPicket = lbl.orientation === 'picket';
  const halfBW = lbl.widthIn * 0.5;
  const halfBH = lbl.heightIn * 0.5;
  const invLabelW = 1 / lbl.widthIn;
  const invLabelH = 1 / lbl.heightIn;
  const barHalfSpan = Math.max(0, (isPicket ? lbl.heightIn : lbl.widthIn) * 0.5 - (lbl.sideMarginIn || 0));
  const printGain = lbl.printGain ?? 1.0;
  const quiet = lbl.quietModules ?? 10;

  const n = scene.cells.length;
  const cellX = new Float64Array(n);
  const cellY = new Float64Array(n);
  const modules = new Array(n);
  const totalModules = new Int32Array(n);
  const halfWall = scene.wallWidthIn * 0.5;
  const halfWallH = scene.wallHeightIn * 0.5;
  for (let i = 0; i < n; i++) {
    const c = scene.cells[i];
    const sx = (c.labelCx ?? c.cx);
    const sy = (c.labelCy ?? c.cy);
    cellX[i] = sx + halfWall;
    cellY[i] = halfWallH - sy;
    const enc = encodeCode128B(c.payload, quiet);
    modules[i] = enc.modules;
    totalModules[i] = enc.totalModules;
  }

  const maxBox = cfg.maxBoxPx || W * Hh;
  const P = new Float32Array(maxBox);   // premultiplied label luma
  const A = new Float32Array(maxBox);   // coverage alpha
  const T = new Float32Array(maxBox);   // blur scratch
  const kern = new Float32Array(2 * MAX_RADIUS + 1);
  const Hi = new Float64Array(9);
  const corner = new Float64Array(8);
  const stats = { enabled, labelsDrawn: 0, pixels: 0, sigmaPx: 0, radius: 0 };
  let rng = 1;

  function nextU() { // xorshift32 in [0, 1)
    rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  }

  function blurSep(x0, x1, y0, y1, bw, radius) {
    // separable Gaussian on P and A (box-local, clamp-to-edge); row-major loops for cache locality
    const bh = y1 - y0 + 1;
    {
      const B = P;
      for (let y = 0; y < bh; y++) {
        const row = y * bw;
        for (let x = 0; x < bw; x++) {
          let acc = 0;
          if (x >= radius && x < bw - radius) {
            const base = row + x - radius;
            for (let k = 0; k <= 2 * radius; k++) acc += kern[k] * B[base + k];
          } else {
            for (let k = -radius; k <= radius; k++) {
              let xx = x + k; if (xx < 0) xx = 0; else if (xx >= bw) xx = bw - 1;
              acc += kern[k + radius] * B[row + xx];
            }
          }
          T[row + x] = acc;
        }
      }
      for (let y = 0; y < bh; y++) {
        const row = y * bw;
        for (let x = 0; x < bw; x++) B[row + x] = 0;
        for (let k = -radius; k <= radius; k++) {
          let yy = y + k; if (yy < 0) yy = 0; else if (yy >= bh) yy = bh - 1;
          const w = kern[k + radius]; const src = yy * bw;
          for (let x = 0; x < bw; x++) B[row + x] += w * T[src + x];
        }
      }
    }
  }

  /**
   * @param {Uint8Array} luma  raw camera frame (W x H)
   * @param {ArrayLike<number>} Hm  wall(in) -> image(px) homography, row-major 3x3
   * @param {object} ph  M5 photometry result (whitePoint, blackPoint, shadingGx/Gy, noiseSigma, psfSigmaPx)
   * @param {Uint8Array} out  output frame (may be `luma`)
   * @param {number} [seed=1]
   * @returns {number} labels drawn
   */
  function compose(luma, Hm, ph, out, seed = 1) {
    stats.labelsDrawn = 0; stats.pixels = 0;
    if (!enabled) { if (out !== luma) out.set(luma); return 0; }
    if (out !== luma) out.set(luma);
    if (!ph || !invert3(Hm, Hi)) return 0;
    const white = ph.whitePoint; const black = ph.blackPoint;
    const gx = ph.shadingGx || 0; const gy = ph.shadingGy || 0;
    const noise = ph.noiseSigma || 0;
    let sigma = ph.psfSigmaPx || 0;
    let radius = sigma > 0.05 ? Math.ceil(3 * sigma) : 0;
    if (radius > MAX_RADIUS) { radius = MAX_RADIUS; sigma = MAX_RADIUS / 3; }
    stats.sigmaPx = sigma; stats.radius = radius;
    if (radius > 0) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); kern[k + radius] = v; s += v; }
      for (let k = 0; k <= 2 * radius; k++) kern[k] /= s;
    }
    rng = (seed | 0) || 1;
    const invW = 1 / W; const invH = 1 / Hh;
    const paperLuma = white * paperRel;

    for (let i = 0; i < n; i++) {
      const Xc = cellX[i]; const Yc = cellY[i];
      // projected corners -> bbox
      let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      let behind = false;
      for (let k = 0; k < 4; k++) {
        const X = Xc + ((k === 1 || k === 2) ? halfBW : -halfBW);
        const Y = Yc + (k >= 2 ? halfBH : -halfBH);
        const w = Hm[6] * X + Hm[7] * Y + Hm[8];
        if (!(w > 1e-9)) { behind = true; break; }
        const u = (Hm[0] * X + Hm[1] * Y + Hm[2]) / w;
        const v = (Hm[3] * X + Hm[4] * Y + Hm[5]) / w;
        corner[2 * k] = u; corner[2 * k + 1] = v;
        if (u < minX) minX = u; if (u > maxX) maxX = u;
        if (v < minY) minY = v; if (v > maxY) maxY = v;
      }
      if (behind) continue;
      const pad = radius + 2;
      let x0 = Math.floor(minX) - pad; let x1 = Math.ceil(maxX) + pad;
      let y0 = Math.floor(minY) - pad; let y1 = Math.ceil(maxY) + pad;
      if (x1 < 0 || y1 < 0 || x0 >= W || y0 >= Hh) continue;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= W) x1 = W - 1; if (y1 >= Hh) y1 = Hh - 1;
      const bw = x1 - x0 + 1; const bh = y1 - y0 + 1;
      if (bw * bh > maxBox) continue;
      const mods = modules[i]; const tm = totalModules[i];

      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        const row = (y - y0) * bw;
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5;
          const w = Hi[6] * px + Hi[7] * py + Hi[8];
          const iw = 1 / w;
          const X = (Hi[0] * px + Hi[1] * py + Hi[2]) * iw;
          const Y = (Hi[3] * px + Hi[4] * py + Hi[5]) * iw;
          const lx = X - Xc; const ly = Yc - Y; // label frame, +y up (as in cpu-render)
          const ax = lx < 0 ? -lx : lx; const ay = ly < 0 ? -ly : ly;
          // inches per pixel along x and y (exact derivative of H^-1)
          const dXdx = (Hi[0] - X * Hi[6]) * iw; const dXdy = (Hi[1] - X * Hi[7]) * iw;
          const dYdx = (Hi[3] - Y * Hi[6]) * iw; const dYdy = (Hi[4] - Y * Hi[7]) * iw;
          const inPerPx = Math.sqrt(Math.abs(dXdx * dYdy - dXdy * dYdx));
          const edgePx = Math.min(halfBW - ax, halfBH - ay) / inPerPx;
          let a = edgePx + 0.5;
          const o = row + (x - x0);
          A[o] = edgePx;
          if (a <= 0) { P[o] = out[y * W + x]; continue; }
          if (a > 1) a = 1;
          let cov = 0;
          const inBars = isPicket ? (ay <= barHalfSpan) : (ax <= barHalfSpan);
          if (inBars) {
            let v01; let dv;
            if (!isPicket) { v01 = (halfBH - ly) * invLabelH; dv = Math.sqrt(dYdx * dYdx + dYdy * dYdy) * invLabelH; }
            else { v01 = (lx + halfBW) * invLabelW; dv = Math.sqrt(dXdx * dXdx + dXdy * dXdy) * invLabelW; }
            if (v01 >= 0 && v01 <= 1) cov = sampleBarcodeIntegrated1D(mods, tm, v01, dv, printGain);
          }
          const shade = 1 + gx * (px * invW - 0.5) + gy * (py * invH - 0.5);
          const val = (paperLuma + (black - paperLuma) * cov) * shade;
          P[o] = val * a + (1 - a) * out[y * W + x];
        }
      }
      if (radius > 0) blurSep(x0, x1, y0, y1, bw, radius);

      let drawn = 0;
      const reach = -radius - 0.5;
      for (let y = y0; y <= y1; y++) {
        const row = (y - y0) * bw;
        const fo = y * W;
        for (let x = x0; x <= x1; x++) {
          const o = row + (x - x0);
          const e = A[o];
          if (e <= reach) continue;
          let a = e + 0.5; if (a < 0) a = 0; else if (a > 1) a = 1;
          let v = P[o];
          if (noise > 0 && a > 0) v += a * noise * (nextU() + nextU() + nextU() + nextU() - 2) * 1.7320508;
          if (sharpenGain > 0 && x > x0 && x < x1) {
            // unsharp on the blurred label against its horizontal neighbours (label pixels only)
            v += sharpenGain * a * (P[o] - 0.5 * (P[o - 1] + P[o + 1]));
          }
          out[fo + x] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
          drawn++;
        }
      }
      if (drawn > 0) { stats.labelsDrawn++; stats.pixels += drawn; }
    }
    return stats.labelsDrawn;
  }

  return { compose, stats, enabled };
}

/** Pinhole homography for a head-on camera at `distanceIn` aimed at wall point (aimX, aimY) (wall frame). */
export function headOnHomography(width, height, hfovDeg, distanceIn, aimX, aimY, out) {
  const f = (width / 2) / Math.tan((hfovDeg * Math.PI) / 360);
  const s = f / distanceIn;
  out[0] = s; out[1] = 0; out[2] = width / 2 - s * aimX;
  out[3] = 0; out[4] = s; out[5] = height / 2 - s * aimY;
  out[6] = 0; out[7] = 0; out[8] = 1;
  return out;
}
