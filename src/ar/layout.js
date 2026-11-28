/**
 * M0 — AR Wall Marker Layout Model & Measured-Spacing Overrides (`src/ar/layout.js`).
 *
 * Wall frame:
 *  - Origin `(0, 0)` at the top-left outer corner of the tote wall.
 *  - `+x` right, `+y` down, units in inches.
 *  - Parameters `cols`, `rows`, `pitchX`, `pitchY` are strictly configurable
 *    (tote orientation 16x14 vs 14x16 is UNCONFIRMED per OQ1).
 *
 * Tiers:
 *  - Tier A (hand-drawn): `(cols + 1) * (rows + 1)` tote-corner dots plus
 *    `cols * rows` label-offset dots placed `2.5 in` left of each label centre.
 *  - Tier B (printed lattice): dots every `s` inches (default `pitch / 4`) along
 *    every horizontal and vertical tote grid line (deduplicated at tote corners).
 *
 * Landmarks:
 *  - Origin dot `(0, 0)`: diameter x2.0
 *  - Axis dot `(cols * pitchX, 0)` (end of top row): diameter x1.5
 *  - Tier-B tote-corner dots (non-origin/non-axis): diameter x1.25
 *
 * Zero external dependencies; pure vanilla ES module.
 */

export const AR_LAYOUT_VERSION = 1;
export const AR_LAYOUT_STORAGE_KEY = 'dbc.ar.layout';

export const DOT_DIAMETER_MIN_IN = 0.75;
export const DOT_DIAMETER_MAX_IN = 1.5;
export const DEFAULT_WARNING_TOLERANCE_IN = 0.5;

export const LANDMARK_SCALES = Object.freeze({
  origin: 2.0,
  axis: 1.5,
  cornerTierB: 1.25,
  standard: 1.0,
});

export const DEFAULT_LAYOUT_CONFIG = Object.freeze({
  cols: 4,
  rows: 4,
  pitchX: 16, // UNCONFIRMED (OQ1: 16x14 vs 14x16 kept configurable)
  pitchY: 14,
  tier: 'A',
  dotDiameterIn: 1.0,
  polarity: 'dark-on-light',
  labelOffsetXIn: -2.5, // 2.5 in left of label centre
  labelOffsetYIn: 0.0,
  spacingIn: null, // Tier B scalar override `s` (inches); null => pitch / 4
  spacingXIn: null,
  spacingYIn: null,
  warningToleranceIn: DEFAULT_WARNING_TOLERANCE_IN,
  provenance: 'unconfirmed',
});

const EPS = 1e-6;

