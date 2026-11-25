export interface Point2D {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
}

export interface CornerPoints {
  tl: Point2D;
  tr: Point2D;
  br: Point2D;
  bl: Point2D;
}

export type EnhancementPresetId =
  | 'clean-color'
  | 'crisp-bw'
  | 'grayscale-crisp'
  | 'screen-deglare';

export interface EnhancementSettings {
  preset: EnhancementPresetId;
  shadowRemoval: number; // 0..100
  contrast: number; // 0..100
  sharpness: number; // 0..100
  denoise: number; // 0..100
  brightness: number; // -40..40
  fineRotationDeg: number; // -15..15
  quarterTurns: 0 | 1 | 2 | 3;
  scaleFactor: 1 | 2 | 3;
}

export const DEFAULT_CORNERS: CornerPoints = {
  tl: { x: 0.03, y: 0.03 },
  tr: { x: 0.97, y: 0.03 },
  br: { x: 0.97, y: 0.97 },
  bl: { x: 0.03, y: 0.97 },
};

export const FULL_CORNERS: CornerPoints = {
  tl: { x: 0, y: 0 },
  tr: { x: 1, y: 0 },
  br: { x: 1, y: 1 },
  bl: { x: 0, y: 1 },
};

export const PRESET_CONFIGS: Record<
  EnhancementPresetId,
  {
    label: string;
    description: string;
    defaults: Omit<EnhancementSettings, 'fineRotationDeg' | 'quarterTurns' | 'scaleFactor'>;
  }
> = {
  'clean-color': {
    label: 'Clean Color Scan',
    description: 'Removes shadows & yellow cast while keeping tables, badges & colors vivid',
    defaults: {
      preset: 'clean-color',
      shadowRemoval: 78,
      contrast: 58,
      sharpness: 55,
      denoise: 25,
      brightness: 8,
    },
  },
  'crisp-bw': {
    label: 'Crisp Document (B&W)',
    description: 'Pure white paper & razor-sharp black text like a laser PDF scan',
    defaults: {
      preset: 'crisp-bw',
      shadowRemoval: 90,
      contrast: 85,
      sharpness: 70,
      denoise: 35,
      brightness: 10,
    },
  },
  'grayscale-crisp': {
    label: 'Grayscale Clarity',
    description: 'Balanced monochrome scan preserving subtle shading & table borders',
    defaults: {
      preset: 'grayscale-crisp',
      shadowRemoval: 80,
      contrast: 68,
      sharpness: 60,
      denoise: 30,
      brightness: 6,
    },
  },
  'screen-deglare': {
    label: 'Screen Photo De-Glare',
    description: 'Tuned for camera photos of monitor/laptop screens — reduces haze & moiré',
    defaults: {
      preset: 'screen-deglare',
      shadowRemoval: 68,
      contrast: 65,
      sharpness: 62,
      denoise: 45,
      brightness: 10,
    },
  },
};

/**
 * Computes a 3x3 homography matrix mapping dst (u,v) -> src (x,y)
 * using 8x8 Gaussian elimination so perspective-warping is exact.
 */
function computeHomography(
  srcPts: [number, number][],
  dstPts: [number, number][]
): number[] {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const [sx, sy] = dstPts[i];
    const [dx, dy] = srcPts[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  // Gaussian elimination with partial pivoting
  const n = 8;
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[maxRow][col])) {
        maxRow = r;
      }
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    [b[col], b[maxRow]] = [b[maxRow], b[col]];

    const pivot = A[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const factor = A[r][col] / pivot;
      for (let c = col; c < n; c++) {
        A[r][c] -= factor * A[col][c];
      }
      b[r] -= factor * b[col];
    }
  }

  const h = new Array<number>(9).fill(1);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) {
      sum -= A[r][c] * h[c];
    }
    h[r] = sum / (A[r][r] || 1e-12);
  }
  return h;
}

/**
 * Estimates natural output dimensions from the 4 selected perspective corners.
 */
export function estimateWarpedDimensions(
  srcW: number,
  srcH: number,
  corners: CornerPoints,
  scaleFactor: 1 | 2 | 3
): { width: number; height: number } {
  const dist = (a: Point2D, b: Point2D) =>
    Math.hypot((a.x - b.x) * srcW, (a.y - b.y) * srcH);

  const topW = dist(corners.tl, corners.tr);
  const botW = dist(corners.bl, corners.br);
  const leftH = dist(corners.tl, corners.bl);
  const rightH = dist(corners.tr, corners.br);

  const rawW = Math.max(200, Math.round((topW + botW) / 2));
  const rawH = Math.max(200, Math.round((leftH + rightH) / 2));

  // Cap max output dimension at 2600px to keep browser canvas fast and crisp
  const maxDim = 2600;
  const desiredW = rawW * scaleFactor;
  const desiredH = rawH * scaleFactor;
  const clampScale = Math.min(1, maxDim / Math.max(desiredW, desiredH));

  return {
    width: Math.max(160, Math.round(desiredW * clampScale)),
    height: Math.max(160, Math.round(desiredH * clampScale)),
  };
}

