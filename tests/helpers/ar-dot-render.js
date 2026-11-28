/**
 * Test-side synthetic renderer for AR dot walls (used by M2-M5 tests; never imported by the app).
 *
 * Wall frame (as `src/ar/layout.js`): origin top-left, +x right, +y down (inches), +z INTO the wall.
 * The camera looks at wall point `aim` from distance `distanceIn` with yaw (right +), pitch (up +) and
 * roll (about the optical axis), pinhole with `hfovDeg` across the frame width.
 *
 * Renders the layout's dots as discs (supersampled), then optional shading, Gaussian PSF, linear motion
 * blur and Gaussian noise (seeded). Returns the luma plus exact ground truth.
 */
import { mulberry32 } from '../../src/sim/prng.js';

const D2R = Math.PI / 180;

export function cameraFromPose(p, width, height, hfovDeg) {
  const yaw = p.yawDeg * D2R;
  const pit = p.pitchDeg * D2R;
  const roll = (p.rollDeg || 0) * D2R;
  const f = [Math.sin(yaw) * Math.cos(pit), -Math.sin(pit), Math.cos(yaw) * Math.cos(pit)];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const n = Math.hypot(...a); return a.map((v) => v / n); };
  let xc = norm(cross([0, 1, 0], f));
  let yc = cross(f, xc);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const xr = xc.map((v, i) => v * cr + yc[i] * sr);
  const yr = yc.map((v, i) => -xc[i] * sr + yc[i] * cr);
  xc = xr; yc = yr;
  const C = [p.aimX - p.distanceIn * f[0], p.aimY - p.distanceIn * f[1], -p.distanceIn * f[2]];
  const fx = (width / 2) / Math.tan((hfovDeg * D2R) / 2);
  return { R: [xc, yc, f], C, fx, fy: fx, u0: width / 2, v0: height / 2, width, height };
}

export function projectPoint(cam, X, Y, Z = 0) {
  const d = [X - cam.C[0], Y - cam.C[1], Z - cam.C[2]];
  const xc = cam.R[0][0] * d[0] + cam.R[0][1] * d[1] + cam.R[0][2] * d[2];
  const yc = cam.R[1][0] * d[0] + cam.R[1][1] * d[1] + cam.R[1][2] * d[2];
  const zc = cam.R[2][0] * d[0] + cam.R[2][1] * d[1] + cam.R[2][2] * d[2];
  return { u: (cam.fx * xc) / zc + cam.u0, v: (cam.fy * yc) / zc + cam.v0, depth: zc };
}

/** Wall (x, y) inches -> image px homography (3x3 row-major) for the camera. */
export function homographyOf(cam) {
  const { R, C, fx, fy, u0, v0 } = cam;
  // Xc = R (Xw - C); for Z=0 plane: Xc = R[:,0] X + R[:,1] Y - R C
  const t = [-(R[0][0] * C[0] + R[0][1] * C[1] + R[0][2] * C[2]), -(R[1][0] * C[0] + R[1][1] * C[1] + R[1][2] * C[2]), -(R[2][0] * C[0] + R[2][1] * C[1] + R[2][2] * C[2])];
  const col = (k) => [R[0][k], R[1][k], R[2][k]];
  const c0 = col(0);
  const c1 = col(1);
  const K = (v) => [fx * v[0] + u0 * v[2], fy * v[1] + v0 * v[2], v[2]];
  const a = K(c0);
  const b = K(c1);
  const c = K(t);
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

function blurSeparable(src, w, h, kx, ky) {
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  const rx = (kx.length - 1) >> 1;
  const ry = (ky.length - 1) >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rx; i <= rx; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); s += src[y * w + xx] * kx[i + rx]; }
      tmp[y * w + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -ry; i <= ry; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); s += tmp[yy * w + x] * ky[i + ry]; }
      out[y * w + x] = s;
    }
  }
  return out;
}

/**
 * @param {{ layout: object, width: number, height: number, hfovDeg?: number,
 *   pose: {aimX:number,aimY:number,distanceIn:number,yawDeg:number,pitchDeg:number,rollDeg?:number},
 *   paper?: number, ink?: number, psfSigmaPx?: number, motion?: {lenPx:number, angleDeg:number}|null,
 *   noiseSigma?: number, shading?: {gx:number, gy:number}|null, seed?: number,
 *   skipIds?: Set<string>, extraBlobs?: Array<{u:number,v:number,r:number}> }} o
 */
