/**
 * Headless Sub-100ms Code 128 Scanner (Drop-in ZXing Replacement for Code 128).
 *
 * Zero external runtime dependencies. Pure ES Module compatible with native browsers,
 * Vite, Webpack 5, and GitHub Pages.
 *
 * Copy `src/scanner.js`, `src/camera.js`, and `src/worker/` into any web app:
 *
 *   import { Code128Scanner } from './src/scanner.js';
 *
 *   const scanner = new Code128Scanner({
 *     video: document.querySelector('video'),
 *     resolution: '720p',   // '720p' | '1080p'
 *     multi: true,          // decode all visible Code 128s per frame
 *     onDetect(detections, telemetry) {
 *       for (const d of detections) console.log(d.payload, d.payloadHex);
 *     },
 *   });
 *   await scanner.start();
 */

import { startCamera, setTorch, stopCamera, listVideoDevices } from './camera.js';

const YUV_Y_FIRST_FORMATS = new Set(['I420', 'I420A', 'NV12', 'I422', 'I444']);
const RGB_PACKED_FORMATS = new Set(['RGBA', 'RGBX', 'BGRA', 'BGRX']);

export class Code128Scanner {
  /**
   * @param {object} options
   * @param {HTMLVideoElement} [options.video]   Video element for live camera scanning
   * @param {'720p'|'1080p'} [options.resolution='720p']
   * @param {boolean} [options.multi=true]       Multi-barcode per-frame sweep mode
   * @param {string|null} [options.deviceId=null] Optional specific camera deviceId
   * @param {boolean} [options.debug=false]      Attach Stage 1-3 intermediate snapshots
   * @param {(detections: Array<object>, telemetry: object) => void} [options.onDetect]
   * @param {(telemetry: object) => void} [options.onFrame]
   * @param {(err: Error) => void} [options.onError]
   */
  constructor(options = {}) {
    this.video = options.video || null;
    this.resolution = options.resolution === '1080p' ? '1080p' : '720p';
    this.multi = options.multi !== false;
    this.deviceId = options.deviceId || null;
    this.debug = Boolean(options.debug);
    this.onDetect = typeof options.onDetect === 'function' ? options.onDetect : null;
    this.onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;

    this._running = false;
    this._camera = null;
    this._devices = [];
    this._activeDeviceIdx = -1;
    this._torchOn = false;

    this._worker = null;
    this._workerBusy = false;
    this._frameId = 0;
    this._rafHandle = 0;
    this._vfcHandle = 0;

    this._frameWidth = this.resolution === '1080p' ? 1920 : 1280;
    this._frameHeight = this.resolution === '1080p' ? 1080 : 720;

    // Pre-allocated recycled buffers (zero per-frame heap churn)
    this._lumaBuffer = null;
    this._webcodecsBuf = null;
    this._webcodecsBufSize = 0;
    this._useWebCodecs = typeof VideoFrame !== 'undefined';
    this._lastTransferredWasWebCodecs = false;
    this._capturePath = 'init';

    this._fallbackCanvas = null;
    this._fallbackCtx = null;

    this._fpsWindowStart = 0;
    this._fpsFrames = 0;
    this._fps = 0;

    // Optional one-shot resolver for `scanImage()`
    this._pendingStaticResolve = null;

    this._boundOnWorkerMessage = (ev) => this._handleWorkerMessage(ev);
    this._boundOnWorkerError = (err) => {
      this._workerBusy = false;
      if (this.onError) this.onError(err instanceof Error ? err : new Error(err.message || 'Worker error'));
    };
    this._boundPump = () => this._pumpVideoFrame();
  }

