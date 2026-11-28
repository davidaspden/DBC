/**
 * Unified Frame-to-Screen Overlay Coordinate Mapper (`overlayAlign` flag).
 *
 * Maps decoder frame coordinates `(frameW x frameH)` — whether portrait (`1080x1920`,
 * `1080x2400`), landscape (`1920x1080`), or an uploaded photo — into the exact CSS pixel
 * space `(cssW x cssH)` of the displayed `<video>` / `<img>` / `<canvas>`, matching
 * `object-fit: cover` or `object-fit: contain` with zero stretching or offset.
 */

/**
 * Reads the real active frame dimensions from the most authoritative live source available
 * (`VideoFrame` -> `videoEl.videoWidth/Height` -> `track.getSettings()`), never assuming
 * landscape `1920x1080` when a portrait stream reports `1080x1920` or `1080x2400`.
 */
export function readRealFrameSize(videoEl = null, track = null, videoFrame = null, fallbackW = 0, fallbackH = 0) {
  if (videoFrame) {
    const vis = videoFrame.visibleRect;
    const vw = vis && vis.width > 0 ? (vis.width | 0) : (videoFrame.codedWidth | 0);
    const vh = vis && vis.height > 0 ? (vis.height | 0) : (videoFrame.codedHeight | 0);
    if (vw > 0 && vh > 0) return { width: vw, height: vh };
  }
  if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
    return { width: videoEl.videoWidth | 0, height: videoEl.videoHeight | 0 };
  }
  if (track && typeof track.getSettings === 'function') {
    const st = track.getSettings();
    if (st && st.width > 0 && st.height > 0) {
      return { width: st.width | 0, height: st.height | 0 };
    }
  }
  return { width: fallbackW | 0, height: fallbackH | 0 };
}

/**
 * Computes exact `{ scale, offsetX, offsetY, drawW, drawH, frameW, frameH, cssW, cssH, fit }`
 * and returns a mapper with `mapFrameToScreen(x, y)`, `mapRectToScreen(x, y, w, h)`, and
 * `mapScreenToFrame(sx, sy)`.
 *
 * - `fit === 'cover'`:   `scale = Math.max(cssW / frameW, cssH / frameH)`
 * - `fit === 'contain'`: `scale = Math.min(cssW / frameW, cssH / frameH)`
 * - `offsetX = (cssW - frameW * scale) / 2`
 * - `offsetY = (cssH - frameH * scale) / 2`
 */
export function createFrameToScreenMapper({ frameW, frameH, cssW, cssH, fit = 'cover' }) {
  const valid = frameW > 0 && frameH > 0 && cssW > 0 && cssH > 0;
  const scale = valid
    ? (fit === 'cover'
        ? Math.max(cssW / frameW, cssH / frameH)
        : Math.min(cssW / frameW, cssH / frameH))
    : 1;
  const drawW = valid ? frameW * scale : cssW;
  const drawH = valid ? frameH * scale : cssH;
  const offsetX = valid ? (cssW - drawW) * 0.5 : 0;
  const offsetY = valid ? (cssH - drawH) * 0.5 : 0;

  function mapFrameToScreen(x, y, out = null) {
    const sx = offsetX + x * scale;
    const sy = offsetY + y * scale;
    if (out) {
      out.x = sx;
      out.y = sy;
      return out;
    }
    return { x: sx, y: sy };
  }

  function mapRectToScreen(x, y, w, h, out = null) {
    const sx = offsetX + x * scale;
    const sy = offsetY + y * scale;
    const sw = w * scale;
    const sh = h * scale;
    if (out) {
      out.x = sx;
      out.y = sy;
      out.w = sw;
      out.h = sh;
      return out;
    }
    return { x: sx, y: sy, w: sw, h: sh };
  }

  function mapScreenToFrame(sx, sy, out = null) {
    const inv = scale > 0 ? 1 / scale : 1;
    const fx = (sx - offsetX) * inv;
    const fy = (sy - offsetY) * inv;
    if (out) {
      out.x = fx;
      out.y = fy;
      return out;
    }
    return { x: fx, y: fy };
  }

  return {
    frameW,
    frameH,
    cssW,
    cssH,
    fit,
    scale,
    offsetX,
    offsetY,
    // Aliases matching viewmap.js (`offX`, `offY`)
    offX: offsetX,
    offY: offsetY,
    drawW,
    drawH,
    mapFrameToScreen,
    mapRectToScreen,
    mapScreenToFrame,
  };
}

/**
 * Direct single-call helper `mapFrameToScreen(x, y, frameW, frameH, cssW, cssH, fit)`.
 */
export function mapFrameToScreen(x, y, frameW, frameH, cssW, cssH, fit = 'cover') {
  if (!(frameW > 0 && frameH > 0 && cssW > 0 && cssH > 0)) {
    return { x, y };
  }
  const scale = fit === 'cover'
    ? Math.max(cssW / frameW, cssH / frameH)
    : Math.min(cssW / frameW, cssH / frameH);
  const offsetX = (cssW - frameW * scale) * 0.5;
  const offsetY = (cssH - frameH * scale) * 0.5;
  return {
    x: offsetX + x * scale,
    y: offsetY + y * scale,
  };
}

/**
 * Sizes an overlay `<canvas>` backing store to its display element's exact CSS dimensions
 * multiplied by `devicePixelRatio` so 1 canvas unit == 1 CSS pixel after `ctx.setTransform(dpr,0,0,dpr,0,0)`.
 */
export function syncOverlayCanvasSize(canvas, displayEl = canvas, dprOverride = null) {
  const dpr = (typeof dprOverride === 'number' && dprOverride > 0)
    ? dprOverride
    : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const target = displayEl || canvas;
  let cssW = 0;
  let cssH = 0;
  if (target && typeof target.getBoundingClientRect === 'function') {
    const rect = target.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
  }
  if (!(cssW > 0 && cssH > 0) && target) {
    cssW = target.clientWidth || 0;
    cssH = target.clientHeight || 0;
  }
  if (!(cssW > 0 && cssH > 0)) {
    return { ok: false, cssW: 0, cssH: 0, dpr };
  }
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  return { ok: true, cssW, cssH, dpr };
}
