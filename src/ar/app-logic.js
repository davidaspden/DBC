/**
 * M7a — Pure Logic Helpers for `ar.html` / `src/ar/app.js` (`src/ar/app-logic.js`).
 *
 * Factored out of browser DOM code so all flag gating, layout-editor parsing,
 * sliding-window FPS measurement, crop alignment, and tape-size estimation are
 * thoroughly unit-tested in Node.js with zero dependencies.
 */

import { resolveSimFlags } from '../sim/simflags.js';
import { createArLayout } from './layout.js';

export const AR_DISABLED_MESSAGE = 'AR wall mode is disabled';

/**
 * Evaluates whether `ar.html` is enabled via the `arWall` sim flag.
 *
 * @param {{ search?: string, stored?: Record<string, boolean> | null }} [opts]
 */
export function evaluateArPageAccess(opts = {}) {
  const flags = resolveSimFlags(opts);
  const enabled = Boolean(flags.arWall);
  return {
    enabled,
    flags,
    message: enabled ? 'AR wall mode active (Wave 1 raw capture)' : AR_DISABLED_MESSAGE,
  };
}

/**
 * Parses a comma- or whitespace-separated list of measured coordinates in inches.
 * Empty input yields `{ values: null, invalidTokens: [] }`.
 */
export function parseNumberList(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { values: null, invalidTokens: [] };
  }
  const tokens = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const values = [];
  const invalidTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const num = Number(tokens[i]);
    if (Number.isFinite(num)) {
      values.push(num);
    } else {
      invalidTokens.push(tokens[i]);
    }
  }
  return {
    values: values.length > 0 ? values : null,
    invalidTokens,
  };
}

/**
 * Parses optional per-dot overrides JSON text (`[{ "id": "...", "x": ..., "y": ... }]`).
 */