/**
 * Performs 90-degree rotation + fine angle rotation + 4-corner perspective warp
 * with bilinear interpolation.
 */
export function warpCameraImage(
  sourceCanvas: HTMLCanvasElement,
  corners: CornerPoints,
  settings: EnhancementSettings
): HTMLCanvasElement {
  // First apply quarter turns + fine rotation onto an intermediate canvas
  const rotCanvas = applyRotation(
    sourceCanvas,
    settings.quarterTurns,
    settings.fineRotationDeg
  );

  const srcW = rotCanvas.width;
  const srcH = rotCanvas.height;
  const srcCtx = rotCanvas.getContext('2d')!;
  const srcImg = srcCtx.getImageData(0, 0, srcW, srcH);
  const srcData = srcImg.data;

  const { width: dstW, height: dstH } = estimateWarpedDimensions(
    srcW,
    srcH,
    corners,
    settings.scaleFactor
  );

  const outCanvas = document.createElement('canvas');
  outCanvas.width = dstW;
  outCanvas.height = dstH;
  const outCtx = outCanvas.getContext('2d')!;
  const outImg = outCtx.createImageData(dstW, dstH);
  const outData = outImg.data;

  const srcPts: [number, number][] = [
    [corners.tl.x * (srcW - 1), corners.tl.y * (srcH - 1)],
    [corners.tr.x * (srcW - 1), corners.tr.y * (srcH - 1)],
    [corners.br.x * (srcW - 1), corners.br.y * (srcH - 1)],
    [corners.bl.x * (srcW - 1), corners.bl.y * (srcH - 1)],
  ];
  const dstPts: [number, number][] = [
    [0, 0],
    [dstW - 1, 0],
    [dstW - 1, dstH - 1],
    [0, dstH - 1],
  ];

  const H = computeHomography(srcPts, dstPts);

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const denom = H[6] * x + H[7] * y + 1;
      const sx = (H[0] * x + H[1] * y + H[2]) / denom;
      const sy = (H[3] * x + H[4] * y + H[5]) / denom;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(srcW - 1, Math.max(0, x0 + 1));
      const y1 = Math.min(srcH - 1, Math.max(0, y0 + 1));
      const cx0 = Math.min(srcW - 1, Math.max(0, x0));
      const cy0 = Math.min(srcH - 1, Math.max(0, y0));

      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (cy0 * srcW + cx0) * 4;
      const i10 = (cy0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + cx0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const dstIdx = (y * dstW + x) * 4;
      outData[dstIdx] =
        srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      outData[dstIdx + 1] =
        srcData[i00 + 1] * w00 +
        srcData[i10 + 1] * w10 +
        srcData[i01 + 1] * w01 +
        srcData[i11 + 1] * w11;
      outData[dstIdx + 2] =
        srcData[i00 + 2] * w00 +
        srcData[i10 + 2] * w10 +
        srcData[i01 + 2] * w01 +
        srcData[i11 + 2] * w11;
      outData[dstIdx + 3] = 255;
    }
  }

  outCtx.putImageData(outImg, 0, 0);
  return outCanvas;
}

function applyRotation(
  source: HTMLCanvasElement,
  quarterTurns: 0 | 1 | 2 | 3,
  fineDeg: number
): HTMLCanvasElement {
  if (quarterTurns === 0 && Math.abs(fineDeg) < 0.05) {
    return source;
  }

  const swap = quarterTurns % 2 === 1;
  const w = swap ? source.height : source.width;
  const h = swap ? source.width : source.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, w, h);

  ctx.translate(w / 2, h / 2);
  ctx.rotate((quarterTurns * Math.PI) / 2 + (fineDeg * Math.PI) / 180);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

/**
 * Estimates local background illumination via fast separable sliding-window maximum
 * (morphological dilation) in O(W * H) time. Dark text strokes vanish into the surrounding
 * bright paper/screen background, capturing shadows and uneven lighting cleanly.
 */
