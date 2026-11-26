/**
 * Stand-Back Tilt & Pan Ray-Plane Array Mapper (Part 3).
 *
 * Maps live Code 128 detections + fused orientation quaternions onto a configurable
 * `rows x cols` wall array (default 4x4 of 14 in wide x 16 in tall totes, centered
 * vertical 2x6 in Code 128 labels).
 *
 * Wall coordinate system (inches, centered on array):
 *  - +X = right across columns (col 0 -> cols-1)
 *  - +Y = up across rows (row 0 = top, row rows-1 = bottom)
 *  - Wall lies on Z = 0; camera stands at (Px, Py, D) looking along -Z when qRel = identity.
 */

import { quatRotateVec, quatFromPanTiltRollDeg } from './orient.js?v=2';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MIN_WZ_IN = 0.25; // Reject oblique rays > ~75 deg off wall normal

export function createPanArrayMapper(opts = {}) {
  const cfg = {
    cols: opts.cols || 4,
    rows: opts.rows || 4,
    pitchXIn: opts.pitchXIn || 14,       // Tote width (inches)
    pitchYIn: opts.pitchYIn || 16,       // Tote height (inches)
    labelLenIn: opts.labelLenIn || 6,    // Vertical barcode length (inches)
    labelModules: opts.labelModules || 231,
    hfovDeg: opts.hfovDeg || 70.7,       // 1x main lens horizontal FOV (long-axis)
    zoom: opts.zoom || 1,
    distanceIn: opts.distanceIn || 30,   // Stand-back distance D (inches)
    snapTolFracX: opts.snapTolFracX || 0.48,
    snapTolFracY: opts.snapTolFracY || 0.48,
    camSensorOffsetMs: opts.camSensorOffsetMs ?? 50,
    autoDistanceFromLabel: Boolean(opts.autoDistanceFromLabel),
    invertPan: Boolean(opts.invertPan),
    invertTilt: Boolean(opts.invertTilt),
  };

  // Camera stance offset relative to wall center (inches)
  const stance = {
    px: 0,
    py: 0,
    d: cfg.distanceIn,
    yawTrimRad: 0,
    pitchTrimRad: 0,
    scaleX: 1,
    scaleY: 1,
    lastResidualIn: 0,
    stanceWarning: false,
    calibratedTwoCorner: false,
  };

  // Scratch vectors (zero hot-loop allocations)
  const rayScratch = new Float64Array(3);
  const rotScratch = new Float64Array(3);

  let cells = [];
  const payloadToCellIdx = new Map();
  let unplaced = [];
  let twoCornerAnchorA = null;

  function rebuildGrid() {
    cells = [];
    payloadToCellIdx.clear();
    unplaced = [];
    twoCornerAnchorA = null;
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        const cx = (c - (cfg.cols - 1) * 0.5) * cfg.pitchXIn;
        const cy = ((cfg.rows - 1) * 0.5 - r) * cfg.pitchYIn;
        cells.push({
          index: r * cfg.cols + c,
          row: r,
          col: c,
          id: `R${r + 1}C${c + 1}`,
          cx,
          cy,
          state: 'EMPTY',     // EMPTY | READ | CONFLICT
          payload: '',
          readCount: 0,
          votes: new Map(),   // payload -> count
          firstSeenMs: 0,
          lastSeenMs: 0,
          lastErrIn: 0,
        });
      }
    }
  }

  rebuildGrid();

  /**
   * Computes effective focal length in pixels for `(frameW, frameH)`.
   * Note: `hfovDeg` is quoted along the camera's long axis (e.g. 70.7 deg on Galaxy A53 5G).
   */
  function getFocalLengthPx(frameW, frameH) {
    const longPx = Math.max(frameW, frameH);
    const halfRad = (cfg.hfovDeg * 0.5) * DEG_TO_RAD;
    return ((longPx * 0.5) / Math.tan(halfRad)) * Math.max(0.5, cfg.zoom);
  }

  /**
   * Projects an image pixel `(px, py)` through camera orientation `qRel` onto the wall plane Z = 0.
   * Returns `{ ok, wx, wy, wzIn, colFloat, rowFloat }` in wall inches.
   */
  function projectPixelToWall(qRel, px, py, frameW, frameH) {
    const fPx = getFocalLengthPx(frameW, frameH);
    const u = (px - frameW * 0.5) / fPx;
    const v = -(py - frameH * 0.5) / fPx; // +v is up
    const invLen = 1 / Math.hypot(u, v, 1);
    rayScratch[0] = u * invLen;
    rayScratch[1] = v * invLen;
    rayScratch[2] = -invLen;

    quatRotateVec(qRel, rayScratch[0], rayScratch[1], rayScratch[2], rotScratch);
    let rx = cfg.invertPan ? -rotScratch[0] : rotScratch[0];
    let ry = cfg.invertTilt ? -rotScratch[1] : rotScratch[1];
    const wzIn = -rotScratch[2]; // positive into wall

    if (wzIn < MIN_WZ_IN) {
      return { ok: false, wx: 0, wy: 0, wzIn, colFloat: -1, rowFloat: -1 };
    }

    // Apply small yaw/pitch trim + optional 2-corner empirical scale
    const tanX = (rx / wzIn) + Math.tan(stance.yawTrimRad);
    const tanY = (ry / wzIn) + Math.tan(stance.pitchTrimRad);
    const wx = stance.px + stance.d * tanX * stance.scaleX;
    const wy = stance.py + stance.d * tanY * stance.scaleY;

    const colFloat = wx / cfg.pitchXIn + (cfg.cols - 1) * 0.5;
    const rowFloat = (cfg.rows - 1) * 0.5 - wy / cfg.pitchYIn;

    return { ok: true, wx, wy, wzIn, colFloat, rowFloat };
  }

  /**
   * Projects the camera center ray + 4 frame corners onto the wall plane for live HUD rendering.
   */
  function getCameraFootprint(qRel, frameW, frameH) {
    const center = projectPixelToWall(qRel, frameW * 0.5, frameH * 0.5, frameW, frameH);
    const tl = projectPixelToWall(qRel, 0, 0, frameW, frameH);
    const tr = projectPixelToWall(qRel, frameW, 0, frameW, frameH);
    const br = projectPixelToWall(qRel, frameW, frameH, frameW, frameH);
    const bl = projectPixelToWall(qRel, 0, frameH, frameW, frameH);

    const col = Math.round(center.colFloat);
    const row = Math.round(center.rowFloat);
    const inGrid = center.ok && col >= 0 && col < cfg.cols && row >= 0 && row < cfg.rows;
    const targetCell = inGrid ? cells[row * cfg.cols + col] : null;

    return {
      ok: center.ok,
      center,
      corners: [tl, tr, br, bl],
      targetCell,
      inGrid,
    };
  }

  /**
   * Computes the exact wall-normal orientation quaternion aiming from centered stance
   * `(0, 0, stance.d)` directly at cell `(row, col)` (or wall center when `row === null`).
   * Respects `cfg.invertPan` / `cfg.invertTilt` so `projectPixelToWall(q, cx, cy)` lands
   * squarely on that cell with zero corner tangent distortion.
   */
  function getAimQuaternionForCell(row, col) {
    let targetX = 0;
    let targetY = 0;
    if (row !== null && col !== null && row >= 0 && row < cfg.rows && col >= 0 && col < cfg.cols) {
      const cell = cells[row * cfg.cols + col];
      targetX = cell.cx;
      targetY = cell.cy;
    }
    const d = Math.max(4, stance.d);
    const sx = targetX / (stance.scaleX || 1);
    const sy = targetY / (stance.scaleY || 1);
    const panDeg = Math.atan2(sx, d) * RAD_TO_DEG * (cfg.invertPan ? -1 : 1);
    const tiltDeg = Math.atan2(sy, Math.hypot(sx, d)) * RAD_TO_DEG * (cfg.invertTilt ? -1 : 1);
    return {
      quat: quatFromPanTiltRollDeg(panDeg, tiltDeg, 0),
      panDeg,
      tiltDeg,
    };
  }

  /**
   * Convenience helper returning the aim quaternion for `'top-left'`, `'top-right'`, or `'center'`.
   */
  function getStartCornerAim(corner = 'top-left') {
    if (corner === 'top-left') return { ...getAimQuaternionForCell(0, 0), cell: cells[0] };
    if (corner === 'top-right') return { ...getAimQuaternionForCell(0, cfg.cols - 1), cell: cells[cfg.cols - 1] };
    return { ...getAimQuaternionForCell(null, null), cell: null };
  }

  /**
   * Anchors the current aim ray (center of screen at orientation `qRel`) to a specific
   * cell `(row, col)` — or wall center when `row === null`.
   */
  function anchorAimToCell(qRel, row, col, frameW, frameH) {
    const p = projectPixelToWall(qRel, frameW * 0.5, frameH * 0.5, frameW, frameH);
    if (!p.ok) return false;
    let targetX = 0;
    let targetY = 0;
    if (row !== null && col !== null && row >= 0 && row < cfg.rows && col >= 0 && col < cfg.cols) {
      const cell = cells[row * cfg.cols + col];
      targetX = cell.cx;
      targetY = cell.cy;
    }
    stance.px += (targetX - p.wx);
    stance.py += (targetY - p.wy);
    stance.stanceWarning = false;
    return true;
  }

  /**
   * 2-Corner Calibration supporting either top corner as the start:
   *  - `startCorner === 'top-left'`:  Step 1 = R1C1 (top-left),  Step 2 = R_last C_last (bottom-right)
   *  - `startCorner === 'top-right'`: Step 1 = R1C_last (top-right), Step 2 = R_last C1 (bottom-left)
   * Computes empirical angular scale so tilting & panning matches the exact physical array span.
   */
  function recordCornerCalibration(step, qRel, startCorner = 'top-left') {
    quatRotateVec(qRel, 0, 0, -1, rotScratch);
    const rx = cfg.invertPan ? -rotScratch[0] : rotScratch[0];
    const ry = cfg.invertTilt ? -rotScratch[1] : rotScratch[1];
    const wzIn = -rotScratch[2];
    if (wzIn < MIN_WZ_IN) return { ok: false, error: 'TooOblique' };

    const tx = rx / wzIn;
    const ty = ry / wzIn;

    if (step === 1) {
      const corner = startCorner === 'top-right' ? 'top-right' : 'top-left';
      twoCornerAnchorA = { tx, ty, corner };
      return { ok: true, step: 1, corner };
    }

    if (step === 2 && twoCornerAnchorA) {
      const isTR = twoCornerAnchorA.corner === 'top-right';
      const cellA = isTR ? cells[cfg.cols - 1] : cells[0];
      const cellB = isTR ? cells[(cfg.rows - 1) * cfg.cols] : cells[cells.length - 1];
      const dTx = tx - twoCornerAnchorA.tx;
      const dTy = ty - twoCornerAnchorA.ty;
      const spanX = cellB.cx - cellA.cx; // + for TL->BR, - for TR->BL
      const spanY = cellB.cy - cellA.cy; // - for both (top -> bottom)

      if (Math.abs(dTx) < 0.08 || Math.abs(dTy) < 0.08) {
        return { ok: false, error: 'AngleSpanTooSmall' };
      }

      // Compute exact effective standoff along X and Y from angular span
      const dEffX = spanX / dTx;
      const dEffY = spanY / dTy;
      if (dEffX <= 4 || dEffY <= 4 || dEffX > 150 || dEffY > 150) {
        return { ok: false, error: 'InvalidDirectionOrSpan' };
      }

      const dAvg = 0.5 * (dEffX + dEffY);
      stance.d = dAvg;
      stance.scaleX = dEffX / dAvg;
      stance.scaleY = dEffY / dAvg;
      stance.yawTrimRad = 0;
      stance.pitchTrimRad = 0;
      // Place (px, py) so corner A lands squarely on cellA
      stance.px = cellA.cx - dAvg * twoCornerAnchorA.tx * stance.scaleX;
      stance.py = cellA.cy - dAvg * twoCornerAnchorA.ty * stance.scaleY;
      stance.calibratedTwoCorner = true;
      stance.stanceWarning = false;
      twoCornerAnchorA = null;

      return {
        ok: true,
        step: 2,
        startCorner: isTR ? 'top-right' : 'top-left',
        estimatedDistanceIn: Math.round(dAvg * 10) / 10,
        aspectRatioCheck: Math.round((dEffX / dEffY) * 100) / 100,
      };
    }

    return { ok: false, error: 'MissingStep1' };
  }

  /**
   * Processes one decoded Code 128 observation from the worker and maps it onto the array.
   *
   * @param {{
   *   payload: string,
   *   cx: number,
   *   cy: number,
   *   lenPx?: number,
   *   consensus?: number,
   *   tFrameMs?: number
   * }} obs
   * @param {Float64Array} qRel
   * @param {number} frameW
   * @param {number} frameH
   */
  function addObservation(obs, qRel, frameW, frameH) {
    const proj = projectPixelToWall(qRel, obs.cx, obs.cy, frameW, frameH);
    if (!proj.ok) {
      return { placed: false, reason: 'oblique', proj };
    }

    // Optional gentle standoff update from physical label pixel length (opt-in only, so
    // testing with non-6" labels or desk mockups never corrupts user standoff / 2-corner cal)
    if (cfg.autoDistanceFromLabel && !stance.calibratedTwoCorner && obs.lenPx && obs.lenPx > 60) {
      const fPx = getFocalLengthPx(frameW, frameH);
      const dObs = (fPx * cfg.labelLenIn * proj.wzIn) / obs.lenPx;
      if (dObs >= 10 && dObs <= 70) {
        stance.d = stance.d * 0.85 + dObs * 0.15;
      }
    }

    const col = Math.round(proj.colFloat);
    const row = Math.round(proj.rowFloat);
    if (col < 0 || col >= cfg.cols || row < 0 || row >= cfg.rows) {
      recordUnplaced(obs.payload, proj.wx, proj.wy);
      return { placed: false, reason: 'out-of-bounds', proj };
    }

    const cell = cells[row * cfg.cols + col];
    const ex = proj.wx - cell.cx;
    const ey = proj.wy - cell.cy;
    const errIn = Math.hypot(ex, ey);
    const tolX = cfg.pitchXIn * cfg.snapTolFracX;
    const tolY = cfg.pitchYIn * cfg.snapTolFracY;

    if (Math.abs(ex) > tolX || Math.abs(ey) > tolY) {
      recordUnplaced(obs.payload, proj.wx, proj.wy);
      return { placed: false, reason: 'outside-snap-tolerance', proj, errIn };
    }

    const now = obs.tFrameMs || performance.now();
    const prevVotes = cell.votes.get(obs.payload) || 0;
    cell.votes.set(obs.payload, prevVotes + 1);
    cell.readCount++;
    cell.lastSeenMs = now;
    cell.lastErrIn = Math.round(errIn * 10) / 10;
    if (!cell.firstSeenMs) cell.firstSeenMs = now;

    // Determine winning payload & conflict state
    let bestPayload = '';
    let bestCount = 0;
    let secondCount = 0;
    for (const [p, cnt] of cell.votes.entries()) {
      if (cnt > bestCount) {
        secondCount = bestCount;
        bestCount = cnt;
        bestPayload = p;
      } else if (cnt > secondCount) {
        secondCount = cnt;
      }
    }

    cell.payload = bestPayload;
    cell.state = secondCount > 0 && secondCount >= Math.max(1, Math.floor(bestCount * 0.5))
      ? 'CONFLICT'
      : 'READ';
    payloadToCellIdx.set(bestPayload, cell.index);

    // Gentle body-sway anchor absorption (only when single clear payload and close to center)
    stance.lastResidualIn = Math.round(errIn * 10) / 10;
    if (cell.state === 'READ' && errIn < Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.38) {
      stance.px -= ex * 0.22;
      stance.py -= ey * 0.22;
      stance.stanceWarning = false;
    } else if (errIn > Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.42) {
      stance.stanceWarning = true;
    }

    return { placed: true, cell, proj, errIn };
  }

  function recordUnplaced(payload, wx, wy) {
    if (!unplaced.some((u) => u.payload === payload)) {
      unplaced.push({ payload, wx: Math.round(wx * 10) / 10, wy: Math.round(wy * 10) / 10 });
    }
  }

  function clearCell(index) {
    const c = cells[index];
    if (!c) return;
    c.state = 'EMPTY';
    c.payload = '';
    c.readCount = 0;
    c.votes.clear();
    c.firstSeenMs = 0;
    c.lastSeenMs = 0;
    c.lastErrIn = 0;
  }

  function resetAll() {
    stance.px = 0;
    stance.py = 0;
    stance.d = cfg.distanceIn;
    stance.yawTrimRad = 0;
    stance.pitchTrimRad = 0;
    stance.scaleX = 1;
    stance.scaleY = 1;
    stance.lastResidualIn = 0;
    stance.stanceWarning = false;
    stance.calibratedTwoCorner = false;
    rebuildGrid();
  }

  function updateConfig(patch) {
    const gridChanged =
      (patch.cols !== undefined && patch.cols !== cfg.cols) ||
      (patch.rows !== undefined && patch.rows !== cfg.rows) ||
      (patch.pitchXIn !== undefined && patch.pitchXIn !== cfg.pitchXIn) ||
      (patch.pitchYIn !== undefined && patch.pitchYIn !== cfg.pitchYIn);

    Object.assign(cfg, patch);
    if (patch.distanceIn !== undefined && !stance.calibratedTwoCorner) {
      stance.d = cfg.distanceIn;
    }
    if (gridChanged) {
      resetAll();
    }
  }

  function exportCsv() {
    const lines = ['row,col,cell,state,payload,reads,err_in'];
    for (const c of cells) {
      lines.push(`${c.row + 1},${c.col + 1},${c.id},${c.state},"${c.payload}",${c.readCount},${c.lastErrIn}`);
    }
    return lines.join('\n');
  }

  function getSummary() {
    let readCount = 0;
    let conflictCount = 0;
    for (const c of cells) {
      if (c.state === 'READ') readCount++;
      else if (c.state === 'CONFLICT') conflictCount++;
    }
    return {
      total: cells.length,
      readCount,
      conflictCount,
      unplacedCount: unplaced.length,
      complete: readCount === cells.length && conflictCount === 0,
    };
  }

  return {
    cfg,
    stance,
    getCells: () => cells,
    getUnplaced: () => unplaced,
    getFocalLengthPx,
    projectPixelToWall,
    getCameraFootprint,
    getAimQuaternionForCell,
    getStartCornerAim,
    anchorAimToCell,
    recordCornerCalibration,
    addObservation,
    clearCell,
    resetAll,
    updateConfig,
    exportCsv,
    getSummary,
  };
}