export function parseDotOverridesJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { dots: [], error: null };
  }
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return { dots: [], error: 'Per-dot overrides must be a JSON array of { id, x, y } objects.' };
    }
    const clean = [];
    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id.trim()) {
        return { dots: [], error: `Override at index ${i} must have a non-empty string "id".` };
      }
      const entry = { id: item.id.trim() };
      if (item.x !== undefined && item.x !== null && item.x !== '') {
        const x = Number(item.x);
        if (!Number.isFinite(x)) return { dots: [], error: `Override "${entry.id}" has invalid x.` };
        entry.x = x;
      }
      if (item.y !== undefined && item.y !== null && item.y !== '') {
        const y = Number(item.y);
        if (!Number.isFinite(y)) return { dots: [], error: `Override "${entry.id}" has invalid y.` };
        entry.y = y;
      }
      clean.push(entry);
    }
    return { dots: clean, error: null };
  } catch (err) {
    return { dots: [], error: `Invalid JSON: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Converts layout-editor form strings into a validated M0 layout plus any parse errors.
 */
export function buildLayoutFromEditorInput(fields = {}) {
  const parseErrors = [];

  const cols = Number.parseInt(String(fields.cols ?? 4), 10);
  const rows = Number.parseInt(String(fields.rows ?? 4), 10);
  const pitchX = Number(fields.pitchX ?? 16);
  const pitchY = Number(fields.pitchY ?? 14);
  const dotDiameterIn = Number(fields.dotDiameterIn ?? 1.0);
  const tier = String(fields.tier || 'A').trim().toUpperCase() === 'B' ? 'B' : 'A';
  const polarity = String(fields.polarity || 'dark-on-light').trim() === 'light-on-dark'
    ? 'light-on-dark'
    : 'dark-on-light';

  if (!Number.isInteger(cols) || cols < 1 || cols > 20) parseErrors.push('cols must be an integer between 1 and 20.');
  if (!Number.isInteger(rows) || rows < 1 || rows > 20) parseErrors.push('rows must be an integer between 1 and 20.');
  if (!Number.isFinite(pitchX) || pitchX <= 0) parseErrors.push('pitchX must be a positive number.');
  if (!Number.isFinite(pitchY) || pitchY <= 0) parseErrors.push('pitchY must be a positive number.');
  if (!Number.isFinite(dotDiameterIn) || dotDiameterIn <= 0) parseErrors.push('dotDiameterIn must be a positive number.');

  let spacingIn = null;
  if (fields.spacingIn !== undefined && fields.spacingIn !== null && String(fields.spacingIn).trim() !== '') {
    const s = Number(fields.spacingIn);
    if (!Number.isFinite(s) || s <= 0) {
      parseErrors.push('Tier B spacing (s) must be blank or a positive number.');
    } else {
      spacingIn = s;
    }
  }

  const parsedXs = parseNumberList(fields.measuredXsText || '');
  if (parsedXs.invalidTokens.length > 0) {
    parseErrors.push(`Invalid measured X values: ${parsedXs.invalidTokens.join(', ')}`);
  }
  const parsedYs = parseNumberList(fields.measuredYsText || '');
  if (parsedYs.invalidTokens.length > 0) {
    parseErrors.push(`Invalid measured Y values: ${parsedYs.invalidTokens.join(', ')}`);
  }

  const parsedDots = parseDotOverridesJson(fields.dotOverridesText || '');
  if (parsedDots.error) {
    parseErrors.push(parsedDots.error);
  }

  if (parseErrors.length > 0) {
    return { ok: false, layout: null, parseErrors };
  }

  const layout = createArLayout({
    cols,
    rows,
    pitchX,
    pitchY,
    tier,
    dotDiameterIn,
    polarity,
    spacingIn,
    measured: {
      xs: parsedXs.values,
      ys: parsedYs.values,
      dots: parsedDots.dots,
    },
  });

  return { ok: true, layout, parseErrors: [] };
}

/**
 * Sliding-window measured FPS estimator (pure, monotonic timestamp input in ms).
 */
export function createFpsMeter(windowMs = 1000) {
  const stamps = [];
  const win = Math.max(100, windowMs);

  function push(nowMs) {
    if (!Number.isFinite(nowMs)) return getFps();
    stamps.push(nowMs);
    const cutoff = nowMs - win;
    while (stamps.length > 1 && stamps[0] < cutoff) {
      stamps.shift();
    }
    return getFps();
  }

  function getFps() {
    if (stamps.length < 2) return 0;
    const spanMs = stamps[stamps.length - 1] - stamps[0];
    if (spanMs <= 0) return 0;
    return ((stamps.length - 1) * 1000) / spanMs;
  }

  function reset() {
    stamps.length = 0;
  }

  return { push, getFps, reset };
}

/**
 * Computes an even-aligned centre crop rectangle `{ x, y, width, height }`
 * compatible with WebCodecs YUV420 `VideoFrame.copyTo({ rect })`.
 */
export function computeCentreBandCrop(frameW, frameH, fraction = 0.6) {
  const fw = Math.max(2, (frameW | 0) & ~1);
  const fh = Math.max(2, (frameH | 0) & ~1);
  const f = Math.min(1, Math.max(0.25, Number(fraction) || 0.6));
  const w = Math.max(2, (Math.round(fw * f) & ~1));
  const h = Math.max(2, (Math.round(fh * f) & ~1));
  const x = ((fw - w) >> 1) & ~1;
  const y = ((fh - h) >> 1) & ~1;
  return { x, y, width: w, height: h };
}

/**
 * Estimates raw and gzipped `.dbct` tape size for user guidance on mobile browsers.
 */
export function estimateRecordingBudget({
  width = 1920,
  height = 1080,
  fps = 30,
  everyNth = 1,
  durationSec = 60,
}) {
  const effFps = Math.max(1, fps) / Math.max(1, everyNth | 0);
  const frames = Math.round(effFps * Math.max(1, durationSec));
  const rawFrameBytes = (width | 0) * (height | 0);
  const rawTotalMb = (frames * rawFrameBytes) / (1024 * 1024);
  // Matte blank walls compress heavily in low noise (~10-15%) and moderately at high ISO (~30-40%)
  const estLowMb = rawTotalMb * 0.12;
  const estHighMb = rawTotalMb * 0.35;
  const recommendDownscale = estHighMb > 350;
  return {
    frames,
    rawTotalMb: Math.round(rawTotalMb * 10) / 10,
    estLowMb: Math.round(estLowMb * 10) / 10,
    estHighMb: Math.round(estHighMb * 10) / 10,
    recommendDownscale,
  };
}

/**
 * Computes scale and offset to fit a wall `(wallW x wallH in)` inside a schematic preview canvas.
 */
export function computePreviewWallTransform(wallW, wallH, canvasW, canvasH, pad = 18) {
  const availW = Math.max(1, canvasW - 2 * pad);
  const availH = Math.max(1, canvasH - 2 * pad);
  const scale = Math.min(availW / Math.max(1e-3, wallW), availH / Math.max(1e-3, wallH));
  const drawW = wallW * scale;
  const drawH = wallH * scale;
  const offsetX = pad + (availW - drawW) * 0.5;
  const offsetY = pad + (availH - drawH) * 0.5;
  return { scale, offsetX, offsetY, drawW, drawH };
}