function estimateIlluminationChannel(
  channel: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  // Horizontal max pass (sampled step=1 with monotonic deque for O(1) per pixel)
  const deque = new Int32Array(width);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let head = 0;
    let tail = 0;
    for (let x = 0; x < width + radius; x++) {
      if (x < width) {
        const val = channel[rowOff + x];
        while (tail > head && channel[rowOff + deque[tail - 1]] <= val) {
          tail--;
        }
        deque[tail++] = x;
      }
      const center = x - radius;
      if (center >= 0) {
        while (head < tail && deque[head] < center - radius) {
          head++;
        }
        temp[rowOff + center] = channel[rowOff + deque[head]];
      }
    }
  }

  // Vertical max pass
  const vDeque = new Int32Array(height);
  for (let x = 0; x < width; x++) {
    let head = 0;
    let tail = 0;
    for (let y = 0; y < height + radius; y++) {
      if (y < height) {
        const val = temp[y * width + x];
        while (tail > head && temp[vDeque[tail - 1] * width + x] <= val) {
          tail--;
        }
        vDeque[tail++] = y;
      }
      const center = y - radius;
      if (center >= 0) {
        while (head < tail && vDeque[head] < center - radius) {
          head++;
        }
        out[center * width + x] = temp[vDeque[head] * width + x];
      }
    }
  }

  // Smooth the illumination map with a quick 2-pass box blur to eliminate block edges
  return boxBlurFloat(out, width, height, Math.max(4, Math.round(radius * 0.45)));
}

function boxBlurFloat(
  src: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const tmp = new Float32Array(width * height);
  const dst = new Float32Array(width * height);
  const win = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[row + Math.min(width - 1, Math.max(0, k))];
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / win;
      const addX = Math.min(width - 1, x + radius + 1);
      const remX = Math.max(0, x - radius);
      sum += src[row + addX] - src[row + remX];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += tmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      dst[y * width + x] = sum / win;
      const addY = Math.min(height - 1, y + radius + 1);
      const remY = Math.max(0, y - radius);
      sum += tmp[addY * width + x] - tmp[remY * width + x];
    }
  }

  return dst;
}

/**
 * Enhances the warped camera document image into a crystal-clear, shadow-free,
 * faithful output image with zero AI hallucination.
 */
