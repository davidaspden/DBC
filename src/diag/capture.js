/**
 * Capture path diagnostics:
 *  - Measures real requestVideoFrameCallback (or rAF) fps over up to 60 frames (~2 s)
 *  - Checks WebCodecs `new VideoFrame(videoEl)` format + `copyTo()` luma extraction
 *  - Verifies Web Worker transferable `ArrayBuffer` (64 KiB round-trip)
 */

const YUV_Y_FIRST_FORMATS = new Set(['I420', 'I420A', 'NV12', 'I422', 'I444']);

function testWorkerTransfer() {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      resolve({ ok: false, error: 'WorkerUnavailable' });
      return;
    }
    let worker = null;
    let blobUrl = null;
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: 'WorkerTransferTimeout' });
    }, 2500);

    function cleanup() {
      clearTimeout(timer);
      if (worker) {
        try { worker.terminate(); } catch {}
      }
      if (blobUrl) {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }
    }

    try {
      const code = 'self.onmessage = (e) => { const b = e.data; self.postMessage(b, [b]); };';
      blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      worker = new Worker(blobUrl);
      worker.onmessage = (ev) => {
        const back = ev.data;
        const ok = back instanceof ArrayBuffer && back.byteLength === 65536;
        cleanup();
        resolve({ ok, error: ok ? null : 'UnexpectedBuffer' });
      };
      worker.onerror = (err) => {
        cleanup();
        resolve({ ok: false, error: err && err.message ? err.message : 'WorkerError' });
      };
      const buf = new ArrayBuffer(65536);
      worker.postMessage(buf, [buf]);
    } catch (err) {
      cleanup();
      resolve({ ok: false, error: err && err.name ? err.name : String(err) });
    }
  });
}

function measureFrameRate(videoEl, maxFrames = 60, maxMs = 2400) {
  return new Promise((resolve) => {
    const hasRVFC = Boolean(videoEl && typeof videoEl.requestVideoFrameCallback === 'function');
    let count = 0;
    let firstTs = 0;
    let lastTs = 0;
    let done = false;
    let handle = 0;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (handle) {
        if (hasRVFC && typeof videoEl.cancelVideoFrameCallback === 'function') {
          try { videoEl.cancelVideoFrameCallback(handle); } catch {}
        } else {
          cancelAnimationFrame(handle);
        }
      }
      const elapsed = lastTs - firstTs;
      const fps = count > 1 && elapsed > 0 ? Math.round(((count - 1) * 10000) / elapsed) / 10 : 0;
      resolve({ rVfcSupported: hasRVFC, measuredFps: fps, frameCount: count });
    };

    const timer = setTimeout(finish, maxMs);

    const step = (now) => {
      if (done) return;
      const ts = typeof now === 'number' ? now : performance.now();
      if (count === 0) firstTs = ts;
      lastTs = ts;
      count++;
      if (count >= maxFrames) {
        finish();
        return;
      }
      if (hasRVFC) {
        handle = videoEl.requestVideoFrameCallback(step);
      } else {
        handle = requestAnimationFrame(step);
      }
    };

    if (hasRVFC) {
      handle = videoEl.requestVideoFrameCallback(step);
    } else {
      handle = requestAnimationFrame(step);
    }
  });
}

/**
 * Probes rVFC fps, WebCodecs VideoFrame copyTo, and Worker transferable ArrayBuffer
 * on the active 1080p stream currently playing in `videoEl` (PP2: also records the
 * exact measurement conditions: width, height, exposureMode, exposureTime, iso).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {MediaStreamTrack | null} [track]
 */
export async function probeCapturePath(videoEl, track = null) {
  const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
  const width = (videoEl && videoEl.videoWidth > 0 ? videoEl.videoWidth : settings.width) || 0;
  const height = (videoEl && videoEl.videoHeight > 0 ? videoEl.videoHeight : settings.height) || 0;
  const exposureMode = settings.exposureMode || 'auto';
  const exposureTime = typeof settings.exposureTime === 'number' ? Math.round(settings.exposureTime * 100) / 100 : null;
  // W3C exposureTime is in 100 us units -> ms = raw * 0.1
  const exposureTimeMs = exposureTime !== null ? Math.round(exposureTime * 10) / 100 : null;
  const iso = typeof settings.iso === 'number' ? Math.round(settings.iso) : null;
  const frameRateSetting = typeof settings.frameRate === 'number' ? Math.round(settings.frameRate * 10) / 10 : null;

  const [fpsRes, transferRes] = await Promise.all([
    videoEl && videoEl.readyState >= 2
      ? measureFrameRate(videoEl, 60, 2400)
      : Promise.resolve({ rVfcSupported: Boolean(videoEl && typeof videoEl.requestVideoFrameCallback === 'function'), measuredFps: 0, frameCount: 0 }),
    testWorkerTransfer(),
  ]);

  let videoFrameSupported = typeof VideoFrame !== 'undefined';
  let videoFrameFormat = null;
  let yuvDirectCopy = false;
  let copyToOk = false;
  let tCaptureMs = null;
  let videoFrameError = null;

  if (videoFrameSupported && videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
    let frame = null;
    try {
      const t0 = performance.now();
      frame = new VideoFrame(videoEl);
      videoFrameFormat = frame.format || 'opaque/null';
      if (frame.format) {
        const size = frame.allocationSize();
        const dst = new Uint8Array(size);
        await frame.copyTo(dst);
        copyToOk = true;
        yuvDirectCopy = YUV_Y_FIRST_FORMATS.has(frame.format);
        tCaptureMs = Math.round((performance.now() - t0) * 100) / 100;
      }
    } catch (err) {
      videoFrameError = err && err.name ? err.name : String(err);
    } finally {
      if (frame) {
        try { frame.close(); } catch {}
      }
    }
  }

  return {
    rVfcSupported: fpsRes.rVfcSupported,
    measuredFps: fpsRes.measuredFps,
    frameCount: fpsRes.frameCount,
    width,
    height,
    exposureMode,
    exposureTime,
    exposureTimeMs,
    iso,
    frameRateSetting,
    videoFrameSupported,
    videoFrameFormat,
    yuvDirectCopy,
    copyToOk,
    tCaptureMs,
    videoFrameError,
    workerTransferOk: transferRes.ok,
    workerTransferError: transferRes.error,
  };
}