function roundIn(v) {
  return Math.round(v * 1e6) / 1e6;
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Generates sorted unique grid coordinates along `[0, count * pitch]` with spacing `step`,
 * guaranteeing every tote grid line `i * pitch` (`i = 0..count`) is included.
 */
function buildAxisCoordinates(count, pitch, step) {
  const total = count * pitch;
  const coords = [];

  for (let i = 0; i <= count; i++) {
    coords.push(roundIn(i * pitch));
  }

  if (step > 0 && step < total) {
    const nSteps = Math.floor(total / step + EPS);
    for (let k = 1; k <= nSteps; k++) {
      const v = roundIn(k * step);
      if (v > EPS && v < total - EPS) {
        coords.push(v);
      }
    }
  }

  coords.sort((a, b) => a - b);
  const unique = [];
  for (let i = 0; i < coords.length; i++) {
    if (unique.length === 0 || Math.abs(coords[i] - unique[unique.length - 1]) > EPS) {
      unique.push(coords[i]);
    }
  }
  return unique;
}

/**
 * Maps a nominal axis coordinate `v` through measured axis positions.
 * Supports either:
 *  - full lattice-axis measured array (`measuredArr.length === fullNominal.length`), or
 *  - tote-line measured array (`measuredArr.length === toteNominal.length`), with
 *    piecewise-linear interpolation for intermediate Tier-B lattice coordinates.
 */
function resolveAxisValue(v, fullNominal, toteNominal, measuredArr) {
  if (!Array.isArray(measuredArr) || measuredArr.length === 0) return v;

  // Exact match to full lattice array
  if (measuredArr.length === fullNominal.length) {
    for (let i = 0; i < fullNominal.length; i++) {
      if (Math.abs(fullNominal[i] - v) <= EPS) {
        return isFiniteNum(measuredArr[i]) ? measuredArr[i] : v;
      }
    }
  }

  // Exact match or piecewise-linear interpolation on tote grid lines
  if (measuredArr.length === toteNominal.length && toteNominal.length >= 2) {
    for (let i = 0; i < toteNominal.length; i++) {
      if (Math.abs(toteNominal[i] - v) <= EPS) {
        return isFiniteNum(measuredArr[i]) ? measuredArr[i] : v;
      }
    }
    for (let i = 0; i < toteNominal.length - 1; i++) {
      const aNom = toteNominal[i];
      const bNom = toteNominal[i + 1];
      if (v > aNom - EPS && v < bNom + EPS && bNom > aNom) {
        const aMeas = isFiniteNum(measuredArr[i]) ? measuredArr[i] : aNom;
        const bMeas = isFiniteNum(measuredArr[i + 1]) ? measuredArr[i + 1] : bNom;
        const t = (v - aNom) / (bNom - aNom);
        return aMeas + t * (bMeas - aMeas);
      }
    }
  }

  // Fallback: index-matched prefix when user supplied a partial list
  for (let i = 0; i < Math.min(measuredArr.length, fullNominal.length); i++) {
    if (Math.abs(fullNominal[i] - v) <= EPS && isFiniteNum(measuredArr[i])) {
      return measuredArr[i];
    }
  }
  return v;
}

/**
 * Normalizes and validates raw config input into a canonical config object.
 */
export function normalizeLayoutConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const cols = Number.isInteger(src.cols) && src.cols >= 1 ? src.cols : DEFAULT_LAYOUT_CONFIG.cols;
  const rows = Number.isInteger(src.rows) && src.rows >= 1 ? src.rows : DEFAULT_LAYOUT_CONFIG.rows;
  const pitchX = isFiniteNum(src.pitchX) && src.pitchX > 0 ? src.pitchX : DEFAULT_LAYOUT_CONFIG.pitchX;
  const pitchY = isFiniteNum(src.pitchY) && src.pitchY > 0 ? src.pitchY : DEFAULT_LAYOUT_CONFIG.pitchY;

  const rawTier = typeof src.tier === 'string' ? src.tier.trim().toUpperCase() : DEFAULT_LAYOUT_CONFIG.tier;
  const tier = rawTier === 'B' ? 'B' : 'A';

  const dotDiameterIn = isFiniteNum(src.dotDiameterIn) && src.dotDiameterIn > 0
    ? src.dotDiameterIn
    : DEFAULT_LAYOUT_CONFIG.dotDiameterIn;

  const rawPol = typeof src.polarity === 'string' ? src.polarity.trim().toLowerCase() : DEFAULT_LAYOUT_CONFIG.polarity;
  const polarity = rawPol === 'light-on-dark' ? 'light-on-dark' : 'dark-on-light';

  const labelOffsetXIn = isFiniteNum(src.labelOffsetXIn)
    ? src.labelOffsetXIn
    : DEFAULT_LAYOUT_CONFIG.labelOffsetXIn;
  const labelOffsetYIn = isFiniteNum(src.labelOffsetYIn)
    ? src.labelOffsetYIn
    : DEFAULT_LAYOUT_CONFIG.labelOffsetYIn;

  const spacingRaw = isFiniteNum(src.spacingIn) && src.spacingIn > 0
    ? src.spacingIn
    : (isFiniteNum(src.s) && src.s > 0 ? src.s : null);
  const spacingXIn = isFiniteNum(src.spacingXIn) && src.spacingXIn > 0
    ? src.spacingXIn
    : (spacingRaw !== null ? spacingRaw : roundIn(pitchX / 4));
  const spacingYIn = isFiniteNum(src.spacingYIn) && src.spacingYIn > 0
    ? src.spacingYIn
    : (spacingRaw !== null ? spacingRaw : roundIn(pitchY / 4));

  const warningToleranceIn = isFiniteNum(src.warningToleranceIn) && src.warningToleranceIn >= 0
    ? src.warningToleranceIn
    : DEFAULT_WARNING_TOLERANCE_IN;

  return {
    cols,
    rows,
    pitchX,
    pitchY,
    tier,
    dotDiameterIn,
    polarity,
    labelOffsetXIn,
    labelOffsetYIn,
    spacingIn: spacingRaw,
    spacingXIn,
    spacingYIn,
    warningToleranceIn,
    provenance: typeof src.provenance === 'string' ? src.provenance : DEFAULT_LAYOUT_CONFIG.provenance,
  };
}