export function enhanceWarpedDocument(
  warpedCanvas: HTMLCanvasElement,
  settings: EnhancementSettings
): HTMLCanvasElement {
  const width = warpedCanvas.width;
  const height = warpedCanvas.height;
  const srcCtx = warpedCanvas.getContext('2d')!;
  const imgData = srcCtx.getImageData(0, 0, width, height);
  const src = imgData.data;
  const n = width * height;

  // 1. Optional gentle edge-preserving denoise (3x3 weighted smooth when denoise > 0)
  let work = new Uint8ClampedArray(src);
  if (settings.denoise > 5) {
    work = edgePreservingSmooth(work, width, height, settings.denoise / 100);
  }

  // Extract RGB float channels for illumination normalization
  const rCh = new Float32Array(n);
  const gCh = new Float32Array(n);
  const bCh = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    rCh[i] = work[p];
    gCh[i] = work[p + 1];
    bCh[i] = work[p + 2];
  }

  const shadowStrength = settings.shadowRemoval / 100;
  const radius = Math.max(12, Math.min(42, Math.round(Math.min(width, height) * 0.032)));

  let bgR: Float32Array | null = null;
  let bgG: Float32Array | null = null;
  let bgB: Float32Array | null = null;

  if (shadowStrength > 0.02) {
    bgR = estimateIlluminationChannel(rCh, width, height, radius);
    bgG = estimateIlluminationChannel(gCh, width, height, radius);
    bgB = estimateIlluminationChannel(bCh, width, height, radius);
  }

  const contrastFactor = 1 + (settings.contrast / 100) * 1.15;
  const brightOffset = settings.brightness * 1.4;
  const out = new Uint8ClampedArray(n * 4);

  // Precompute normalized luminance + local mean for adaptive Crisp B&W mode
  let lumBuf: Float32Array | null = null;
  let localLumMean: Float32Array | null = null;
  if (settings.preset === 'crisp-bw') {
    lumBuf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let r = rCh[i];
      let g = gCh[i];
      let b = bCh[i];
      if (bgR && bgG && bgB) {
        const normR = Math.min(255, (r / Math.max(40, bgR[i])) * 255);
        const normG = Math.min(255, (g / Math.max(40, bgG[i])) * 255);
        const normB = Math.min(255, (b / Math.max(40, bgB[i])) * 255);
        r = r * (1 - shadowStrength) + normR * shadowStrength;
        g = g * (1 - shadowStrength) + normG * shadowStrength;
        b = b * (1 - shadowStrength) + normB * shadowStrength;
      }
      lumBuf[i] = Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b + brightOffset));
    }
    const localRad = Math.max(10, Math.min(24, Math.round(Math.min(width, height) * 0.02)));
    localLumMean = boxBlurFloat(lumBuf, width, height, localRad);
  }

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (settings.preset === 'crisp-bw' && lumBuf && localLumMean) {
      const lum = lumBuf[i];
      const localMean = localLumMean[i];
      // Sensitivity controlled by contrast slider (higher contrast = catches lighter strokes)
      const delta = 28 - (settings.contrast / 100) * 14;
      let bw: number;
      if (localMean < 132) {
        // Dark banner / footer bar (e.g. white text on dark slate bar)
        const diff = lum - localMean;
        bw = diff > 20 ? 255 : Math.max(24, Math.min(255, 36 + diff * 2.5));
      } else {
        // Standard paper or shaded/colored table cell: ink darker than local background -> black
        const thresh = Math.min(232, localMean - delta);
        bw = Math.max(0, Math.min(255, (lum - thresh) * 7.5 + 128));
      }
      out[p] = bw;
      out[p + 1] = bw;
      out[p + 2] = bw;
      out[p + 3] = 255;
      continue;
    }

    let r = rCh[i];
    let g = gCh[i];
    let b = bCh[i];

    // Divide out uneven shadow & warm lighting cast per channel (auto white-balance paper!)
    if (bgR && bgG && bgB) {
      const normR = Math.min(255, (r / Math.max(40, bgR[i])) * 255);
      const normG = Math.min(255, (g / Math.max(40, bgG[i])) * 255);
      const normB = Math.min(255, (b / Math.max(40, bgB[i])) * 255);

      r = r * (1 - shadowStrength) + normR * shadowStrength;
      g = g * (1 - shadowStrength) + normG * shadowStrength;
      b = b * (1 - shadowStrength) + normB * shadowStrength;
    }

    r += brightOffset;
    g += brightOffset;
    b += brightOffset;

    if (settings.preset === 'grayscale-crisp') {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let v = (lum - 128) * contrastFactor + 128;
      if (v > 234) v = 255; // Snap clean paper whites to pure #FFFFFF
      v = Math.max(0, Math.min(255, v));
      out[p] = v;
      out[p + 1] = v;
      out[p + 2] = v;
      out[p + 3] = 255;
      continue;
    }

    // Clean Color Scan / Screen Photo De-Glare:
    // Preserve hue & colored cells while snapping light paper background cleanly to white
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

    // Contrast curve anchored near the paper-white boundary (192) so even faint text in
    // bright screen glare darkens into crisp ink instead of washing out to white
    const pivot = 192;
    r = (r - pivot) * contrastFactor + pivot + 4;
    g = (g - pivot) * contrastFactor + pivot + 4;
    b = (b - pivot) * contrastFactor + pivot + 4;

    // Paper-white snap only on low-saturation near-white regions (keeps colored headers & faint text intact!)
    if (sat < 0.14 && r > 240 && g > 240 && b > 240) {
      r = 255;
      g = 255;
      b = 255;
    }

    // Screen de-glare slight saturation boost for washed-out screen photos
    if (settings.preset === 'screen-deglare') {
      const mean = (r + g + b) / 3;
      const satBoost = 1.18;
      r = mean + (r - mean) * satBoost;
      g = mean + (g - mean) * satBoost;
      b = mean + (b - mean) * satBoost;
    }

    out[p] = Math.max(0, Math.min(255, r));
    out[p + 1] = Math.max(0, Math.min(255, g));
    out[p + 2] = Math.max(0, Math.min(255, b));
    out[p + 3] = 255;
  }

  // 2. Unsharp mask sharpening for crisp letters & table gridlines
  if (settings.sharpness > 5) {
    applyUnsharpMask(out, width, height, (settings.sharpness / 100) * 1.15);
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const outCtx = outCanvas.getContext('2d')!;
  outCtx.putImageData(new ImageData(out, width, height), 0, 0);
  return outCanvas;
}