  get isRunning() { return this._running; }
  get hasTorch() { return Boolean(this._camera && this._camera.hasTorch); }
  get torchOn() { return this._torchOn; }
  get devices() { return this._devices; }
  get activeResolution() { return { width: this._frameWidth, height: this._frameHeight }; }
  get focusMode() { return this._camera ? this._camera.focusMode : 'inactive'; }
  get capturePath() { return this._capturePath; }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('./worker/scanner.worker.js', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = this._boundOnWorkerMessage;
    worker.onerror = this._boundOnWorkerError;
    this._worker = worker;
    return worker;
  }

  _ensureLumaBuffer(width, height) {
    const needed = Math.imul(width, height);
    if (!this._lumaBuffer || this._lumaBuffer.byteLength !== needed) {
      this._lumaBuffer = new Uint8Array(needed);
    }
  }

  _ensureFallbackCanvas(width, height) {
    if (!this._fallbackCanvas || this._fallbackCanvas.width !== width || this._fallbackCanvas.height !== height) {
      if (typeof OffscreenCanvas !== 'undefined') {
        this._fallbackCanvas = new OffscreenCanvas(width, height);
      } else {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        this._fallbackCanvas = c;
      }
      this._fallbackCtx = this._fallbackCanvas.getContext('2d', { willReadFrequently: true });
    }
  }

  /**
   * Starts live camera capture & Web Worker scanning.
   * @param {{ deviceId?: string | null, resolution?: '720p' | '1080p' }} [override]
   */
  async start(override = {}) {
    if (!this.video) {
      throw new Error('Code128Scanner.start() requires a `video` HTMLVideoElement option.');
    }
    if (this._running) this.stop();

    if (override.resolution) {
      this.resolution = override.resolution === '1080p' ? '1080p' : '720p';
    }
    if (override.deviceId !== undefined) {
      this.deviceId = override.deviceId;
    }

    const reqW = this.resolution === '1080p' ? 1920 : 1280;
    const reqH = this.resolution === '1080p' ? 1080 : 720;

    this._useWebCodecs = typeof VideoFrame !== 'undefined';
    const cam = await startCamera(this.video, {
      deviceId: this.deviceId,
      width: reqW,
      height: reqH,
    });

    this._camera = cam;
    this._frameWidth = cam.width;
    this._frameHeight = cam.height;
    this._torchOn = false;

    this._devices = await listVideoDevices();
    const curId = cam.settings && cam.settings.deviceId;
    this._activeDeviceIdx = Math.max(0, this._devices.findIndex((d) => d.deviceId === curId));

    const worker = this._ensureWorker();
    worker.postMessage({ type: 'init', width: cam.width, height: cam.height });

    this._fpsWindowStart = 0;
    this._fpsFrames = 0;
    this._fps = 0;
    this._workerBusy = false;
    this._running = true;

    this._scheduleNextFrame();

    return {
      width: cam.width,
      height: cam.height,
      focusMode: cam.focusMode,
      hasTorch: cam.hasTorch,
      devices: this._devices,
      activeDeviceId: curId || null,
    };
  }

  /**
   * Stops live camera capture and frame loop (keeps worker warm for fast restart).
   */
  stop() {
    this._running = false;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    if (this._vfcHandle && this.video && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._vfcHandle);
    }
    this._rafHandle = 0;
    this._vfcHandle = 0;

    if (this._camera) {
      stopCamera(this._camera.stream);
      this._camera = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this._torchOn = false;
  }

  /**
   * Stops camera and terminates the dedicated Web Worker cleanly.
   */
  destroy() {
    this.stop();
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
    this._lumaBuffer = null;
    this._webcodecsBuf = null;
    this._fallbackCanvas = null;
    this._fallbackCtx = null;
  }

  async setTorch(enabled) {
    if (!this._camera || !this._camera.hasTorch) return false;
    const ok = await setTorch(this._camera.track, Boolean(enabled));
    if (ok) this._torchOn = Boolean(enabled);
    return ok;
  }

  async setResolution(preset) {
    const next = preset === '1080p' ? '1080p' : '720p';
    this.resolution = next;
    if (this._running) {
      const curId = this._camera && this._camera.settings ? this._camera.settings.deviceId : this.deviceId;
      return this.start({ deviceId: curId, resolution: next });
    }
    return null;
  }