export function renderDotWall(o) {
  const { layout, width, height } = o;
  const hfov = o.hfovDeg ?? 70;
  const cam = cameraFromPose(o.pose, width, height, hfov);
  const paper = o.paper ?? 200;
  const ink = o.ink ?? 30;
  const img = new Float64Array(width * height).fill(paper);
  const truth = [];
  const ss = 3;
  const poly = [];
  for (const d of layout.dots) {
    if (o.skipIds && o.skipIds.has(d.id)) continue;
    const c = projectPoint(cam, d.x, d.y);
    if (c.depth <= 1) continue;
    const rIn = d.diameterIn / 2;
    poly.length = 0;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const p = projectPoint(cam, d.x + rIn * Math.cos(a), d.y + rIn * Math.sin(a));
      poly.push(p.u, p.v);
      minX = Math.min(minX, p.u); maxX = Math.max(maxX, p.u); minY = Math.min(minY, p.v); maxY = Math.max(maxY, p.v);
    }
    const area = polyArea(poly);
    const cen = polyCentroid(poly, area);
    truth.push({ id: d.id, u: cen.u, v: cen.v, uc: c.u, vc: c.v, inside: minX >= 6 && maxX <= width - 6 && minY >= 6 && maxY <= height - 6,  diameterPx: 2 * Math.sqrt(Math.abs(area) / Math.PI), sizeClass: d.sizeClass, x: d.x, y: d.y, visible: c.u >= 0 && c.u < width && c.v >= 0 && c.v < height });
    const x0 = Math.max(0, Math.floor(minX)); const x1 = Math.min(width - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)); const y1 = Math.min(height - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let cov = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (inConvex(poly, x + (sx + 0.5) / ss, y + (sy + 0.5) / ss)) cov++;
        if (cov) img[y * width + x] = paper + (ink - paper) * (cov / (ss * ss)) * (1 - (img[y * width + x] === paper ? 0 : 0));
      }
    }
  }
  if (o.extraBlobs) {
    for (const b of o.extraBlobs) {
      for (let y = Math.max(0, Math.floor(b.v - b.r - 1)); y <= Math.min(height - 1, Math.ceil(b.v + b.r + 1)); y++) {
        for (let x = Math.max(0, Math.floor(b.u - b.r - 1)); x <= Math.min(width - 1, Math.ceil(b.u + b.r + 1)); x++) {
          if (Math.hypot(x + 0.5 - b.u, y + 0.5 - b.v) <= b.r) img[y * width + x] = ink;
        }
      }
    }
  }
  let out = img;
  if (o.psfSigmaPx && o.psfSigmaPx > 0) out = blurSeparable(out, width, height, gaussianKernel(o.psfSigmaPx), gaussianKernel(o.psfSigmaPx));
  if (o.motion && o.motion.lenPx > 0) {
    const n = Math.max(2, Math.ceil(o.motion.lenPx * 2));
    const dx = Math.cos(o.motion.angleDeg * D2R) * o.motion.lenPx;
    const dy = Math.sin(o.motion.angleDeg * D2R) * o.motion.lenPx;
    const m = new Float64Array(width * height);
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1) - 0.5;
      const ox = Math.round(dx * t);
      const oy = Math.round(dy * t);
      for (let y = 0; y < height; y++) {
        const yy = Math.min(height - 1, Math.max(0, y + oy));
        for (let x = 0; x < width; x++) m[y * width + x] += out[yy * width + Math.min(width - 1, Math.max(0, x + ox))] / n;
      }
    }
    out = m;
  }
  if (o.shading) {
    const g = o.shading;
    out = Float64Array.from(out, (v, i) => { const x = (i % width) / width - 0.5; const y = Math.floor(i / width) / height - 0.5; return v * (1 + g.gx * x + g.gy * y); });
  }
  const luma = new Uint8Array(width * height);
  const rng = mulberry32(((o.seed ?? 1) * 2654435761) >>> 0);
  const sigma = o.noiseSigma || 0;
  for (let i = 0; i < luma.length; i++) {
    let v = out[i];
    if (sigma > 0) {
      const u1 = Math.max(1e-12, rng());
      v += sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
    }
    luma[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return { luma, truth, cam, H: homographyOf(cam) };
}

function polyCentroid(p, area) {
  const n = p.length / 2;
  let cx = 0; let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const f = p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
    cx += (p[2 * i] + p[2 * j]) * f;
    cy += (p[2 * i + 1] + p[2 * j + 1]) * f;
  }
  return { u: cx / (6 * area), v: cy / (6 * area) };
}

function polyArea(p) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
  return a / 2;
}

function inConvex(p, x, y) {
  const n = p.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const c = (p[2 * j] - p[2 * i]) * (y - p[2 * i + 1]) - (p[2 * j + 1] - p[2 * i + 1]) * (x - p[2 * i]);
    if (c !== 0) { const s = c > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) return false; }
  }
  return true;
}
