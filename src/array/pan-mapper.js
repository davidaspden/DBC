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

import { quatRotateVec, quatFromPanTiltRollDeg, quatConjugate } from './orient.js?v=6';
import { FC_PROFILE, computeCode128Modules, resolveTotePitch } from './config.js';
import { evaluateOptics, estimateModules } from './optics.js';
import { AXIS_REMAPS, applyAxisRemap } from './setup.js';
import {
  solveDistanceFromLabel,
  solveTwoReadFocalAndDistance,
  createPanKalmanFilter,
  computeDriftSigmaIn,
} from './kalman.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const MIN_WZ_IN = 0.25; // Reject oblique rays > ~75 deg off wall normal

export function createPanArrayMapper(opts = {}) {
  const useFc = Boolean(opts.fcLabelDefaults);
  const basePitch = opts.toteOrientation ? resolveTotePitch(opts.toteOrientation) : null;
  const cfg = {
    cols: opts.cols || 4,
    rows: opts.rows || 4,
    toteOrientation: opts.toteOrientation || '14Wx16H',
    pitchXIn: opts.pitchXIn || (basePitch ? basePitch.pitchXIn : 14),
    pitchYIn: opts.pitchYIn || (basePitch ? basePitch.pitchYIn : 16),
    labelLenIn: opts.labelLenIn || (useFc ? FC_PROFILE.labelLenIn : 6),
    labelWidthIn: opts.labelWidthIn || (useFc ? FC_PROFILE.labelWidthIn : 2),
    payloadChars: opts.payloadChars || (useFc ? FC_PROFILE.payloadChars : 16),
    labelModules: opts.labelModules || (useFc ? computeCode128Modules(opts.payloadChars || FC_PROFILE.payloadChars) : 231),
    labelOrientation: opts.labelOrientation || 'ladder',
    hfovDeg: opts.hfovDeg || 70.7,       // 1x main lens horizontal FOV (long-axis)
    zoom: opts.zoom || 1,
    distanceIn: opts.distanceIn || (useFc ? FC_PROFILE.distanceIn : 30),
    stanceMode: opts.stanceMode || 'centre', // 'centre' (legacy default) | 'in-front' (A7)
    axisRemapId: opts.axisRemapId | 0,       // A7 D4 axis remap index (0..7)
    snapTolFracX: opts.snapTolFracX || 0.48,
    snapTolFracY: opts.snapTolFracY || 0.48,
    camSensorOffsetMs: opts.camSensorOffsetMs ?? 50,
    autoDistanceFromLabel: Boolean(opts.autoDistanceFromLabel),
    invertPan: Boolean(opts.invertPan),
    invertTilt: Boolean(opts.invertTilt),
    // Wave 2 Stream A feature flags (all default OFF -> legacy behavior byte-identical)
    conflictHysteresis: Boolean(opts.conflictHysteresis),
    dupCheck: Boolean(opts.dupCheck),
    nudgeDamp: Boolean(opts.nudgeDamp),
    nudgeGain: opts.nudgeGain ?? 0.10,
    driftFromLabel: Boolean(opts.driftFromLabel),
    // Wave 3 Stream A feature flags (default OFF)
    panKalman: Boolean(opts.panKalman),
    allocCleanup: Boolean(opts.allocCleanup),
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
    lastResidualEx: 0,
    lastResidualEy: 0,
    lastReadCellIdx: -1,
    lastReadPayload: '',
    lastNudgeMs: 0,
    nudgeCumInWindow: 0,
    driftSigmaIn: 0,
    stanceWarning: false,
    calibratedTwoCorner: false,
  };

  // A8 (`panKalman`): pre-allocated 3-state residual Kalman filter
  const kalman = createPanKalmanFilter({ camSensorOffsetMs: cfg.camSensorOffsetMs });

  // Scratch vectors & reusable footprint buffers (A9 zero hot-loop allocations)
  const rayScratch = new Float64Array(3);
  const rotScratch = new Float64Array(3);
  const qConjScratch = new Float64Array(4);
  const fpCenterScratch = { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 };
  const fpCornerScratch = [
    { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 },
    { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 },
    { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 },
    { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 },
  ];
  const fpResultScratch = {
    ok: false,
    center: fpCenterScratch,
    corners: fpCornerScratch,
    targetCell: null,
    inGrid: false,
  };

  let cells = [];
  const payloadToCellIdx = new Map();
  let duplicateEvents = [];
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
   * Writes into optional `out` struct (A9 zero-allocation path) or returns a fresh object.
   */
  function projectPixelToWall(qRel, px, py, frameW, frameH, out = null) {
    const fPx = getFocalLengthPx(frameW, frameH);
    const u = (px - frameW * 0.5) / fPx;
    const v = -(py - frameH * 0.5) / fPx; // +v is up
    const invLen = 1 / Math.hypot(u, v, 1);
    rayScratch[0] = u * invLen;
    rayScratch[1] = v * invLen;
    rayScratch[2] = -invLen;

    quatRotateVec(qRel, rayScratch[0], rayScratch[1], rayScratch[2], rotScratch);
    let rx = rotScratch[0];
    let ry = rotScratch[1];
    if (cfg.axisRemapId > 0 && cfg.axisRemapId < AXIS_REMAPS.length) {
      const m = applyAxisRemap(rx, ry, AXIS_REMAPS[cfg.axisRemapId]);
      rx = m.x;
      ry = m.y;
    }
    rx = cfg.invertPan ? -rx : rx;
    ry = cfg.invertTilt ? -ry : ry;
    const wzIn = -rotScratch[2]; // positive into wall

    const res = out || { ok: false, wx: 0, wy: 0, wzIn: 0, colFloat: -1, rowFloat: -1 };
    if (wzIn < MIN_WZ_IN) {
      res.ok = false;
      res.wx = 0;
      res.wy = 0;
      res.wzIn = wzIn;
      res.colFloat = -1;
      res.rowFloat = -1;
      return res;
    }

    // Apply small yaw/pitch trim + optional 2-corner empirical scale
    const tanX = (rx / wzIn) + Math.tan(stance.yawTrimRad);
    const tanY = (ry / wzIn) + Math.tan(stance.pitchTrimRad);
    const wx = stance.px + stance.d * tanX * stance.scaleX;
    const wy = stance.py + stance.d * tanY * stance.scaleY;

    const colFloat = wx / cfg.pitchXIn + (cfg.cols - 1) * 0.5;
    const rowFloat = (cfg.rows - 1) * 0.5 - wy / cfg.pitchYIn;

    res.ok = true;
    res.wx = wx;
    res.wy = wy;
    res.wzIn = wzIn;
    res.colFloat = colFloat;
    res.rowFloat = rowFloat;
    return res;
  }

  /**
   * Projects the camera center ray + 4 frame corners onto the wall plane for live HUD rendering.
   * When `cfg.allocCleanup` is enabled (A9), reuses preallocated scratch structs with zero GC.
   */
  function getCameraFootprint(qRel, frameW, frameH) {
    if (cfg.allocCleanup) {
      const center = projectPixelToWall(qRel, frameW * 0.5, frameH * 0.5, frameW, frameH, fpCenterScratch);
      projectPixelToWall(qRel, 0, 0, frameW, frameH, fpCornerScratch[0]);
      projectPixelToWall(qRel, frameW, 0, frameW, frameH, fpCornerScratch[1]);
      projectPixelToWall(qRel, frameW, frameH, frameW, frameH, fpCornerScratch[2]);
      projectPixelToWall(qRel, 0, frameH, frameW, frameH, fpCornerScratch[3]);
      const col = Math.round(center.colFloat);
      const row = Math.round(center.rowFloat);
      const inGrid = center.ok && col >= 0 && col < cfg.cols && row >= 0 && row < cfg.rows;
      fpResultScratch.ok = center.ok;
      fpResultScratch.targetCell = inGrid ? cells[row * cfg.cols + col] : null;
      fpResultScratch.inGrid = inGrid;
      return fpResultScratch;
    }

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
   * C7 (`predictCrop`) / A8 helper: Projects the expected center & height of cell `(row, col)`
   * onto image pixel coordinates `(uPx, vPx, expectedLenPx)` under orientation `qRel`.
   */
  function predictLabelPixel(qRel, row, col, frameW, frameH) {
    if (row < 0 || row >= cfg.rows || col < 0 || col >= cfg.cols) {
      return { ok: false, inFrame: false, uPx: 0, vPx: 0, expectedLenPx: 0 };
    }
    const cell = cells[row * cfg.cols + col];
    const wx = (cell.cx - stance.px) / (stance.scaleX || 1);
    const wy = (cell.cy - stance.py) / (stance.scaleY || 1);
    const wz = -stance.d; // wall lies at z = -d in camera-origin wall frame
    const rxW = cfg.invertPan ? -wx : wx;
    const ryW = cfg.invertTilt ? -wy : wy;

    quatConjugate(qRel, qConjScratch);
    quatRotateVec(qConjScratch, rxW, ryW, wz, rotScratch);
    const camZ = -rotScratch[2];
    if (camZ < 2.0) {
      return { ok: false, inFrame: false, uPx: 0, vPx: 0, expectedLenPx: 0 };
    }
    const fPx = getFocalLengthPx(frameW, frameH);
    const uPx = frameW * 0.5 + (rotScratch[0] / camZ) * fPx;
    const vPx = frameH * 0.5 - (rotScratch[1] / camZ) * fPx;
    const panRad = Math.atan2(wx, stance.d);
    const tiltRad = Math.atan2(wy, Math.hypot(wx, stance.d));
    const expectedLenPx =
      (fPx * cfg.labelLenIn * Math.cos(tiltRad) * Math.cos(tiltRad) * Math.cos(panRad)) / Math.max(4, stance.d);
    const inFrame = uPx >= 0 && uPx <= frameW && vPx >= 0 && vPx <= frameH;
    return { ok: true, inFrame, uPx, vPx, expectedLenPx };
  }

  /**
   * A9 (`allocCleanup`): Writes compact cell state codes into a pre-allocated Uint8Array
   * (0=EMPTY, 1=READ, 2=LOW_CONF, 3=CONFLICT, 4=MISSING) so UI code avoids `getCells().map(...)`.
   */
  function getCellStateSnapshot(outUint8) {
    const n = cells.length;
    const dst = outUint8 && outUint8.length >= n ? outUint8 : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = cells[i].state;
      dst[i] = s === 'READ' ? 1 : (s === 'LOW_CONF' ? 2 : (s === 'CONFLICT' ? 3 : (s === 'MISSING' ? 4 : 0)));
    }
    return dst;
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
    // A2 (`conflictHysteresis`): prefixOk reads count double (2), plain reads count 1
    const voteWeight = cfg.conflictHysteresis && obs.prefixOk ? 2 : 1;
    const prevVotes = cell.votes.get(obs.payload) || 0;
    cell.votes.set(obs.payload, prevVotes + voteWeight);
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
    if (cfg.conflictHysteresis) {
      // A2: single stray misread does not flip a solid cell to CONFLICT;
      // requires runner-up >= 2 votes AND >= 1/3 of winner to declare CONFLICT.
      if (secondCount >= 2 && secondCount * 3 >= bestCount) {
        cell.state = 'CONFLICT';
      } else if (bestCount >= 2 && bestCount >= secondCount * 3) {
        cell.state = 'READ';
      } else {
        cell.state = bestCount >= 1 && secondCount === 0 ? 'READ' : 'LOW_CONF';
      }
    } else {
      cell.state = secondCount > 0 && secondCount >= Math.max(1, Math.floor(bestCount * 0.5))
        ? 'CONFLICT'
        : 'READ';
    }

    // A3 (`dupCheck`): cross-cell duplicate payload guard
    if (cfg.dupCheck && bestPayload) {
      let bestOwnerIdx = cell.index;
      let bestOwnerVotes = bestCount;
      for (let i = 0; i < cells.length; i++) {
        if (i === cell.index) continue;
        const other = cells[i];
        if (!other || other.payload !== bestPayload) continue;
        const otherVotes = other.votes.get(bestPayload) || 0;
        if (otherVotes > bestOwnerVotes) {
          bestOwnerIdx = i;
          bestOwnerVotes = otherVotes;
        }
        if (bestCount >= 2 && otherVotes >= 2) {
          cell.state = 'CONFLICT';
          other.state = 'CONFLICT';
        } else if (bestCount >= otherVotes) {
          other.state = 'LOW_CONF';
        } else {
          cell.state = 'LOW_CONF';
        }
        duplicateEvents.push({ payload: bestPayload, cells: [other.id, cell.id], ts: now });
      }
      payloadToCellIdx.set(bestPayload, bestOwnerIdx);
    } else if (bestPayload) {
      payloadToCellIdx.set(bestPayload, cell.index);
    }

    // Gentle body-sway anchor absorption (or A8 Kalman filter when `cfg.panKalman` is enabled)
    stance.lastResidualIn = Math.round(errIn * 10) / 10;
    if (cfg.panKalman) {
      const dtSec = stance.lastNudgeMs > 0 ? Math.max(0.01, (now - stance.lastNudgeMs) * 0.001) : 0.05;
      stance.lastNudgeMs = now;
      const panRad = Math.atan2(proj.wx - stance.px, stance.d);
      const tiltRad = Math.atan2(proj.wy - stance.py, Math.hypot(proj.wx - stance.px, stance.d));
      stance.driftSigmaIn = Math.round(computeDriftSigmaIn(stance.d, panRad, dtSec) * 100) / 100;

      // Angle-compensated standoff distance refinement from label height `lenPx`
      if (obs.lenPx > 20) {
        const dSol = solveDistanceFromLabel({
          fPx: getFocalLengthPx(frameW, frameH),
          labelLenIn: cfg.labelLenIn,
          lenPx: obs.lenPx,
          panRad,
          tiltRad,
          minIn: 6,
          maxIn: 50,
        });
        if (dSol) {
          stance.d = Math.max(6, Math.min(50, stance.d + 0.3 * (dSol.dIn - stance.d)));
        }
      }

      if (errIn > Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.42) {
        stance.stanceWarning = true;
      } else if (cell.state === 'READ') {
        kalman.x[0] = stance.yawTrimRad;
        kalman.x[1] = stance.px;
        kalman.x[2] = stance.py;
        kalman.predict(dtSec);
        kalman.update(-ex, -ey, stance.d, proj.wzIn);
        stance.yawTrimRad = Math.max(-0.25, Math.min(0.25, kalman.x[0]));
        stance.px = kalman.x[1];
        stance.py = kalman.x[2];
        stance.stanceWarning = false;
      }
      stance.lastResidualEx = ex;
      stance.lastResidualEy = ey;
      stance.lastReadCellIdx = cell.index;
      stance.lastReadPayload = bestPayload;
    } else if (cfg.nudgeDamp) {
      // A4: damped stance nudge only on agreeing reads within 3 in of prior residual, rate-capped
      const sameRead = stance.lastReadCellIdx === cell.index && stance.lastReadPayload === bestPayload;
      const resJump = Math.hypot(ex - stance.lastResidualEx, ey - stance.lastResidualEy);
      if (now - stance.lastNudgeMs > 1000) {
        stance.nudgeCumInWindow = 0;
        stance.lastNudgeMs = now;
      }
      if (
        cell.state === 'READ' &&
        !stance.stanceWarning &&
        sameRead &&
        resJump <= 3.0 &&
        errIn < Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.38 &&
        stance.nudgeCumInWindow < 2.0
      ) {
        const g = Math.max(0.02, Math.min(0.15, cfg.nudgeGain));
        const dx = ex * g;
        const dy = ey * g;
        stance.px -= dx;
        stance.py -= dy;
        stance.nudgeCumInWindow += Math.hypot(dx, dy);
      } else if (errIn > Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.42) {
        stance.stanceWarning = true;
      }
      stance.lastResidualEx = ex;
      stance.lastResidualEy = ey;
      stance.lastReadCellIdx = cell.index;
      stance.lastReadPayload = bestPayload;
    } else if (cell.state === 'READ' && errIn < Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.38) {
      stance.px -= ex * 0.22;
      stance.py -= ey * 0.22;
      stance.stanceWarning = false;
    } else if (errIn > Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.42) {
      stance.stanceWarning = true;
    }

    return { placed: true, cell, proj, errIn };
  }

  /**
   * A5 (`driftFromLabel`): Re-anchors camera stance `(px, py)` using the decoded barcode's
   * exact pixel coordinates `(obs.cx, obs.cy)` rather than frame center. Rejects large jumps
   * (> 0.5 * minPitch) unless `force === true`.
   */
  function anchorObservationToCell(obs, qRel, row, col, frameW, frameH, force = false) {
    if (row < 0 || row >= cfg.rows || col < 0 || col >= cfg.cols) return { ok: false, reason: 'invalid-cell' };
    const p = projectPixelToWall(qRel, obs.cx, obs.cy, frameW, frameH);
    if (!p.ok) return { ok: false, reason: 'oblique' };
    const cell = cells[row * cfg.cols + col];
    const dx = cell.cx - p.wx;
    const dy = cell.cy - p.wy;
    const jumpIn = Math.hypot(dx, dy);
    if (!force && jumpIn > Math.min(cfg.pitchXIn, cfg.pitchYIn) * 0.5) {
      stance.stanceWarning = true;
      return { ok: false, reason: 'jump-too-large', jumpIn: Math.round(jumpIn * 10) / 10 };
    }
    stance.px += dx;
    stance.py += dy;
    stance.stanceWarning = false;
    return { ok: true, jumpIn: Math.round(jumpIn * 10) / 10 };
  }

  function recordUnplaced(payload, wx, wy) {
    if (!unplaced.some((u) => u.payload === payload)) {
      unplaced.push({ payload, wx: Math.round(wx * 10) / 10, wy: Math.round(wy * 10) / 10 });
    }
  }

  function clearCell(index) {
    const c = cells[index];
    if (!c) return;
    if (c.payload && payloadToCellIdx.get(c.payload) === index) {
      payloadToCellIdx.delete(c.payload);
    }
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
    stance.lastResidualEx = 0;
    stance.lastResidualEy = 0;
    stance.lastReadCellIdx = -1;
    stance.lastReadPayload = '';
    stance.stanceWarning = false;
    stance.calibratedTwoCorner = false;
    stance.driftSigmaIn = 0;
    kalman.reset(0, 0, 0);
    duplicateEvents = [];
    rebuildGrid();
  }

  function updateConfig(patch) {
    const nextPatch = { ...patch };
    if (nextPatch.toteOrientation && nextPatch.pitchXIn === undefined && nextPatch.pitchYIn === undefined) {
      const p = resolveTotePitch(nextPatch.toteOrientation);
      nextPatch.pitchXIn = p.pitchXIn;
      nextPatch.pitchYIn = p.pitchYIn;
    }
    if (nextPatch.payloadChars !== undefined && nextPatch.labelModules === undefined) {
      nextPatch.labelModules = estimateModules(nextPatch.payloadChars);
    }
    const gridChanged =
      (nextPatch.cols !== undefined && nextPatch.cols !== cfg.cols) ||
      (nextPatch.rows !== undefined && nextPatch.rows !== cfg.rows) ||
      (nextPatch.pitchXIn !== undefined && nextPatch.pitchXIn !== cfg.pitchXIn) ||
      (nextPatch.pitchYIn !== undefined && nextPatch.pitchYIn !== cfg.pitchYIn);

    Object.assign(cfg, nextPatch);
    if (nextPatch.distanceIn !== undefined && !stance.calibratedTwoCorner) {
      stance.d = cfg.distanceIn;
    }
    if (gridChanged) {
      resetAll();
    }
  }

  /**
   * A1: Returns current pixels-per-module optics feasibility report at active standoff & zoom.
   */
  function getOpticsReport(widthPx = 1920, heightPx = 1080) {
    return evaluateOptics({
      distanceIn: stance.d,
      hfovDeg: cfg.hfovDeg,
      zoom: cfg.zoom,
      widthPx,
      heightPx,
      labelLenIn: cfg.labelLenIn,
      modules: cfg.labelModules,
    });
  }

  /**
   * A7: Sets camera stance for standing directly in front of `cell` (square to wall, yaw=0)
   * using the gravity-measured elevation `pitchDeg`, so zeroing on R1C1 from in front of R1C1
   * does not bake in a 35 deg wall-centre angle error.
   */
  function setInFrontStanceForCell(row, col, pitchDeg = 0) {
    if (row === null || col === null || row < 0 || row >= cfg.rows || col < 0 || col >= cfg.cols) {
      stance.px = 0;
      stance.py = -stance.d * Math.tan(pitchDeg * DEG_TO_RAD);
      return;
    }
    const cell = cells[row * cfg.cols + col];
    stance.px = cell.cx;
    stance.py = cell.cy - stance.d * Math.tan(pitchDeg * DEG_TO_RAD);
    stance.stanceWarning = false;
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
    getCellStateSnapshot,
    getUnplaced: () => unplaced,
    getDuplicateEvents: () => duplicateEvents,
    getFocalLengthPx,
    projectPixelToWall,
    predictLabelPixel,
    getCameraFootprint,
    getAimQuaternionForCell,
    getStartCornerAim,
    setInFrontStanceForCell,
    getOpticsReport,
    anchorAimToCell,
    anchorObservationToCell,
    recordCornerCalibration,
    solveTwoReadFocalAndDistance,
    kalman,
    addObservation,
    clearCell,
    resetAll,
    updateConfig,
    exportCsv,
    getSummary,
  };
}
