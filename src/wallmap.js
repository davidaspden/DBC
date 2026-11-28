/**
 * A10 — Close-Range Slide-Mode Wall Mapper (Part 2, `slideMap` flag).
 *
 * Designed for phones without a reachable optical telephoto lens (e.g. Samsung Galaxy A53 5G)
 * scanning a 4×4 tote wall at 8–12 in standoff using sideways row passes:
 *  - Gyro de-rotation of optical flow `(flowDx, flowDy)`
 *  - Gravity roll/pitch plane flattening (warns if |roll| > 30 deg)
 *  - Metric standoff scaling from decoded label height `d = f * labelLenIn / lenPx` (5–14 in)
 *  - Optical flow pose integration (`TRACKING`) + <= 1.5 s ZUPT-assisted IMU bridging (`DEGRADED`)
 *    + topology-only fallback (`LOST`)
 *  - Lattice snapping with learned label offset `(muX, muY)`, snake order prior, and composite
 *    confidence `cellConf = 0.5 * spatial + 0.3 * order + 0.2 * drift`
 *  - Strict safety invariant: NEVER silently places a label in the wrong cell with high confidence
 */

import { FC_PROFILE, resolveTotePitch } from './array/config.js';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const CONF_OK = 0.22;
const MAX_IMU_BRIDGE_S = 1.5;