  async switchCamera() {
    if (this._devices.length < 2) return null;
    const nextIdx = (this._activeDeviceIdx + 1) % this._devices.length;
    const nextId = this._devices[nextIdx].deviceId;
    return this.start({ deviceId: nextId });
  }

  /**
   * Decodes a static HTMLImageElement, HTMLCanvasElement, or ImageBitmap asynchronously.
   * @param {HTMLImageElement | HTMLCanvasElement | ImageBitmap} source
   * @returns {Promise<{ detections: Array<object>, telemetry: object }>}
   */
  scanImage(source) {
    const width = (source.naturalWidth || source.width) | 0;
    const height = (source.naturalHeight || source.height) | 0;
    const t0 = performance.now();

    this._ensureFallbackCanvas(width, height);
    this._fallbackCtx.drawImage(source, 0, 0, width, height);
    const rgba = this._fallbackCtx.getImageData(0, 0, width, height).data;
    const count = Math.imul(width, height);
    const luma = new Uint8Array(count);
    for (let i = 0, j = 0; i < count; i++, j = (j + 4) | 0) {
      luma[i] = (Math.imul(77, rgba[j]) + Math.imul(150, rgba[j + 1]) + Math.imul(29, rgba[j + 2])) >> 8;
    }
    const tCaptureMs = performance.now() - t0;

    this._frameWidth = width;
    this._frameHeight = height;
    this._capturePath = 'StaticImage';

    const worker = this._ensureWorker();
    worker.postMessage({ type: 'init', width, height });

    return new Promise((resolve) => {
      this._pendingStaticResolve = resolve;
      this._lastTransferredWasWebCodecs = false;
      this._workerBusy = true;
      worker.postMessage(
        {
          type: 'frame',
          frameId: ++this._frameId,
          width,
          height,
          byteOffset: 0,
          tCaptureMs,
          multi: this.multi,
          debug: this.debug,
          buffer: luma.buffer,
        },
        [luma.buffer]
      );
    });
  }

