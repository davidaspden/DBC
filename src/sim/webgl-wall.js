/**
 * Zero-dependency WebGL2 / WebGL1 3D 4x4 Tote Wall & Analytical Code 128 Barcode Renderer.
 *
 * Highlights:
 *  - Exact real-world geometry: 16 totes (14 in wide x 16 in tall) on a 4x4 wall (56 x 64 in),
 *    each with a centered vertical Code 128 Set B barcode (2 in wide x 6 in tall).
 *  - Analytical sensor-integrated barcode shading from a 1D module data texture (256 x 16):
 *    box-filters across the exact screen-space pixel footprint (fwidth) for optically accurate
 *    Nyquist / MTF anti-aliasing from 6 in to 72 in with zero bitmap blur.
 *  - Exact multi-subframe temporal shutter motion blur via running-average RGBA8 blending
 *    (blendFunc CONSTANT_ALPHA = 1/(k+1)), accurately modeling translation + pan/tilt/roll blur.
 *  - GPU-packed 4-pixels-per-texel top-down Rec.601 luma FBO pass (`width/4 x height`) so
 *    `gl.readPixels` fills a recycled `Uint8Array(width * height)` directly with zero JS loop.
 */

import { encodeCode128B } from './label.js';
import {
  TOTE_WIDTH_IN,
  TOTE_HEIGHT_IN,
  BARCODE_WIDTH_IN,
  BARCODE_HEIGHT_IN,
  GRID_COLS,
  GRID_ROWS,
  WALL_WIDTH_IN,
  WALL_HEIGHT_IN,
  mat4Perspective,
  mat4CameraView,
  mat4Multiply,
} from './paths.js';

const MODULE_TEX_W = 256;
const MODULE_TEX_H = 16;

// ============================================================================
// GLSL Shaders (WebGL1-compatible ES 1.00 with OES_standard_derivatives or WebGL2)
// ============================================================================

const WALL_VERT_SRC = `
attribute vec3 aPos;
attribute vec3 aNorm;
attribute vec2 aWallXY;

uniform mat4 uMvp;
varying vec2 vWallXY;
varying vec3 vNorm;
varying vec3 vWorldPos;

void main() {
  vWallXY = aWallXY;
  vNorm = aNorm;
  vWorldPos = aPos;
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`;