function edgePreservingSmooth(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  const threshold = 24;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const cIdx = (y * width + x) * 4;
      const cr = src[cIdx];
      const cg = src[cIdx + 1];
      const cb = src[cIdx + 2];

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let wSum = 0;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nIdx = ((y + dy) * width + (x + dx)) * 4;
          const nr = src[nIdx];
          const ng = src[nIdx + 1];
          const nb = src[nIdx + 2];
          const diff = Math.abs(nr - cr) + Math.abs(ng - cg) + Math.abs(nb - cb);
          if (diff < threshold * 3) {
            sr += nr;
            sg += ng;
            sb += nb;
            wSum += 1;
          }
        }
      }

      if (wSum > 1) {
        const blend = amount * 0.65;
        out[cIdx] = cr * (1 - blend) + (sr / wSum) * blend;
        out[cIdx + 1] = cg * (1 - blend) + (sg / wSum) * blend;
        out[cIdx + 2] = cb * (1 - blend) + (sb / wSum) * blend;
      }
    }
  }
  return out;
}

function applyUnsharpMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number
) {
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = copy[idx + c];
        const neighbors =
          (copy[((y - 1) * width + x) * 4 + c] +
            copy[((y + 1) * width + x) * 4 + c] +
            copy[(y * width + x - 1) * 4 + c] +
            copy[(y * width + x + 1) * 4 + c]) *
          0.25;
        const sharp = center + (center - neighbors) * amount;
        data[idx + c] = Math.max(0, Math.min(255, sharp));
      }
    }
  }
}

/**
 * Automatic one-click Clear Document / Screen-Photo Enhancer for Tab 2 (Reports):
 * - Automatically strips screen LCD moiré & sensor grain via edge-preserving smoothing
 * - Neutralizes gray/greenish screen glare & uneven lighting into crisp pure white
 * - Keeps colored headers/cells (like steel-blue headers) clean and legible
 * - Upscales 2x (capped at 2400px) and sharpens letters & table gridlines
 */
export function autoEnhanceReportImage(sourceCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const targetScale = Math.max(sourceCanvas.width, sourceCanvas.height) < 1200 ? 2 : 1;
  const w = Math.min(2400, Math.round(sourceCanvas.width * targetScale));
  const h = Math.min(2400, Math.round(sourceCanvas.height * (w / sourceCanvas.width)));

  const scaledCanvas = document.createElement('canvas');
  scaledCanvas.width = w;
  scaledCanvas.height = h;
  const ctx = scaledCanvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, w, h);

  const presetSettings: EnhancementSettings = {
    preset: 'clean-color',
    shadowRemoval: 84,
    contrast: 56,
    sharpness: 65,
    denoise: 45,
    brightness: 2,
    fineRotationDeg: 0,
    quarterTurns: 0,
    scaleFactor: 1,
  };

  return enhanceWarpedDocument(scaledCanvas, presetSettings);
}

/**
 * Attempts a lightweight automatic document boundary detection for camera photos
 * with a contrasting desk/table margin; falls back to slight inset if full-bleed.
 */
export function autoDetectDocumentCorners(canvas: HTMLCanvasElement): CornerPoints {
  const w = 160;
  const h = Math.max(90, Math.round((canvas.height / canvas.width) * w));
  const probe = document.createElement('canvas');
  probe.width = w;
  probe.height = h;
  const ctx = probe.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;

  // Estimate border background brightness from the outer 4px rim
  let rimSum = 0;
  let rimCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 4 || x >= w - 4 || y < 4 || y >= h - 4) {
        const i = (y * w + x) * 4;
        rimSum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        rimCount++;
      }
    }
  }
  const rimMean = rimSum / Math.max(1, rimCount);

  // If the outer rim is already bright paper/screen (>185), keep near-full bounds
  if (rimMean > 185) {
    return { ...FULL_CORNERS };
  }

  // Find bounding box of bright paper region contrasting against darker desk
  const thresh = Math.min(200, rimMean + 42);
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let hitCount = 0;

  for (let y = 4; y < h - 4; y++) {
    for (let x = 4; x < w - 4; x++) {
      const i = (y * w + x) * 4;
      const lum = (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (lum > thresh) {
        hitCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (hitCount < w * h * 0.15 || maxX - minX < w * 0.3 || maxY - minY < h * 0.3) {
    return { ...DEFAULT_CORNERS };
  }

  const pad = 0.01;
  return {
    tl: { x: Math.max(0, minX / w - pad), y: Math.max(0, minY / h - pad) },
    tr: { x: Math.min(1, maxX / w + pad), y: Math.max(0, minY / h - pad) },
    br: { x: Math.min(1, maxX / w + pad), y: Math.min(1, maxY / h + pad) },
    bl: { x: Math.max(0, minX / w - pad), y: Math.min(1, maxY / h + pad) },
  };
}