export function createSlideWallMapper(opts = {}) {
  const basePitch = opts.toteOrientation ? resolveTotePitch(opts.toteOrientation) : null;
  const cfg = {
    cols: opts.cols || 4,
    rows: opts.rows || 4,
    toteOrientation: opts.toteOrientation || FC_PROFILE.toteOrientation, // '16Wx14H' confirmed OQ1
    pitchXIn: opts.pitchXIn || (basePitch ? basePitch.pitchXIn : FC_PROFILE.pitchXIn),
    pitchYIn: opts.pitchYIn || (basePitch ? basePitch.pitchYIn : FC_PROFILE.pitchYIn),
    labelLenIn: opts.labelLenIn || FC_PROFILE.labelLenIn, // 3.5 in
    hfovDeg: opts.hfovDeg || 70.7,
    distanceIn: opts.distanceIn || 10.0,
    startCorner: opts.startCorner || 'top-left', // 'top-left' | 'top-right'
    snapTolXIn: opts.snapTolXIn || 6.0,
    snapTolYIn: opts.snapTolYIn || 5.0,
    useDerotation: opts.useDerotation !== false,
    useLatticeSnap: opts.useLatticeSnap !== false,
    useOrderPrior: opts.useOrderPrior !== false,
    useFlow: opts.useFlow !== false,
  };

  const pose = {
    x: 0,
    y: 0,
    d: cfg.distanceIn,
    vx: 0,
    vy: 0,
    driftSigmaIn: 0,
    rollDeg: 0,
    pitchDeg: 0,
    rollWarning: false,
  };

  // Learned systematic label offset within each tote (inches)
  let muX = 0;
  let muY = 0;
  let muSamples = 0;

  // Tracking & lane state machine (rows snake)
  let trackingState = 'TRACKING'; // 'TRACKING' | 'DEGRADED' | 'LOST'
  let fallbackTier = 'A';         // 'A' (flow+gyro+lattice) | 'B' (IMU bridge) | 'C' (topology) | 'D' (manual)
  let bridgeTimeS = 0;
  let currentRow = 0;
  let currentDir = cfg.startCorner === 'top-right' ? -1 : 1; // +1 left->right, -1 right->left
  let expectedCellIdx = cfg.startCorner === 'top-right' ? (cfg.cols - 1) : 0;
  let laneChangePending = false;
  let laneStepAccumY = 0;

  let cells = [];
  const payloadToCellIdx = new Map();
  let unplaced = [];
  let duplicateEvents = [];
  let lastAnchoredCellIdx = -1;

  function buildGrid() {
    cells = [];
    payloadToCellIdx.clear();
    unplaced = [];
    duplicateEvents = [];
    for (let r = 0; r < cfg.rows; r++) {
      for (let c = 0; c < cfg.cols; c++) {
        cells.push({
          index: r * cfg.cols + c,
          row: r,
          col: c,
          id: `R${r + 1}C${c + 1}`,
          cx: c * cfg.pitchXIn,
          cy: -r * cfg.pitchYIn, // +Y up, row 0 at y = 0, row 1 at y = -pitchY
          state: 'EMPTY',        // EMPTY | READ | LOW_CONF | CONFLICT | MISSING
          payload: '',
          readCount: 0,
          cellConf: 0,
          votes: new Map(),
          lastSeenMs: 0,
        });
      }
    }
    const startCol = cfg.startCorner === 'top-right' ? (cfg.cols - 1) : 0;
    pose.x = cells[startCol].cx;
    pose.y = cells[startCol].cy;
    pose.d = cfg.distanceIn;
    pose.vx = 0;
    pose.vy = 0;
    pose.driftSigmaIn = 0;
    currentRow = 0;
    currentDir = cfg.startCorner === 'top-right' ? -1 : 1;
    expectedCellIdx = startCol;
    laneChangePending = false;
    laneStepAccumY = 0;
    trackingState = 'TRACKING';
    fallbackTier = 'A';
    bridgeTimeS = 0;
    muX = 0;
    muY = 0;
    muSamples = 0;
    lastAnchoredCellIdx = -1;
  }

  buildGrid();

  function getFocalLengthPx(frameW, frameH) {
    const longPx = Math.max(frameW || 1920, frameH || 1080);
    return (longPx * 0.5) / Math.tan((cfg.hfovDeg * 0.5) * DEG_TO_RAD);
  }

  function snakeSequence() {
    const seq = [];
    let dir = cfg.startCorner === 'top-right' ? -1 : 1;
    for (let r = 0; r < cfg.rows; r++) {
      if (dir === 1) {
        for (let c = 0; c < cfg.cols; c++) seq.push(r * cfg.cols + c);
      } else {
        for (let c = cfg.cols - 1; c >= 0; c--) seq.push(r * cfg.cols + c);
      }
      dir = -dir;
    }
    return seq;
  }

  function computeOrderScore(cellIdx) {
    if (!cfg.useOrderPrior) return 0.65;
    const seq = snakeSequence();
    const expPos = seq.indexOf(expectedCellIdx);
    const candPos = seq.indexOf(cellIdx);
    if (expPos < 0 || candPos < 0) return 0.3;
    if (candPos === expPos) return 1.0;
    if (candPos === expPos + 1) return 0.7; // 1 skipped/missing cell
    if (candPos === expPos - 1) return 0.65; // slight backtrack onto previous cell
    return 0.25;
  }

  function advanceExpectedAfter(cellIdx) {
    const seq = snakeSequence();
    const pos = seq.indexOf(cellIdx);
    if (pos >= 0 && pos + 1 < seq.length) {
      expectedCellIdx = seq[pos + 1];
      const nextCell = cells[expectedCellIdx];
      if (nextCell.row !== currentRow) {
        currentRow = nextCell.row;
        currentDir = (currentRow % 2 === 0)
          ? (cfg.startCorner === 'top-right' ? -1 : 1)
          : (cfg.startCorner === 'top-right' ? 1 : -1);
      }
    }
  }

  /**
   * Per-frame motion update from optical flow (W13) + gyro + gravity/accelerometer.
   */
  function stepMotion({
    dtMs = 33,
    flowDx = 0,
    flowDy = 0,
    flowConf = 0,
    gyroRadX = 0,
    gyroRadY = 0,
    accelX = 0,
    accelY = 9.81,
    accelZ = 0,
    frameW = 1920,
    frameH = 1080,
  } = {}) {
    const dt = Math.max(0.005, Math.min(0.25, dtMs * 0.001));
    const fPx = getFocalLengthPx(frameW, frameH);

    // Gravity roll & pitch flattening
    const gNorm = Math.hypot(accelX, accelY, accelZ);
    let rollRad = 0;
    let pitchRad = 0;
    if (gNorm > 2.0) {
      rollRad = Math.atan2(accelX, accelY);
      pitchRad = Math.asin(Math.max(-0.95, Math.min(0.95, accelZ / gNorm)));
    }
    pose.rollDeg = rollRad * RAD_TO_DEG;
    pose.pitchDeg = pitchRad * RAD_TO_DEG;
    pose.rollWarning = Math.abs(pose.rollDeg) > 30;

    const clampedRoll = Math.max(-35 * DEG_TO_RAD, Math.min(35 * DEG_TO_RAD, rollRad));
    const cosR = Math.cos(clampedRoll);
    const sinR = Math.sin(clampedRoll);
    const invCosP = 1 / Math.max(0.5, Math.cos(pitchRad));

    let dxIn = 0;
    let dyIn = 0;

    if (cfg.useFlow && flowConf >= CONF_OK) {
      // 1. De-rotate flow by subtracting gyro-induced pixel shift
      let dfx = flowDx;
      let dfy = flowDy;
      if (cfg.useDerotation) {
        dfx -= fPx * Math.tan(gyroRadY * dt);
        dfy -= fPx * Math.tan(gyroRadX * dt);
      }

      // 2. Flatten roll & pitch; image motion is opposite to camera translation
      // (+flowDx right means camera moved left; +flowDy down means camera moved up in +Y wall coords)
      const camPxX = -dfx;
      const camPxY = dfy;
      const flatX = camPxX * cosR - camPxY * sinR;
      const flatY = (camPxX * sinR + camPxY * cosR) * invCosP;

      const inPerPx = pose.d / fPx;
      dxIn = flatX * inPerPx;
      dyIn = flatY * inPerPx;

      pose.x += dxIn;
      pose.y += dyIn;
      pose.vx = dxIn / dt;
      pose.vy = dyIn / dt;

      const stepIn = Math.hypot(dxIn, dyIn);
      pose.driftSigmaIn = Math.min(24, pose.driftSigmaIn + 0.04 * stepIn + 0.08 * dt);
      bridgeTimeS = 0;
      trackingState = 'TRACKING';
      fallbackTier = 'A';
    } else {
      // Weak/lost flow: ZUPT-assisted short IMU bridging up to 1.5 s, then LOST (Tier C)
      bridgeTimeS += dt;
      if (bridgeTimeS <= MAX_IMU_BRIDGE_S) {
        // Damped velocity propagation (ZUPT decay)
        const decay = Math.exp(-dt * 2.5);
        pose.vx *= decay;
        pose.vy *= decay;
        dxIn = pose.vx * dt;
        dyIn = pose.vy * dt;
        pose.x += dxIn;
        pose.y += dyIn;
        pose.driftSigmaIn = Math.min(24, pose.driftSigmaIn + 0.12 * Math.hypot(dxIn, dyIn) + 0.5 * dt);
        trackingState = 'DEGRADED';
        fallbackTier = 'B';
      } else {
        pose.vx = 0;
        pose.vy = 0;
        pose.driftSigmaIn = Math.min(30, pose.driftSigmaIn + 1.5 * dt);
        trackingState = 'LOST';
        fallbackTier = 'C';
      }
    }

    // Lane-change detector (rows snake)
    if (Math.abs(pose.vx) < 3.0 && Math.abs(pose.vy) > 1.5) {
      laneStepAccumY += dyIn;
      if (Math.abs(laneStepAccumY) > 0.5 * cfg.pitchYIn) {
        laneChangePending = true;
      }
    } else if (Math.abs(pose.vx) > 3.0) {
      laneStepAccumY = 0;
    }

    // Missing-cell detector (only while TRACKING with low drift so we never falsely mark missing)
    if (trackingState === 'TRACKING' && pose.driftSigmaIn < 4.5) {
      const expCell = cells[expectedCellIdx];
      if (expCell && expCell.state === 'EMPTY' && expCell.row === currentRow) {
        const alongPass = (pose.x - expCell.cx) * currentDir;
        if (alongPass > 0.65 * cfg.pitchXIn && Math.abs(pose.y - expCell.cy) < 0.5 * cfg.pitchYIn) {
          expCell.state = 'MISSING';
          advanceExpectedAfter(expCell.index);
        }
      }
    }

    return { trackingState, fallbackTier, pose: { ...pose }, laneChangePending };
  }

  /**
   * Processes a decoded Code 128 label observation on the wall.
   */
  function addDetection(obs) {
    const payload = obs.payload || '';
    if (!payload) return { placed: false, reason: 'empty-payload' };

    const frameW = obs.frameW || 1920;
    const frameH = obs.frameH || 1080;
    const fPx = getFocalLengthPx(frameW, frameH);
    const now = obs.tFrameMs || performance.now();

    // Update metric standoff d from label pixel height (clamp 5..14 in)
    if (obs.lenPx > 24) {
      const dObs = Math.max(5.0, Math.min(14.0, (fPx * cfg.labelLenIn) / obs.lenPx));
      pose.d = pose.d * 0.7 + dObs * 0.3;
    }

    const ox = (obs.cx !== undefined ? obs.cx : frameW * 0.5) - frameW * 0.5;
    const oy = -((obs.cy !== undefined ? obs.cy : frameH * 0.5) - frameH * 0.5);
    const inPerPx = pose.d / fPx;
    const lx = pose.x + ox * inPerPx;
    const ly = pose.y + oy * inPerPx;

    // Find nearest lattice node accounting for learned tote offset mu
    let bestCell = null;
    let bestEx = 0;
    let bestEy = 0;
    let bestDist = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const ex = lx - (c.cx + muX);
      const ey = ly - (c.cy + muY);
      const dist = Math.hypot(ex, ey);
      if (dist < bestDist) {
        bestDist = dist;
        bestEx = ex;
        bestEy = ey;
        bestCell = c;
      }
    }

    if (!bestCell) return { placed: false, reason: 'no-cells' };

    const insideTol = Math.abs(bestEx) <= cfg.snapTolXIn && Math.abs(bestEy) <= cfg.snapTolYIn;
    const spatialScore = Math.max(0, 1 - Math.hypot(bestEx / cfg.snapTolXIn, bestEy / cfg.snapTolYIn));
    const orderScore = computeOrderScore(bestCell.index);
    const driftScore = Math.exp(-pose.driftSigmaIn / Math.min(cfg.pitchXIn, cfg.pitchYIn));
    const cellConf = 0.5 * spatialScore + 0.3 * orderScore + 0.2 * driftScore;

    // Safety gate: NEVER silently place in wrong cell with high confidence
    if (trackingState === 'LOST' && orderScore < 0.7) {
      recordUnplaced(payload, lx, ly, 'tracking-lost-disagrees');
      return { placed: false, reason: 'tracking-lost-disagrees', cellConf };
    }
    if (!cfg.useLatticeSnap) {
      // Ablation mode: spatial only without lattice snap / order prior
      if (!insideTol) {
        recordUnplaced(payload, lx, ly, 'outside-tol');
        return { placed: false, reason: 'outside-tol', cellConf };
      }
    } else if (!insideTol && orderScore < 0.7) {
      recordUnplaced(payload, lx, ly, 'outside-snap-tolerance');
      return { placed: false, reason: 'outside-snap-tolerance', cellConf };
    }

    // If spatial and order strongly disagree when drift is elevated -> LOW_CONF or UNPLACED
    const highDriftDisagree = pose.driftSigmaIn > 5.0 && orderScore < 0.5;
    if (highDriftDisagree) {
      recordUnplaced(payload, lx, ly, 'high-drift-disagrees');
      return { placed: false, reason: 'high-drift-disagrees', cellConf };
    }

    const voteWeight = obs.prefixOk ? 2 : 1;
    bestCell.votes.set(payload, (bestCell.votes.get(payload) || 0) + voteWeight);
    bestCell.readCount++;
    bestCell.lastSeenMs = now;

    // Winner / runner-up check
    let bestPayload = '';
    let bestVotes = 0;
    let secondVotes = 0;
    for (const [p, v] of bestCell.votes.entries()) {
      if (v > bestVotes) {
        secondVotes = bestVotes;
        bestVotes = v;
        bestPayload = p;
      } else if (v > secondVotes) {
        secondVotes = v;
      }
    }

    bestCell.payload = bestPayload;
    bestCell.cellConf = Math.round(cellConf * 100) / 100;

    if (secondVotes >= 2 && secondVotes * 2 >= bestVotes) {
      bestCell.state = 'CONFLICT';
    } else if (cellConf >= 0.55 && trackingState !== 'LOST') {
      bestCell.state = 'READ';
    } else {
      bestCell.state = 'LOW_CONF';
    }

    // Cross-cell duplicate payload guard
    if (bestPayload) {
      let bestOwnerIdx = bestCell.index;
      let bestOwnerVotes = bestVotes;
      for (let i = 0; i < cells.length; i++) {
        if (i === bestCell.index) continue;
        const other = cells[i];
        if (other.payload !== bestPayload) continue;
        const otherVotes = other.votes.get(bestPayload) || 0;
        if (otherVotes > bestOwnerVotes) {
          bestOwnerIdx = i;
          bestOwnerVotes = otherVotes;
        }
        if (bestVotes >= 2 && otherVotes >= 2) {
          bestCell.state = 'CONFLICT';
          other.state = 'CONFLICT';
        } else if (bestVotes >= otherVotes) {
          other.state = 'LOW_CONF';
        } else {
          bestCell.state = 'LOW_CONF';
        }
        duplicateEvents.push({ payload: bestPayload, cells: [other.id, bestCell.id], ts: now });
      }
      payloadToCellIdx.set(bestPayload, bestOwnerIdx);
    }

    // Anchor pull & learned offset mu update on confident lattice hits
    if (cfg.useLatticeSnap && bestCell.state === 'READ' && cellConf >= 0.6) {
      pose.x -= 0.7 * bestEx;
      pose.y -= 0.7 * bestEy;
      pose.driftSigmaIn = Math.max(0.4, pose.driftSigmaIn * 0.25);
      if (muSamples < 32 && Math.abs(bestEx) < 2.5 && Math.abs(bestEy) < 2.5) {
        muSamples++;
        if (muSamples >= 3) {
          const alpha = 1 / muSamples;
          muX += (bestEx * 0.25) * alpha;
          muY += (bestEy * 0.25) * alpha;
        }
      }
      if (laneChangePending && bestCell.row !== currentRow) {
        laneChangePending = false;
        laneStepAccumY = 0;
      }
      if (bestCell.index !== lastAnchoredCellIdx) {
        lastAnchoredCellIdx = bestCell.index;
        advanceExpectedAfter(bestCell.index);
      }
    }

    return { placed: true, cell: bestCell, cellConf, spatialScore, orderScore, driftScore };
  }

  function recordUnplaced(payload, x, y, reason) {
    if (!unplaced.some((u) => u.payload === payload)) {
      unplaced.push({ payload, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, reason });
    }
  }

  /**
   * Fallback D (manual tap-to-anchor): anchors pose directly to `(row, col)` and resets drift.
   */
  function anchorPoseToCell(row, col) {
    if (row < 0 || row >= cfg.rows || col < 0 || col >= cfg.cols) return false;
    const cell = cells[row * cfg.cols + col];
    pose.x = cell.cx;
    pose.y = cell.cy;
    pose.vx = 0;
    pose.vy = 0;
    pose.driftSigmaIn = 0;
    currentRow = row;
    expectedCellIdx = cell.index;
    trackingState = 'TRACKING';
    fallbackTier = 'D';
    bridgeTimeS = 0;
    return true;
  }

  function setCellManually(row, col, payload) {
    if (row < 0 || row >= cfg.rows || col < 0 || col >= cfg.cols) return false;
    const cell = cells[row * cfg.cols + col];
    cell.payload = payload;
    cell.state = payload ? 'READ' : 'EMPTY';
    cell.cellConf = payload ? 1.0 : 0;
    cell.readCount = payload ? Math.max(1, cell.readCount + 1) : 0;
    anchorPoseToCell(row, col);
    if (payload) advanceExpectedAfter(cell.index);
    return true;
  }

  function exportCsv() {
    const lines = ['row,col,cell,state,payload,conf,reads'];
    for (const c of cells) {
      lines.push(`${c.row + 1},${c.col + 1},${c.id},${c.state},"${c.payload}",${c.cellConf},${c.readCount}`);
    }
    return lines.join('\n');
  }

  function getSummary() {
    let readCount = 0;
    let lowConfCount = 0;
    let conflictCount = 0;
    let missingCount = 0;
    for (const c of cells) {
      if (c.state === 'READ') readCount++;
      else if (c.state === 'LOW_CONF') lowConfCount++;
      else if (c.state === 'CONFLICT') conflictCount++;
      else if (c.state === 'MISSING') missingCount++;
    }
    return {
      total: cells.length,
      readCount,
      lowConfCount,
      conflictCount,
      missingCount,
      unplacedCount: unplaced.length,
      trackingState,
      fallbackTier,
      complete: readCount === cells.length && conflictCount === 0,
    };
  }

  return {
    cfg,
    pose,
    stepMotion,
    addDetection,
    anchorPoseToCell,
    setCellManually,
    getCells: () => cells,
    getUnplaced: () => unplaced,
    getDuplicateEvents: () => duplicateEvents,
    getTrackingState: () => ({ trackingState, fallbackTier, expectedCellIdx, currentRow, currentDir }),
    getSummary,
    exportCsv,
    exportJson: () => JSON.stringify({ cfg, summary: getSummary(), cells: cells.map(({ votes, ...rest }) => rest), unplaced }, null, 2),
    reset: buildGrid,
  };
}