function buildWallFragSrc(isWebGL2) {
  const header = isWebGL2
    ? `#version 300 es
precision highp float;
in vec2 vWallXY;
in vec3 vNorm;
in vec3 vWorldPos;
out vec4 fragColor;
#define TEX2D texture
`
    : `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 vWallXY;
varying vec3 vNorm;
varying vec3 vWorldPos;
#define fragColor gl_FragColor
#define TEX2D texture2D
`;

  return `${header}
uniform sampler2D uBarcodeTex;
uniform float uTotalModules;
uniform float uBarcodeWidthIn;
uniform float uBarcodeHeightIn;
uniform float uLabelOrientation; // 0 = ladder (horizontal bars), 1 = picket (vertical bars)
uniform float uPrintGain;
uniform float uShadowStrength;
uniform float uNoiseStrength;
uniform float uGlareStrength;
uniform float uSeed;
uniform vec3 uCamPos;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Analytical 1D sensor-pixel integration of the Code 128 module strip
float sampleBarcodeIntegrated(float cellIdx, float v01, float dvPerPx) {
  float mCenter = v01 * uTotalModules;
  float dm = clamp(dvPerPx * uTotalModules, 0.02, 6.0);
  float m0 = mCenter - 0.5 * dm;
  float m1 = mCenter + 0.5 * dm;
  float texY = (cellIdx + 0.5) / ${MODULE_TEX_H}.0;
  float halfGainShift = abs(uPrintGain - 1.0) <= 0.001 ? 0.0 : clamp(0.5 * (uPrintGain - 1.0), -0.4, 0.4);

  // Integrate exact fractional coverage across every module spanned by [m0, m1]
  float startIdx = floor(m0) - (halfGainShift > 0.0 ? 1.0 : 0.0);
  float endIdx = floor(m1) + (halfGainShift > 0.0 ? 1.0 : 0.0);
  float acc = 0.0;
  for (int step = 0; step < 10; step++) {
    float idx = startIdx + float(step);
    if (idx > endIdx) break;
    float bit = 0.0;
    if (idx >= 0.0 && idx < uTotalModules) {
      bit = TEX2D(uBarcodeTex, vec2((idx + 0.5) / ${MODULE_TEX_W}.0, texY)).r;
    }
    if (bit > 0.5) {
      float barLo = idx;
      float barHi = idx + 1.0;
      if (abs(halfGainShift) > 0.0005) {
        float prevBit = idx > 0.5 ? TEX2D(uBarcodeTex, vec2((idx - 0.5) / ${MODULE_TEX_W}.0, texY)).r : 0.0;
        float nextBit = idx + 1.0 < uTotalModules ? TEX2D(uBarcodeTex, vec2((idx + 1.5) / ${MODULE_TEX_W}.0, texY)).r : 0.0;
        if (prevBit < 0.5) barLo -= halfGainShift;
        if (nextBit < 0.5) barHi += halfGainShift;
      }
      float lo = max(m0, barLo);
      float hi = min(m1, barHi);
      acc += max(0.0, hi - lo);
    }
  }
  return clamp(acc / dm, 0.0, 1.0);
}

void main() {
  // Wall spans X in [-28, +28], Y in [-32, +32]
  float wx = vWallXY.x;
  float wy = vWallXY.y;

  // Outside the 4x4 wall: dark warehouse floor/background
  if (abs(wx) > ${WALL_WIDTH_IN * 0.5}.0 || abs(wy) > ${WALL_HEIGHT_IN * 0.5}.0) {
    fragColor = vec4(0.045, 0.055, 0.07, 1.0);
    return;
  }

  float uWall = (wx + ${WALL_WIDTH_IN * 0.5}.0) / ${TOTE_WIDTH_IN}.0;
  float vWall = (${WALL_HEIGHT_IN * 0.5}.0 - wy) / ${TOTE_HEIGHT_IN}.0;
  float col = clamp(floor(uWall), 0.0, 3.0);
  float row = clamp(floor(vWall), 0.0, 3.0);
  float cellIdx = row * 4.0 + col;

  // Local tote coordinates in inches, centered at (0, 0): lx in [-7, +7], ly in [-8, +8]
  float lx = (fract(uWall) - 0.5) * ${TOTE_WIDTH_IN}.0;
  float ly = (0.5 - fract(vWall)) * ${TOTE_HEIGHT_IN}.0;

  // Base industrial warehouse plastic tote shading (matte slate/blue-grey with molded rim & ribs)
  vec3 toteBase = vec3(0.24, 0.29, 0.36);
  // Subtle variation per tote so stacked totes look distinct
  float toteTone = 0.92 + 0.14 * hash12(vec2(col * 7.1, row * 13.7));
  toteBase *= toteTone;

  // Molded tote edge gap (0.28 in dark shadow recess) + inner bevel (0.65 in)
  float edgeX = ${TOTE_WIDTH_IN * 0.5}.0 - abs(lx);
  float edgeY = ${TOTE_HEIGHT_IN * 0.5}.0 - abs(ly);
  float edgeDist = min(edgeX, edgeY);

  vec3 N = normalize(vNorm);
  if (edgeDist < 0.22) {
    // Dark seam gap between stacked totes
    toteBase = vec3(0.05, 0.06, 0.08);
  } else if (edgeDist < 0.65) {
    // Beveled molded rim lip
    toteBase *= 0.78;
    float bx = (edgeX < edgeY) ? sign(lx) * 0.35 : 0.0;
    float by = (edgeY <= edgeX) ? sign(ly) * 0.35 : 0.0;
    N = normalize(vec3(bx, by, 1.0));
  } else {
    // Subtle molded handle recess near top of tote (y in [+5.1, +6.2], x in [-2.6, +2.6])
    if (abs(lx) < 2.6 && ly > 5.0 && ly < 6.2) {
      toteBase *= 0.65;
    }
    // Subtle vertical structural ribs on outer sides of tote face (far from barcode)
    if (abs(lx) > 3.6 && abs(lx) < 5.6 && abs(ly) < 5.5) {
      float rib = sin(abs(lx) * 9.5);
      toteBase *= (0.96 + 0.04 * rib);
    }
  }

  vec3 albedo = toteBase;
  float isLabel = 0.0;

  // Centered barcode label: uBarcodeWidthIn wide x uBarcodeHeightIn tall (default 2 x 6 in; 2 x 3.5 in FC)
  float halfBW = uBarcodeWidthIn * 0.5;
  float halfBH = uBarcodeHeightIn * 0.5;

  if (abs(lx) <= halfBW && abs(ly) <= halfBH) {
    isLabel = 1.0;
    // White thermal label stock (reflectance ~0.93)
    float paper = 0.93;
    float ink = 0.06;

    // 0.12 in crisp white side margin along the bar edges
    bool inBars = (uLabelOrientation < 0.5)
      ? (abs(lx) <= max(0.05, halfBW - 0.12))
      : (abs(ly) <= max(0.05, halfBH - 0.12));
    if (inBars) {
      float v01 = (uLabelOrientation < 0.5)
        ? ((halfBH - ly) / uBarcodeHeightIn)
        : ((lx + halfBW) / uBarcodeWidthIn);
      float dv = length(vec2(dFdx(v01), dFdy(v01)));
      float barCov = sampleBarcodeIntegrated(cellIdx, v01, dv);
      float lum = mix(paper, ink, barCov);
      albedo = vec3(lum);
    } else {
      albedo = vec3(paper);
    }
  }

  // Warehouse overhead lighting + optional diagonal shadow gradient
  vec3 lightDir = normalize(vec3(-0.18, 0.42, 0.89));
  float ndl = max(dot(N, lightDir), 0.0);
  float illum = 0.38 + 0.62 * ndl;

  // Overhead fixture falloff + uneven shadow sweep across the 4x4 wall
  float grad = 1.0 - uShadowStrength * (0.42 * (0.5 - wy / ${WALL_HEIGHT_IN}.0) + 0.25 * (0.5 + wx / ${WALL_WIDTH_IN}.0));
  illum *= clamp(grad, 0.35, 1.15);

  vec3 color = albedo * illum;

  // Optional overhead glare hotspot on matte/semi-gloss label or plastic
  if (uGlareStrength > 0.001) {
    vec3 V = normalize(uCamPos - vWorldPos);
    vec3 H = normalize(lightDir + V);
    float spec = pow(max(dot(N, H), 0.0), mix(18.0, 42.0, isLabel));
    color += vec3(spec * uGlareStrength * mix(0.28, 0.16, isLabel));
  }

  // Optional camera sensor noise
  if (uNoiseStrength > 0.001) {
    float n = (hash12(gl_FragCoord.xy + vec2(uSeed * 17.3, uSeed * 31.7)) - 0.5) * 2.0;
    color += vec3(n * uNoiseStrength);
  }

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;
}

const FULLSCREEN_VERT_SRC = `
attribute vec2 aQuad;
varying vec2 vUv;
void main() {
  vUv = aQuad * 0.5 + 0.5;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}
`;

const BLIT_FRAG_SRC = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(uTex, vUv);
}
`;

// Packs 4 horizontal top-down Rec.601 luma pixels into one RGBA8 texel (width/4 x height)
const LUMA_PACK_FRAG_SRC = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uSrcSize;
varying vec2 vUv;

float lumaAt(float xPx, float yTopDownPx) {
  float u = (xPx + 0.5) / uSrcSize.x;
  // Flip Y so FBO row 0 (read first by gl.readPixels) is top of image (v = 1)
  float v = 1.0 - (yTopDownPx + 0.5) / uSrcSize.y;
  vec3 rgb = texture2D(uTex, vec2(u, v)).rgb;
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  float px = floor(gl_FragCoord.x);
  float py = floor(gl_FragCoord.y);
  float baseX = px * 4.0;
  float l0 = lumaAt(baseX + 0.0, py);
  float l1 = lumaAt(baseX + 1.0, py);
  float l2 = lumaAt(baseX + 2.0, py);
  float l3 = lumaAt(baseX + 3.0, py);
  gl_FragColor = vec4(l0, l1, l2, l3);
}
`;

function compileShader(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`WebGL shader compile failed: ${info}`);
  }
  return sh;
}

function createProgram(gl, vertSrc, fragSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`WebGL program link failed: ${info}`);
  }
  return prog;
}

function createRenderTarget(gl, width, height, linear = true) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const filter = linear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { fbo, tex, width, height };
}

/**
 * Creates the WebGL 4x4 Tote Wall Renderer attached to `canvas`.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{ index: number, payload: string }>} cells
 */
export function createWebGLWallRenderer(canvas, cells) {
  const ctxOpts = {
    alpha: false,
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  };

  let isWebGL2 = true;
  let gl = canvas.getContext('webgl2', ctxOpts);
  if (!gl) {
    isWebGL2 = false;
    gl = canvas.getContext('webgl', ctxOpts);
    if (!gl) {
      throw new Error('WebGL is not supported in this browser.');
    }
    gl.getExtension('OES_standard_derivatives');
  }

  const barcodeTex = gl.createTexture();
  let totalModules = 0;

  function uploadCellsTexture(cellList, opts = {}) {
    const quietModules = Number.isFinite(opts.quietModules) ? opts.quietModules : 10;
    const texData = new Uint8Array(MODULE_TEX_W * MODULE_TEX_H * 4);
    for (let i = 0; i < cellList.length && i < MODULE_TEX_H; i++) {
      const enc = encodeCode128B(cellList[i].payload, quietModules);
      totalModules = enc.totalModules;
      if (enc.totalModules > MODULE_TEX_W) {
        throw new Error(`Barcode ${cellList[i].payload} has ${enc.totalModules} modules (> ${MODULE_TEX_W})`);
      }
      for (let m = 0; m < enc.totalModules; m++) {
        const v = enc.modules[m] ? 255 : 0;
        const off = (i * MODULE_TEX_W + m) * 4;
        texData[off] = v;
        texData[off + 1] = v;
        texData[off + 2] = v;
        texData[off + 3] = 255;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, barcodeTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MODULE_TEX_W, MODULE_TEX_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, texData);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  uploadCellsTexture(cells);

  // 2. Compile shader programs
  const wallVert = isWebGL2
    ? `#version 300 es
in vec3 aPos;
in vec3 aNorm;
in vec2 aWallXY;
uniform mat4 uMvp;
out vec2 vWallXY;
out vec3 vNorm;
out vec3 vWorldPos;
void main() {
  vWallXY = aWallXY;
  vNorm = aNorm;
  vWorldPos = aPos;
  gl_Position = uMvp * vec4(aPos, 1.0);
}
`
    : WALL_VERT_SRC;

  const wallProg = createProgram(gl, wallVert, buildWallFragSrc(isWebGL2));
  const blitProg = createProgram(gl, FULLSCREEN_VERT_SRC, BLIT_FRAG_SRC);
  const lumaProg = createProgram(gl, FULLSCREEN_VERT_SRC, LUMA_PACK_FRAG_SRC);

  // 3. Static geometry: wall plane (oversized surround for warehouse background) + fullscreen quad
  const bgW = WALL_WIDTH_IN * 1.8;
  const bgH = WALL_HEIGHT_IN * 1.8;
  // Interleaved: pos(3), norm(3), wallXY(2)
  const wallVerts = new Float32Array([
    -bgW, -bgH, 0,  0, 0, 1,  -bgW, -bgH,
     bgW, -bgH, 0,  0, 0, 1,   bgW, -bgH,
    -bgW,  bgH, 0,  0, 0, 1,  -bgW,  bgH,
     bgW,  bgH, 0,  0, 0, 1,   bgW,  bgH,
  ]);
  const wallVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, wallVbo);
  gl.bufferData(gl.ARRAY_BUFFER, wallVerts, gl.STATIC_DRAW);

  const quadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  // Uniform & attribute locations
  const wallLoc = {
    aPos: gl.getAttribLocation(wallProg, 'aPos'),
    aNorm: gl.getAttribLocation(wallProg, 'aNorm'),
    aWallXY: gl.getAttribLocation(wallProg, 'aWallXY'),
    uMvp: gl.getUniformLocation(wallProg, 'uMvp'),
    uBarcodeTex: gl.getUniformLocation(wallProg, 'uBarcodeTex'),
    uTotalModules: gl.getUniformLocation(wallProg, 'uTotalModules'),
    uBarcodeWidthIn: gl.getUniformLocation(wallProg, 'uBarcodeWidthIn'),
    uBarcodeHeightIn: gl.getUniformLocation(wallProg, 'uBarcodeHeightIn'),
    uLabelOrientation: gl.getUniformLocation(wallProg, 'uLabelOrientation'),
    uPrintGain: gl.getUniformLocation(wallProg, 'uPrintGain'),
    uShadowStrength: gl.getUniformLocation(wallProg, 'uShadowStrength'),
    uNoiseStrength: gl.getUniformLocation(wallProg, 'uNoiseStrength'),
    uGlareStrength: gl.getUniformLocation(wallProg, 'uGlareStrength'),
    uSeed: gl.getUniformLocation(wallProg, 'uSeed'),
    uCamPos: gl.getUniformLocation(wallProg, 'uCamPos'),
  };
  const blitLoc = {
    aQuad: gl.getAttribLocation(blitProg, 'aQuad'),
    uTex: gl.getUniformLocation(blitProg, 'uTex'),
  };
  const lumaLoc = {
    aQuad: gl.getAttribLocation(lumaProg, 'aQuad'),
    uTex: gl.getUniformLocation(lumaProg, 'uTex'),
    uSrcSize: gl.getUniformLocation(lumaProg, 'uSrcSize'),
  };

  let curW = 0;
  let curH = 0;
  let sceneRT = null;
  let lumaRT = null;

  const projMat = new Float32Array(16);
  const viewMat = new Float32Array(16);
  const mvpMat = new Float32Array(16);

  function ensureSize(width, height) {
    const w = (width & ~3) || 1280;
    const h = height | 0 || 720;
    if (w === curW && h === curH && sceneRT && lumaRT) return;

    if (sceneRT) {
      gl.deleteFramebuffer(sceneRT.fbo);
      gl.deleteTexture(sceneRT.tex);
    }
    if (lumaRT) {
      gl.deleteFramebuffer(lumaRT.fbo);
      gl.deleteTexture(lumaRT.tex);
    }
    curW = w;
    curH = h;
    canvas.width = w;
    canvas.height = h;
    sceneRT = createRenderTarget(gl, w, h, true);
    lumaRT = createRenderTarget(gl, w >> 2, h, false);
  }

  function drawWallPass(pose, hfovDeg, opts, seed) {
    const aspect = curW / curH;
    const vfovRad = 2 * Math.atan(Math.tan((hfovDeg * 0.5) * Math.PI / 180) / aspect);
    mat4Perspective(vfovRad, aspect, 0.5, 500.0, projMat);
    mat4CameraView(pose, viewMat);
    mat4Multiply(projMat, viewMat, mvpMat);

    gl.useProgram(wallProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, wallVbo);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(wallLoc.aPos);
    gl.vertexAttribPointer(wallLoc.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(wallLoc.aNorm);
    gl.vertexAttribPointer(wallLoc.aNorm, 3, gl.FLOAT, false, stride, 3 * 4);
    gl.enableVertexAttribArray(wallLoc.aWallXY);
    gl.vertexAttribPointer(wallLoc.aWallXY, 2, gl.FLOAT, false, stride, 6 * 4);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, barcodeTex);
    gl.uniform1i(wallLoc.uBarcodeTex, 0);
    gl.uniformMatrix4fv(wallLoc.uMvp, false, mvpMat);
    gl.uniform1f(wallLoc.uTotalModules, totalModules);
    gl.uniform1f(wallLoc.uBarcodeWidthIn, opts.labelWidthIn ?? BARCODE_WIDTH_IN);
    gl.uniform1f(wallLoc.uBarcodeHeightIn, opts.labelHeightIn ?? BARCODE_HEIGHT_IN);
    gl.uniform1f(wallLoc.uLabelOrientation, opts.labelOrientation === 'picket' ? 1.0 : 0.0);
    gl.uniform1f(wallLoc.uPrintGain, opts.printGain ?? 1.0);
    gl.uniform1f(wallLoc.uShadowStrength, opts.shadowStrength ?? 0.35);
    gl.uniform1f(wallLoc.uNoiseStrength, opts.noiseStrength ?? 0.015);
    gl.uniform1f(wallLoc.uGlareStrength, opts.glareStrength ?? 0.15);
    gl.uniform1f(wallLoc.uSeed, seed);
    gl.uniform3f(wallLoc.uCamPos, pose.x, pose.y, pose.z);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (wallLoc.aPos >= 0) gl.disableVertexAttribArray(wallLoc.aPos);
    if (wallLoc.aNorm >= 0) gl.disableVertexAttribArray(wallLoc.aNorm);
    if (wallLoc.aWallXY >= 0) gl.disableVertexAttribArray(wallLoc.aWallXY);
  }

  /**
   * Renders the 4x4 wall for a list of 1..N temporal sub-frame camera poses (for shutter motion blur),
   * blits the result to the visible WebGL canvas, and optionally packs top-down luma into `lumaOut`.
   *
   * @param {Array<object>} poses - 1 pose (sharp) or N poses across the shutter interval
   * @param {{
   *   width: number,
   *   height: number,
   *   hfovDeg: number,
   *   shadowStrength?: number,
   *   noiseStrength?: number,
   *   glareStrength?: number,
   *   frameSeed?: number
   * }} opts
   * @param {Uint8Array | null} [lumaOut] - Pre-allocated `width * height` luma destination
   */
  function renderFrame(poses, opts, lumaOut = null) {
    ensureSize(opts.width, opts.height);

    // Pass 1: Render 1..N temporal sub-frames into sceneRT using exact running-average blend
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneRT.fbo);
    gl.viewport(0, 0, curW, curH);
    const n = poses.length;

    if (n <= 1) {
      gl.disable(gl.BLEND);
      drawWallPass(poses[0], opts.hfovDeg, opts, opts.frameSeed || 0);
    } else {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      for (let k = 0; k < n; k++) {
        gl.blendColor(0, 0, 0, 1.0 / (k + 1));
        drawWallPass(poses[k], opts.hfovDeg, opts, (opts.frameSeed || 0) + k * 0.137);
      }
      gl.disable(gl.BLEND);
    }

    // Pass 2: Blit sceneRT to the visible canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, curW, curH);
    gl.useProgram(blitProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.enableVertexAttribArray(blitLoc.aQuad);
    gl.vertexAttribPointer(blitLoc.aQuad, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
    gl.uniform1i(blitLoc.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (blitLoc.aQuad >= 0) gl.disableVertexAttribArray(blitLoc.aQuad);

    // Pass 3 (when worker is ready for a frame): Pack 4 top-down luma px/texel & readPixels
    if (lumaOut && lumaOut.byteLength >= curW * curH) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, lumaRT.fbo);
      gl.viewport(0, 0, curW >> 2, curH);
      gl.useProgram(lumaProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
      gl.enableVertexAttribArray(lumaLoc.aQuad);
      gl.vertexAttribPointer(lumaLoc.aQuad, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
      gl.uniform1i(lumaLoc.uTex, 0);
      gl.uniform2f(lumaLoc.uSrcSize, curW, curH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (lumaLoc.aQuad >= 0) gl.disableVertexAttribArray(lumaLoc.aQuad);

      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.readPixels(0, 0, curW >> 2, curH, gl.RGBA, gl.UNSIGNED_BYTE, lumaOut);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  return {
    isWebGL2,
    get totalModules() { return totalModules; },
    setCells: uploadCellsTexture,
    renderFrame,
    getSize: () => ({ width: curW, height: curH }),
  };
}