/**
 * Generates a deterministic layout identifier from config and measured overrides.
 */
export function computeLayoutId(cfg, measured = null) {
  const base = `ar-tier${cfg.tier}-${cfg.cols}x${cfg.rows}-${cfg.pitchX}x${cfg.pitchY}`;
  const hasMeasured = Boolean(
    measured && (
      (Array.isArray(measured.xs) && measured.xs.length > 0) ||
      (Array.isArray(measured.ys) && measured.ys.length > 0) ||
      (Array.isArray(measured.dots) && measured.dots.length > 0)
    )
  );
  if (!hasMeasured) return base;
  // Deterministic 32-bit FNV-1a short suffix for measured layouts
  const str = JSON.stringify(measured);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${base}-m${h.toString(16).padStart(8, '0')}`;
}

/**
 * Builds the complete AR dotted-wall layout from nominal parameters and optional
 * measured overrides (`measured: { xs, ys, dots }`).
 *
 * @param {object} [opts]
 * @returns {object}
 */
export function createArLayout(opts = {}) {
  const cfg = normalizeLayoutConfig(opts);
  const warnings = [];

  if (cfg.dotDiameterIn < DOT_DIAMETER_MIN_IN || cfg.dotDiameterIn > DOT_DIAMETER_MAX_IN) {
    warnings.push({
      kind: 'dot-diameter',
      nominal: DEFAULT_LAYOUT_CONFIG.dotDiameterIn,
      measured: cfg.dotDiameterIn,
      delta: roundIn(cfg.dotDiameterIn - DEFAULT_LAYOUT_CONFIG.dotDiameterIn),
      message: `dotDiameterIn (${cfg.dotDiameterIn} in) is outside recommended range [${DOT_DIAMETER_MIN_IN}, ${DOT_DIAMETER_MAX_IN}] in`,
    });
  }

  // Normalize measured overrides
  const rawMeasured = (opts && opts.measured && typeof opts.measured === 'object') ? opts.measured : {};
  const measuredXs = Array.isArray(rawMeasured.xs) ? rawMeasured.xs.slice() : null;
  const measuredYs = Array.isArray(rawMeasured.ys) ? rawMeasured.ys.slice() : null;
  const rawDotOverrides = Array.isArray(rawMeasured.dots)
    ? rawMeasured.dots
    : (Array.isArray(opts.dotOverrides) ? opts.dotOverrides : []);

  const toteNominalXs = [];
  for (let c = 0; c <= cfg.cols; c++) toteNominalXs.push(roundIn(c * cfg.pitchX));
  const toteNominalYs = [];
  for (let r = 0; r <= cfg.rows; r++) toteNominalYs.push(roundIn(r * cfg.pitchY));

  const nominalXs = cfg.tier === 'B'
    ? buildAxisCoordinates(cfg.cols, cfg.pitchX, cfg.spacingXIn)
    : toteNominalXs.slice();
  const nominalYs = cfg.tier === 'B'
    ? buildAxisCoordinates(cfg.rows, cfg.pitchY, cfg.spacingYIn)
    : toteNominalYs.slice();

  // Validate measured axis arrays & check tolerance warnings
  function checkAxisMeasured(axis, arr, fullNom, toteNom) {
    if (!arr || arr.length === 0) return;
    const compareNom = arr.length === fullNom.length
      ? fullNom
      : (arr.length === toteNom.length ? toteNom : fullNom);

    if (arr.length !== fullNom.length && arr.length !== toteNom.length) {
      warnings.push({
        kind: `measured-${axis}-length`,
        axis,
        nominal: fullNom.length,
        measured: arr.length,
        delta: arr.length - fullNom.length,
        message: `measured.${axis}s has ${arr.length} entries; expected ${fullNom.length}${toteNom.length !== fullNom.length ? ` (or ${toteNom.length} tote lines)` : ''}`,
      });
    }

    for (let i = 0; i < arr.length; i++) {
      const val = arr[i];
      if (!isFiniteNum(val)) {
        warnings.push({
          kind: `measured-${axis}-invalid`,
          axis,
          index: i,
          nominal: i < compareNom.length ? compareNom[i] : null,
          measured: val,
          delta: null,
          message: `measured.${axis}s[${i}] is not a finite number`,
        });
        continue;
      }
      if (i > 0 && isFiniteNum(arr[i - 1]) && val <= arr[i - 1]) {
        warnings.push({
          kind: `measured-${axis}-order`,
          axis,
          index: i,
          nominal: i < compareNom.length ? compareNom[i] : null,
          measured: val,
          delta: roundIn(val - arr[i - 1]),
          message: `measured.${axis}s[${i}] (${val} in) is not strictly greater than previous entry (${arr[i - 1]} in)`,
        });
      }
      if (i < compareNom.length) {
        const nom = compareNom[i];
        const delta = roundIn(val - nom);
        if (Math.abs(delta) > cfg.warningToleranceIn + EPS) {
          warnings.push({
            kind: `measured-${axis}`,
            axis,
            index: i,
            nominal: nom,
            measured: val,
            delta,
            message: `measured.${axis}s[${i}] = ${val} in differs from nominal ${nom} in by ${delta > 0 ? '+' : ''}${delta} in (tolerance ${cfg.warningToleranceIn} in)`,
          });
        }
      }
    }
  }

  checkAxisMeasured('x', measuredXs, nominalXs, toteNominalXs);
  checkAxisMeasured('y', measuredYs, nominalYs, toteNominalYs);

  const dots = [];
  const dotById = new Map();

  function addDot(dot) {
    dots.push(dot);
    dotById.set(dot.id, dot);
  }

  // 1. Tote-corner dots (present in both Tier A and Tier B)
  for (let r = 0; r <= cfg.rows; r++) {
    for (let c = 0; c <= cfg.cols; c++) {
      const nomX = toteNominalXs[c];
      const nomY = toteNominalYs[r];
      const x = roundIn(resolveAxisValue(nomX, nominalXs, toteNominalXs, measuredXs));
      const y = roundIn(resolveAxisValue(nomY, nominalYs, toteNominalYs, measuredYs));

      let landmark = null;
      let sizeClass = 'x1';
      let diameterScale = LANDMARK_SCALES.standard;

      if (r === 0 && c === 0) {
        landmark = 'origin';
        sizeClass = 'x2';
        diameterScale = LANDMARK_SCALES.origin;
      } else if (r === 0 && c === cfg.cols) {
        landmark = 'axis';
        sizeClass = 'x1.5';
        diameterScale = LANDMARK_SCALES.axis;
      } else if (cfg.tier === 'B') {
        landmark = 'corner';
        sizeClass = 'x1.25';
        diameterScale = LANDMARK_SCALES.cornerTierB;
      }

      addDot({
        id: `corner-r${r}-c${c}`,
        role: 'corner',
        landmark,
        sizeClass,
        diameterScale,
        diameterIn: roundIn(cfg.dotDiameterIn * diameterScale),
        x,
        y,
        nominalX: nomX,
        nominalY: nomY,
        toteRow: r,
        toteCol: c,
        overridden: Math.abs(x - nomX) > EPS || Math.abs(y - nomY) > EPS,
      });
    }
  }

  // 2. Label centres (computed for both tiers; Tier A places label-offset dots relative to them)
  const labels = [];
  for (let r = 0; r < cfg.rows; r++) {
    for (let c = 0; c < cfg.cols; c++) {
      const nomLeft = toteNominalXs[c];
      const nomRight = toteNominalXs[c + 1];
      const nomTop = toteNominalYs[r];
      const nomBottom = toteNominalYs[r + 1];
      const nomCx = roundIn((nomLeft + nomRight) * 0.5);
      const nomCy = roundIn((nomTop + nomBottom) * 0.5);

      const measLeft = resolveAxisValue(nomLeft, nominalXs, toteNominalXs, measuredXs);
      const measRight = resolveAxisValue(nomRight, nominalXs, toteNominalXs, measuredXs);
      const measTop = resolveAxisValue(nomTop, nominalYs, toteNominalYs, measuredYs);
      const measBottom = resolveAxisValue(nomBottom, nominalYs, toteNominalYs, measuredYs);
      const cx = roundIn((measLeft + measRight) * 0.5);
      const cy = roundIn((measTop + measBottom) * 0.5);

      labels.push({
        id: `cell-r${r}-c${c}`,
        row: r,
        col: c,
        x: cx,
        y: cy,
        nominalX: nomCx,
        nominalY: nomCy,
      });

      if (cfg.tier === 'A') {
        const nomDotX = roundIn(nomCx + cfg.labelOffsetXIn);
        const nomDotY = roundIn(nomCy + cfg.labelOffsetYIn);
        const dotX = roundIn(cx + cfg.labelOffsetXIn);
        const dotY = roundIn(cy + cfg.labelOffsetYIn);

        addDot({
          id: `label-r${r}-c${c}`,
          role: 'label-offset',
          landmark: null,
          sizeClass: 'x1',
          diameterScale: LANDMARK_SCALES.standard,
          diameterIn: roundIn(cfg.dotDiameterIn),
          x: dotX,
          y: dotY,
          nominalX: nomDotX,
          nominalY: nomDotY,
          toteRow: r,
          toteCol: c,
          overridden: Math.abs(dotX - nomDotX) > EPS || Math.abs(dotY - nomDotY) > EPS,
        });
      }
    }
  }

  // 3. Tier B fine lattice dots along horizontal and vertical tote grid lines
  if (cfg.tier === 'B') {
    const isToteX = (xVal) => toteNominalXs.some((tx) => Math.abs(tx - xVal) <= EPS);
    const isToteY = (yVal) => toteNominalYs.some((ty) => Math.abs(ty - yVal) <= EPS);

    // Along horizontal tote grid lines (y = r * pitchY)
    for (let r = 0; r <= cfg.rows; r++) {
      const nomY = toteNominalYs[r];
      const y = roundIn(resolveAxisValue(nomY, nominalYs, toteNominalYs, measuredYs));
      for (let gx = 0; gx < nominalXs.length; gx++) {
        const nomX = nominalXs[gx];
        if (isToteX(nomX)) continue; // already placed as tote corner
        const x = roundIn(resolveAxisValue(nomX, nominalXs, toteNominalXs, measuredXs));
        addDot({
          id: `gridh-r${r}-x${gx}`,
          role: 'grid-h',
          landmark: null,
          sizeClass: 'x1',
          diameterScale: LANDMARK_SCALES.standard,
          diameterIn: roundIn(cfg.dotDiameterIn),
          x,
          y,
          nominalX: nomX,
          nominalY: nomY,
          toteRow: r,
          toteCol: null,
          gridXIndex: gx,
          overridden: Math.abs(x - nomX) > EPS || Math.abs(y - nomY) > EPS,
        });
      }
    }

    // Along vertical tote grid lines (x = c * pitchX)
    for (let c = 0; c <= cfg.cols; c++) {
      const nomX = toteNominalXs[c];
      const x = roundIn(resolveAxisValue(nomX, nominalXs, toteNominalXs, measuredXs));
      for (let gy = 0; gy < nominalYs.length; gy++) {
        const nomY = nominalYs[gy];
        if (isToteY(nomY)) continue; // already placed as tote corner
        const y = roundIn(resolveAxisValue(nomY, nominalYs, toteNominalYs, measuredYs));
        addDot({
          id: `gridv-c${c}-y${gy}`,
          role: 'grid-v',
          landmark: null,
          sizeClass: 'x1',
          diameterScale: LANDMARK_SCALES.standard,
          diameterIn: roundIn(cfg.dotDiameterIn),
          x,
          y,
          nominalX: nomX,
          nominalY: nomY,
          toteRow: null,
          toteCol: c,
          gridYIndex: gy,
          overridden: Math.abs(x - nomX) > EPS || Math.abs(y - nomY) > EPS,
        });
      }
    }
  }

  // 4. Per-dot overrides `{ id, x, y }`
  const cleanDotOverrides = [];
  for (let i = 0; i < rawDotOverrides.length; i++) {
    const ov = rawDotOverrides[i];
    if (!ov || typeof ov.id !== 'string') continue;
    const dot = dotById.get(ov.id);
    if (!dot) {
      warnings.push({
        kind: 'measured-dot-unknown',
        id: ov.id,
        nominal: null,
        measured: null,
        delta: null,
        message: `Per-dot override references unknown dot id "${ov.id}"`,
      });
      continue;
    }

    const cleanEntry = { id: ov.id };
    if (isFiniteNum(ov.x)) {
      dot.x = roundIn(ov.x);
      dot.overridden = true;
      cleanEntry.x = dot.x;
      const dx = roundIn(dot.x - dot.nominalX);
      if (Math.abs(dx) > cfg.warningToleranceIn + EPS) {
        warnings.push({
          kind: 'measured-dot',
          id: dot.id,
          axis: 'x',
          nominal: dot.nominalX,
          measured: dot.x,
          delta: dx,
          message: `Dot "${dot.id}" measured x = ${dot.x} in differs from nominal ${dot.nominalX} in by ${dx > 0 ? '+' : ''}${dx} in (tolerance ${cfg.warningToleranceIn} in)`,
        });
      }
    }
    if (isFiniteNum(ov.y)) {
      dot.y = roundIn(ov.y);
      dot.overridden = true;
      cleanEntry.y = dot.y;
      const dy = roundIn(dot.y - dot.nominalY);
      if (Math.abs(dy) > cfg.warningToleranceIn + EPS) {
        warnings.push({
          kind: 'measured-dot',
          id: dot.id,
          axis: 'y',
          nominal: dot.nominalY,
          measured: dot.y,
          delta: dy,
          message: `Dot "${dot.id}" measured y = ${dot.y} in differs from nominal ${dot.nominalY} in by ${dy > 0 ? '+' : ''}${dy} in (tolerance ${cfg.warningToleranceIn} in)`,
        });
      }
    }
    cleanDotOverrides.push(cleanEntry);
  }

  const normalizedMeasured = {
    xs: measuredXs ? measuredXs.slice() : null,
    ys: measuredYs ? measuredYs.slice() : null,
    dots: cleanDotOverrides,
  };

  let cornerCount = 0;
  let labelOffsetCount = 0;
  let gridDotCount = 0;
  let originCount = 0;
  let axisCount = 0;
  let cornerLandmarkCount = 0;

  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    if (d.role === 'corner') cornerCount++;
    else if (d.role === 'label-offset') labelOffsetCount++;
    else gridDotCount++;

    if (d.landmark === 'origin') originCount++;
    else if (d.landmark === 'axis') axisCount++;
    else if (d.landmark === 'corner') cornerLandmarkCount++;
  }

  const wallWidthIn = roundIn(cfg.cols * cfg.pitchX);
  const wallHeightIn = roundIn(cfg.rows * cfg.pitchY);
  const layoutId = computeLayoutId(cfg, normalizedMeasured);

  return {
    version: AR_LAYOUT_VERSION,
    layoutId,
    config: cfg,
    measured: normalizedMeasured,
    wallWidthIn,
    wallHeightIn,
    toteNominalXs,
    toteNominalYs,
    nominalXs,
    nominalYs,
    dots,
    labels,
    counts: {
      total: dots.length,
      corners: cornerCount,
      labelOffsets: labelOffsetCount,
      gridDots: gridDotCount,
      origins: originCount,
      axes: axisCount,
      cornerLandmarks: cornerLandmarkCount,
    },
    warnings,
  };
}

/**
 * Produces a plain JSON-serialisable layout object suitable for `localStorage` and
 * `.dbct` tape sidecars.
 */
export function serializeArLayout(layout) {
  return {
    version: layout.version ?? AR_LAYOUT_VERSION,
    layoutId: layout.layoutId,
    config: { ...layout.config },
    measured: {
      xs: Array.isArray(layout.measured?.xs) ? layout.measured.xs.slice() : null,
      ys: Array.isArray(layout.measured?.ys) ? layout.measured.ys.slice() : null,
      dots: Array.isArray(layout.measured?.dots)
        ? layout.measured.dots.map((d) => ({ ...d }))
        : [],
    },
    wallWidthIn: layout.wallWidthIn,
    wallHeightIn: layout.wallHeightIn,
    counts: { ...layout.counts },
    warnings: layout.warnings.map((w) => ({ ...w })),
    dots: layout.dots.map((d) => ({ ...d })),
    labels: layout.labels.map((l) => ({ ...l })),
  };
}

/**
 * Restores a full validated AR layout from a JSON string or plain serialized object.
 */
export function deserializeArLayout(jsonOrObj) {
  const parsed = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid AR layout payload');
  }
  const cfg = parsed.config && typeof parsed.config === 'object' ? parsed.config : parsed;
  const measured = parsed.measured && typeof parsed.measured === 'object' ? parsed.measured : {};
  return createArLayout({ ...cfg, measured });
}

/**
 * Saves an AR layout to `localStorage` (or an injected Storage-compatible object).
 */
export function saveArLayoutToStorage(layout, storage = null) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store || typeof store.setItem !== 'function') return false;
  try {
    store.setItem(AR_LAYOUT_STORAGE_KEY, JSON.stringify(serializeArLayout(layout)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads an AR layout from `localStorage` (or an injected Storage-compatible object).
 * Returns `null` if absent or malformed.
 */
export function loadArLayoutFromStorage(storage = null) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store || typeof store.getItem !== 'function') return null;
  try {
    const raw = store.getItem(AR_LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    return deserializeArLayout(raw);
  } catch {
    return null;
  }
}