  _scheduleNextFrame() {
    if (!this._running || !this.video) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this._vfcHandle = this.video.requestVideoFrameCallback(this._boundPump);
    } else {
      this._rafHandle = requestAnimationFrame(this._boundPump);
    }
  }

  async _pumpVideoFrame() {
    if (!this._running) return;

    // Schedule the next camera tick immediately (BEFORE awaiting VideoFrame.copyTo)
    // so tightly-spaced hardware camera ticks are never missed.
    this._scheduleNextFrame();

    if (this._workerBusy || !this.video || this.video.readyState < 2) {
      return;
    }

    this._workerBusy = true;
    try {
      const cap = await this._extractLumaFrame(this.video);
      if (!this._running) {
        // Recycle buffer if stopped mid-capture
        if (cap.isWebCodecsScratch) {
          this._webcodecsBuf = new Uint8Array(cap.buffer);
          this._webcodecsBufSize = cap.buffer.byteLength;
        } else {
          this._lumaBuffer = new Uint8Array(cap.buffer);
        }
        this._workerBusy = false;
        return;
      }

      this._lastTransferredWasWebCodecs = cap.isWebCodecsScratch;
      this._worker.postMessage(
        {
          type: 'frame',
          frameId: ++this._frameId,
          width: cap.width,
          height: cap.height,
          byteOffset: cap.byteOffset,
          tCaptureMs: cap.tCaptureMs,
          multi: this.multi,
          debug: this.debug,
          buffer: cap.buffer,
        },
        [cap.buffer]
      );
    } catch (err) {
      this._workerBusy = false;
      if (this.onError) this.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async _extractLumaFrame(videoEl) {
    const t0 = performance.now();
    let width = (videoEl.videoWidth | 0) || this._frameWidth;
    let height = (videoEl.videoHeight | 0) || this._frameHeight;

    if (this._useWebCodecs) {
      let frame = null;
      try {
        frame = new VideoFrame(videoEl);
        const format = frame.format;

        if (!format || (!YUV_Y_FIRST_FORMATS.has(format) && !RGB_PACKED_FORMATS.has(format))) {
          this._useWebCodecs = false;
        } else {
          const vis = frame.visibleRect;
          const visX = vis ? (vis.x | 0) : 0;
          const visY = vis ? (vis.y | 0) : 0;
          width = vis ? (vis.width | 0) : (frame.codedWidth | 0);
          height = vis ? (vis.height | 0) : (frame.codedHeight | 0);
          this._frameWidth = width;
          this._frameHeight = height;

          const allocSize = frame.allocationSize();
          if (!this._webcodecsBuf || this._webcodecsBufSize < allocSize) {
            this._webcodecsBuf = new Uint8Array(allocSize);
            this._webcodecsBufSize = allocSize;
          }

          const layouts = await frame.copyTo(this._webcodecsBuf);
          const yLayout = layouts && layouts[0];

          if (YUV_Y_FIRST_FORMATS.has(format) && yLayout) {
            this._capturePath = `WebCodecs (${format})`;
            const stride = yLayout.stride | 0;
            const yOffset = (yLayout.offset + Math.imul(visY, stride) + visX) | 0;

            if (stride === width && yOffset === 0 && Math.imul(width, height) <= this._webcodecsBuf.byteLength) {
              const buf = this._webcodecsBuf.buffer;
              this._webcodecsBuf = null;
              this._webcodecsBufSize = 0;
              return {
                buffer: buf,
                byteOffset: 0,
                width,
                height,
                tCaptureMs: performance.now() - t0,
                isWebCodecsScratch: true,
              };
            }

            this._ensureLumaBuffer(width, height);
            const src = this._webcodecsBuf;
            const dst = this._lumaBuffer;
            for (let y = 0; y < height; y++) {
              const sRow = (yOffset + Math.imul(y, stride)) | 0;
              const dRow = Math.imul(y, width);
              dst.set(src.subarray(sRow, sRow + width), dRow);
            }
            const buf = dst.buffer;
            this._lumaBuffer = null;
            return {
              buffer: buf,
              byteOffset: 0,
              width,
              height,
              tCaptureMs: performance.now() - t0,
              isWebCodecsScratch: false,
            };
          }

          if (RGB_PACKED_FORMATS.has(format)) {
            this._capturePath = `WebCodecs (${format})`;
            this._ensureLumaBuffer(width, height);
            const src = this._webcodecsBuf;
            const dst = this._lumaBuffer;
            const stride = (yLayout && yLayout.stride) ? (yLayout.stride | 0) : (width << 2);
            const baseOff = ((yLayout ? yLayout.offset : 0) + Math.imul(visY, stride) + (visX << 2)) | 0;
            const isBgr = format === 'BGRA' || format === 'BGRX';
            const rOff = isBgr ? 2 : 0;
            const bOff = isBgr ? 0 : 2;

            let dIdx = 0;
            for (let y = 0; y < height; y++) {
              let sIdx = (baseOff + Math.imul(y, stride)) | 0;
              for (let x = 0; x < width; x++) {
                const r = src[(sIdx + rOff) | 0];
                const g = src[(sIdx + 1) | 0];
                const b = src[(sIdx + bOff) | 0];
                dst[dIdx++] = (Math.imul(77, r) + Math.imul(150, g) + Math.imul(29, b)) >> 8;
                sIdx = (sIdx + 4) | 0;
              }
            }
            const buf = dst.buffer;
            this._lumaBuffer = null;
            return {
              buffer: buf,
              byteOffset: 0,
              width,
              height,
              tCaptureMs: performance.now() - t0,
              isWebCodecsScratch: false,
            };
          }
        }
      } catch {
        this._useWebCodecs = false;
      } finally {
        if (frame) frame.close();
      }
    }

    // Fallback: OffscreenCanvas / 2D Canvas getImageData()
    this._frameWidth = width;
    this._frameHeight = height;
    this._capturePath = typeof OffscreenCanvas !== 'undefined' ? 'OffscreenCanvas' : 'Canvas2D';
    this._ensureFallbackCanvas(width, height);
    this._ensureLumaBuffer(width, height);
    this._fallbackCtx.drawImage(videoEl, 0, 0, width, height);
    const rgba = this._fallbackCtx.getImageData(0, 0, width, height).data;
    const dst = this._lumaBuffer;
    const count = Math.imul(width, height);
    for (let i = 0, j = 0; i < count; i++, j = (j + 4) | 0) {
      dst[i] = (Math.imul(77, rgba[j]) + Math.imul(150, rgba[j + 1]) + Math.imul(29, rgba[j + 2])) >> 8;
    }
    const buf = dst.buffer;
    this._lumaBuffer = null;
    return {
      buffer: buf,
      byteOffset: 0,
      width,
      height,
      tCaptureMs: performance.now() - t0,
      isWebCodecsScratch: false,
    };
  }

  _handleWorkerMessage(event) {
    const msg = event.data;
    if (!msg || msg.type !== 'result') return;

    this._workerBusy = false;

    if (msg.buffer) {
      const returnedView = new Uint8Array(msg.buffer);
      if (this._lastTransferredWasWebCodecs) {
        this._webcodecsBuf = returnedView;
        this._webcodecsBufSize = returnedView.byteLength;
      } else {
        this._lumaBuffer = returnedView;
      }
    }

    const now = performance.now();
    this._fpsFrames++;
    if (this._fpsWindowStart === 0) {
      this._fpsWindowStart = now;
    } else if (now - this._fpsWindowStart >= 500) {
      this._fps = (this._fpsFrames * 1000) / (now - this._fpsWindowStart);
      this._fpsFrames = 0;
      this._fpsWindowStart = now;
    }

    const detections = Array.isArray(msg.detections) && msg.detections.length > 0
      ? msg.detections
      : (msg.detected === 1 && msg.payload ? [{
        payload: msg.payload,
        payloadHex: msg.payloadHex,
        symbolsHex: msg.symbolsHex,
        symbology: 'CODE_128',
        roiX: msg.roiX,
        roiY: msg.roiY,
        roiW: msg.roiW,
        roiH: msg.roiH,
        roiCenterX: msg.roiCenterX,
        roiCenterY: msg.roiCenterY,
        roiMajorLen: msg.roiMajorLen,
        thetaDeg: msg.thetaDeg,
        roiConfidence: msg.roiConfidence,
        consensusCount: msg.consensusCount,
      }] : []);

    const telemetry = {
      frameId: msg.frameId,
      width: this._frameWidth,
      height: this._frameHeight,
      fps: this._fps,
      capturePath: this._capturePath,
      focusMode: this.focusMode,
      tCaptureMs: msg.tCaptureMs || 0,
      tRoiMs: msg.tRoiMs || 0,
      tDecodeMs: msg.tDecodeMs || 0,
      tTotalMs: (msg.tCaptureMs || 0) + (msg.tTotalMs || 0),
      tWorkerMs: msg.tTotalMs || 0,
      roiConfidence: msg.roiConfidence || 0,
      thetaDeg: msg.thetaDeg || 0,
      detections,
      debug: msg.debug || null,
    };

    if (this._pendingStaticResolve) {
      const resolve = this._pendingStaticResolve;
      this._pendingStaticResolve = null;
      resolve({ detections, telemetry });
    }

    if (this.onFrame) this.onFrame(telemetry);
    if (detections.length > 0 && this.onDetect) this.onDetect(detections, telemetry);
  }
}
