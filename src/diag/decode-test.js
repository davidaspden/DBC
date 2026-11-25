/**
 * Optional live Code 128 label test at 8 in or 30 in using the existing DBC worker
 * (`src/worker/scanner.worker.js`). Skips cleanly if the worker cannot be loaded.
 */

import { startCamera, stopCamera } from '../camera.js';
import { hashDeviceId } from './hash.js';

const YUV_Y_FIRST_FORMATS = new Set(['I420', 'I420A', 'NV12', 'I422', 'I444']);

function median(arr) {
  if (!arr.length) return 0;
  const copy = arr.slice().sort((a, b) => a - b);
  const mid = copy.length >> 1;
  return (copy.length & 1) ? copy[mid] : (copy[mid - 1] + copy[mid]) * 0.5;
}

function estimateModules(payloadLen) {
  // Code 128B: 11 * chars + 35 (start + check + stop) + 20 (quiet zones)
  const chars = payloadLen > 0 ? payloadLen : 16;
  return 11 * chars + 55;
}

/**
 * Runs a 3-second (or 90-frame) live Code 128 decode test at `distanceIn` inches.
 *
 * @param {{
 *   distanceIn: number,
 *   videoEl: HTMLVideoElement,
 *   worker?: Worker | null,
 *   deviceId?: string | null,
 *   zoom?: number | null,
 *   durationMs?: number,
 *   maxFrames?: number,
 *   onProgress?: (info: { frames: number, decodes: number, lastPayload: string | null }) => void
 * }} opts
 */
export async function runLabelTest(opts) {
  const distanceIn = opts.distanceIn || 8;
  const videoEl = opts.videoEl;
  const durationMs = opts.durationMs || 3000;
  const maxFrames = opts.maxFrames || 90;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  let ownWorker = false;
  let worker = opts.worker || null;
  if (!worker) {
    try {
      worker = new Worker(new URL('../worker/scanner.worker.js', import.meta.url), {
        type: 'module',
      });
      ownWorker = true;
    } catch (err) {
      return {
        distanceIn,
        skipped: true,
        reason: err && err.message ? err.message : 'WorkerLoadFailed',
      };
    }
  }

  let cam = null;
  try {
    cam = await startCamera(videoEl, {
      deviceId: opts.deviceId || null,
      width: 1920,
      height: 1080,
    });
    if (opts.zoom && cam.track && cam.capabilities && cam.capabilities.zoom) {
      const zCap = cam.capabilities.zoom;
      const z = Math.min(zCap.max, Math.max(zCap.min, opts.zoom));
      try {
        await cam.track.applyConstraints({ advanced: [{ zoom: z }] });
      } catch {}
    }

    const width = cam.width;
    const height = cam.height;
    const settings = typeof cam.track.getSettings === 'function' ? cam.track.getSettings() : {};
    const cameraIdHash = await hashDeviceId(settings.deviceId || opts.deviceId || '');
    const actualZoom = settings.zoom !== undefined ? Math.round(settings.zoom * 100) / 100 : 'n/a';

    worker.postMessage({ type: 'init', width, height });

    const fallbackCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const fallbackCtx = fallbackCanvas.getContext('2d', { willReadFrequently: true });
    let useWebCodecs = typeof VideoFrame !== 'undefined';

    let framesSent = 0;
    let framesProcessed = 0;
    let decodes = 0;
    let lastPayload = null;
    const totalsMs = [];
    const ppms = [];
    let workerBusy = false;

    const endAt = performance.now() + durationMs;

    await new Promise((resolve) => {
      let stopped = false;

      const finish = () => {
        if (stopped) return;
        stopped = true;
        resolve();
      };

      const onMsg = (ev) => {
        const msg = ev.data;
        if (!msg || msg.type !== 'result') return;
        workerBusy = false;
        framesProcessed++;
        totalsMs.push((msg.tCaptureMs || 0) + (msg.tTotalMs || 0));

        const det = Array.isArray(msg.detections) && msg.detections.length > 0
          ? msg.detections[0]
          : (msg.detected === 1 ? msg : null);

        if (det && det.payload) {
          decodes++;
          lastPayload = det.payload;
          const mods = estimateModules(det.payload.length);
          if (det.roiMajorLen > 0) {
            ppms.push(det.roiMajorLen / mods);
          }
        }
        if (onProgress) {
          onProgress({ frames: framesProcessed, decodes, lastPayload });
        }
        if (framesProcessed >= maxFrames || performance.now() >= endAt) {
          finish();
        }
      };

      const onErr = () => {
        workerBusy = false;
        finish();
      };

      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);

      const pump = async () => {
        if (stopped) return;
        if (performance.now() >= endAt || framesSent >= maxFrames) {
          if (!workerBusy) finish();
          else setTimeout(finish, 300);
          return;
        }

        if (!workerBusy && videoEl.readyState >= 2) {
          workerBusy = true;
          const t0 = performance.now();
          let luma = null;
          if (useWebCodecs) {
            let vf = null;
            try {
              vf = new VideoFrame(videoEl);
              if (!vf.format || !YUV_Y_FIRST_FORMATS.has(vf.format)) {
                useWebCodecs = false;
              } else {
                const buf = new Uint8Array(vf.allocationSize());
                const layouts = await vf.copyTo(buf);
                const stride = layouts[0].stride;
                const off = layouts[0].offset;
                luma = new Uint8Array(width * height);
                if (stride === width && off === 0) {
                  luma.set(buf.subarray(0, width * height));
                } else {
                  for (let y = 0; y < height; y++) {
                    luma.set(buf.subarray(off + y * stride, off + y * stride + width), y * width);
                  }
                }
              }
            } catch {
              useWebCodecs = false;
            } finally {
              if (vf) vf.close();
            }
          }
          if (!luma) {
            fallbackCtx.drawImage(videoEl, 0, 0, width, height);
            const rgba = fallbackCtx.getImageData(0, 0, width, height).data;
            luma = new Uint8Array(width * height);
            for (let i = 0, j = 0; i < luma.length; i++, j += 4) {
              luma[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
            }
          }
          const tCaptureMs = performance.now() - t0;
          framesSent++;
          worker.postMessage(
            {
              type: 'frame',
              frameId: framesSent,
              width,
              height,
              byteOffset: 0,
              tCaptureMs,
              multi: false,
              debug: false,
              buffer: luma.buffer,
            },
            [luma.buffer]
          );
        }

        if (!stopped) requestAnimationFrame(pump);
      };

      requestAnimationFrame(pump);
      setTimeout(() => {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        finish();
      }, durationMs + 500);
    });

    const decodeRate = framesProcessed > 0 ? Math.round((decodes / framesProcessed) * 100) / 100 : 0;
    const medianTotalMs = Math.round(median(totalsMs) * 10) / 10;
    const medianPpm = ppms.length > 0 ? Math.round(median(ppms) * 10) / 10 : null;

    return {
      distanceIn,
      skipped: false,
      cameraIdHash,
      zoom: actualZoom,
      width,
      height,
      frames: framesProcessed,
      decodes,
      decodeRate,
      medianTotalMs,
      medianPpm,
      samplePayload: lastPayload,
    };
  } catch (err) {
    return {
      distanceIn,
      skipped: true,
      reason: err && err.message ? err.message : String(err),
    };
  } finally {
    if (cam) stopCamera(cam.stream);
    if (videoEl) videoEl.srcObject = null;
    if (ownWorker && worker) worker.terminate();
  }
}
