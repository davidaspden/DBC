/**
 * Human-readable + JSON report formatting, clipboard copy, and Web Share API helpers.
 * Guarantees raw deviceIds never appear in serialized reports.
 */

function fmtRange(obj) {
  if (!obj || obj === 'n/a') return 'n/a';
  if (typeof obj !== 'object') return String(obj);
  const step = obj.step !== undefined ? ` step ${obj.step}` : '';
  return `${obj.min}–${obj.max}${step}`;
}

function fmtCapList(val) {
  if (!val || val === 'n/a') return 'n/a';
  return Array.isArray(val) ? val.join('/') : String(val);
}

function fmtUtcTimestamp(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm} GMT`;
}

function summarizeDeviceLine(env) {
  const he = env.highEntropy || {};
  const model = he.model || env.uaModelGuess || 'Unknown device';
  const os = he.platform
    ? `${he.platform}${he.platformVersion ? ' ' + he.platformVersion : ''}`
    : (env.osGuess || 'Unknown OS');
  const browser = env.browserGuess || 'Unknown browser';
  return `${model} · ${os} · ${browser}`;
}

/**
 * Serializes the structured report as compact JSON (`version: 1`, no raw deviceIds).
 */
export function formatReportJson(report) {
  const payload = {
    version: 1,
    reportId: report.reportId,
    timestampUtc: report.timestampUtc,
    env: report.env,
    cameraPermission: report.cameraPermission,
    cameras: report.cameras,
    capture: report.capture,
    sensors: report.sensors,
    labelTests: report.labelTests || {},
    recommendation: report.recommendation,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Renders the single compact human-readable report block followed by `--- JSON ---`.
 */
export function formatReportText(report) {
  const env = report.env || {};
  const lines = [];

  lines.push(`DBC diag ${fmtUtcTimestamp(report.timestampUtc)}  id:${report.reportId || '000000'}`);
  lines.push(summarizeDeviceLine(env));
  const proto = env.isSecureContext ? (env.protocol === 'https:' ? 'HTTPS' : env.protocol || 'SECURE') : 'INSECURE';
  const ori = env.screenOrientation;
  const oriStr = ori ? ` · ${ori.type} (${ori.angle}deg${ori.lockSupported ? ', lock ok' : ''})` : '';
  lines.push(
    `${env.screenWidth || 0}x${env.screenHeight || 0} CSS px · ` +
    `DPR ${env.devicePixelRatio || 1} · ${proto}${oriStr}`
  );
  lines.push('');

  const cams = Array.isArray(report.cameras) ? report.cameras : [];
  if (report.cameraPermission && report.cameraPermission.granted === false) {
    lines.push(`Cameras: permission ${report.cameraPermission.error || 'denied'}`);
  } else {
    lines.push(`Cameras (${cams.length} videoinput)`);
    let rearIdx = 0;
    let otherIdx = 0;
    for (const c of cams) {
      const tag = c.facing === 'environment' ? `rear#${++rearIdx}` : `${c.facing || 'cam'}#${++otherIdx}`;
      const idShort = c.idHash ? `${c.idHash.slice(0, 8)}…` : 'none';
      const role = c.roleGuess || 'UNKNOWN';
      const warn = c.unsuitableReason ? ` [${c.unsuitableReason}]` : '';
      lines.push(`  ${tag}  ${c.label}  id:${idShort}  ${role}${warn}`);
      if (c.error) {
        lines.push(`    error  ${c.error}`);
        continue;
      }
      const caps = c.capabilities || {};
      lines.push(
        `    caps  zoom ${fmtRange(caps.zoom)} · focus ${fmtCapList(caps.focusMode)}` +
        ` · focusDist ${fmtRange(caps.focusDistance)}` +
        ` · exposureTime ${fmtRange(caps.exposureTime)} · iso ${fmtRange(caps.iso)}` +
        ` · torch ${caps.torch === true ? 'yes' : (caps.torch === false ? 'no' : 'n/a')}`
      );
      if (c.resolutions && Object.keys(c.resolutions).length > 0) {
        const parts = [];
        for (const k of ['720p', '1080p', '4K']) {
          const r = c.resolutions[k];
          if (!r) continue;
          parts.push(r.ok ? `${k} ${r.width}x${r.height}@${r.frameRate || '?'}` : `${k} refused (${r.error})`);
        }
        if (parts.length) lines.push(`    got   ${parts.join(' · ')}`);
      }
      if (c.zoomSweep && Array.isArray(c.zoomSweep.steps) && c.zoomSweep.steps.length > 0) {
        const seq = c.zoomSweep.steps.map((s) => (s.error ? `${s.requested}(err)` : String(s.achieved))).join(' → ');
        const note = c.zoomSweep.teleEvidence === 'unknown-jump'
          ? 'zoom jump observed (unverified — treated as unknown/digital)'
          : (c.zoomSweep.logicalZoomLikely ? 'verified lens switch' : 'no framing jump; likely digital');
        lines.push(`    zoom sweep  ${seq}  (${note})`);
      }
    }
  }

  const cap = report.capture;
  if (cap) {
    const vfText = cap.videoFrameSupported
      ? `yes (${cap.videoFrameFormat || 'unknown'}${cap.copyToOk ? ', copy ok' : ', copy fail'})`
      : 'no';
    const resCond = cap.width && cap.height ? ` @ ${cap.width}x${cap.height}` : '';
    const expCond = cap.exposureTimeMs !== undefined && cap.exposureTimeMs !== null
      ? ` exp=${cap.exposureMode || 'auto'} ${cap.exposureTimeMs}ms${cap.iso ? ' ISO ' + cap.iso : ''}`
      : (cap.exposureMode ? ` exp=${cap.exposureMode}` : '');
    const condStr = (resCond || expCond) ? `${resCond}${expCond ? ' (' + expCond.trim() + ')' : ''}` : '';
    lines.push(
      `Capture  ${cap.rVfcSupported ? 'rVFC' : 'rAF'} ${cap.measuredFps} fps${condStr}` +
      ` · VideoFrame ${vfText} · Worker transfer ${cap.workerTransferOk ? 'yes' : 'no'}`
    );
  }

  const sens = report.sensors;
  if (sens) {
    if (sens.gyroAvailable) {
      let sLine = `Sensors  ${sens.gyroSource} ${sens.gyroHz} Hz`;
      if (sens.atRest && (sens.atRest.n > 0 || sens.atRest.biasRecorded === false)) {
        const b = sens.atRest.biasDps;
        const holdNote = sens.atRest.movedDuringTest ? 'MOVED' : (sens.atRest.pass ? 'still' : 'high-bias');
        const attStr = sens.atRest.attempts > 1 ? `, ${sens.atRest.attempts} attempts` : '';
        if (b && sens.atRest.biasRecorded !== false) {
          sLine += ` · bias x/y/z ${b.x} ${b.y} ${b.z} dps · rms ${sens.atRest.rmsDps} (${holdNote}, ${(sens.atRest.durationMs / 1000).toFixed(1)} s${attStr})`;
        } else {
          sLine += ` · bias not recorded · rms ${sens.atRest.rmsDps} (${holdNote}, ${(sens.atRest.durationMs / 1000).toFixed(1)} s${attStr})`;
        }
      }
      lines.push(sLine);
    } else {
      lines.push('Sensors  gyro unavailable or permission denied');
    }
    if (sens.orientFrames) {
      const of = sens.orientFrames;
      const gStr = of.gravityAvailable
        ? `grav roll=${of.gravityRollDeg}deg pitch=${of.gravityPitchDeg}deg`
        : 'grav n/a';
      lines.push(
        `Orient   relScreen=${of.relScreenOk ? 'yes' : 'no'} · relDevice=${of.relDeviceOk ? 'yes' : 'no'}` +
        (of.framesDiffer !== null ? ` · differ=${of.framesDiffer ? 'yes' : 'no'}` : '') +
        ` · ${gStr}`
      );
    }
  }

  const lt = report.labelTests || {};
  const labelLines = [];
  if (lt.in8) {
    labelLines.push(
      lt.in8.skipped
        ? `8 in: skipped (${lt.in8.reason || 'not-run'})`
        : `8 in: ${lt.in8.decodeRate} decode, ${lt.in8.medianPpm ?? 'n/a'} ppm, t=${lt.in8.medianTotalMs} ms (${lt.in8.width}x${lt.in8.height})`
    );
  }
  if (lt.in30) {
    labelLines.push(
      lt.in30.skipped
        ? `30 in: skipped (${lt.in30.reason || 'not-run'})`
        : `30 in: ${lt.in30.decodeRate} decode, ${lt.in30.medianPpm ?? 'n/a'} ppm, t=${lt.in30.medianTotalMs} ms (${lt.in30.width}x${lt.in30.height})`
    );
  }
  if (labelLines.length === 0) {
    lines.push('Label    skipped (interactive 8 in / 30 in label tests not run)');
  } else {
    for (let i = 0; i < labelLines.length; i++) {
      lines.push(`${i === 0 ? 'Label    ' : '         '}${labelLines[i]}`);
    }
  }

  const rec = report.recommendation || { mode: 'unknown', blurb: '' };
  lines.push('');
  lines.push(`Recommendation: ${rec.mode}`);
  lines.push(rec.blurb);
  lines.push('');
  lines.push('--- JSON ---');
  lines.push(formatReportJson(report));

  return lines.join('\n');
}

/**
 * Copies `text` to the clipboard with a textarea selection fallback.
 * @param {string} text
 * @param {HTMLTextAreaElement | null} [textareaEl]
 */
export async function copyReport(text, textareaEl = null) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard' };
    } catch {
      // Fall through to textarea selection fallback
    }
  }
  if (textareaEl) {
    try {
      textareaEl.focus();
      textareaEl.select();
      textareaEl.setSelectionRange(0, text.length);
      const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      return { ok: Boolean(copied), method: copied ? 'execCommand' : 'selected' };
    } catch {
      return { ok: false, method: 'manual' };
    }
  }
  return { ok: false, method: 'manual' };
}

/**
 * Invokes the Web Share API when available (must be called from a user tap).
 * @param {string} text
 */
export async function shareReport(text) {
  if (!navigator.share || typeof navigator.share !== 'function') {
    return { ok: false, error: 'ShareUnavailable' };
  }
  try {
    await navigator.share({ title: 'DBC device check', text });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err && err.name ? err.name : String(err) };
  }
}
