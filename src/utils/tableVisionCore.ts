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

export interface CellInkAnalysis {
  isEmpty: boolean;
  inkCount: number;
  inkRatio: number;
  contrastSnr: number;
  patchLum: Float32Array;
  patchW: number;
  patchH: number;
}

export interface ExtractedCell {
  value: string;
  confidence: number;
  uncertain: boolean;
  reasons: string[];
  isIdColumn: boolean;
  sourceBox?: { x0: number; y0: number; x1: number; y1: number };
  sourceCropDataUrl?: string;
  verifiedByUser?: boolean;
}

export interface TableIntegrityReport {
  averageConfidence: number;
  uncertainCount: number;
  rowIntegrityWarnings: string[];
}

/**
 * Converts RGBA byte array to perceptual luminance Float32Array.
 */
export function rgbaToLuminance(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Float32Array {
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return lum;
}

/**
 * Computes a 3x3 homography matrix mapping dstPts -> srcPts via 8x8 Gaussian elimination.
 */
export function solveHomography(
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
 * Warps an RGBA buffer using 4 normalized corners into a flat top-down rectangle
 * with bilinear interpolation.
 */
export function warpRgbaPerspective(
  srcData: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  corners: CornerPoints,
  dstW: number,
  dstH: number
): Uint8ClampedArray {
  const outData = new Uint8ClampedArray(dstW * dstH * 4);
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

  const H = solveHomography(srcPts, dstPts);

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

      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
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
  return outData;
}

/**
 * Estimates dominant horizontal gridline / text-baseline skew angle (degrees in [-10, +10])
 * by maximizing horizontal edge-projection variance across candidate rotation angles.
 */
export function estimateSkewAngleDeg(
  lum: Float32Array,
  width: number,
  height: number
): number {
  // Downsample to ~280px wide for sub-15ms evaluation
  const maxW = 280;
  const scale = Math.min(1, maxW / width);
  const sw = Math.max(40, Math.round(width * scale));
  const sh = Math.max(40, Math.round(height * scale));
  const small = new Float32Array(sw * sh);

  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.round(y / scale));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.round(x / scale));
      small[y * sw + x] = lum[sy * width + sx];
    }
  }

  // Compute horizontal Sobel-like vertical edge energy (highlights horizontal gridlines & text rows)
  const edges = new Float32Array(sw * sh);
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const dy = Math.abs(small[(y - 1) * sw + x] - small[(y + 1) * sw + x]);
      edges[y * sw + x] = dy > 10 ? dy : 0;
    }
  }

  const scoreAngle = (deg: number): number => {
    const rad = (deg * Math.PI) / 180;
    const tan = Math.tan(rad);
    const proj = new Float32Array(sh);
    const counts = new Int32Array(sh);
    const midX = sw / 2;

    for (let y = 2; y < sh - 2; y++) {
      for (let x = 4; x < sw - 4; x++) {
        const yRot = Math.round(y + (x - midX) * tan);
        if (yRot >= 0 && yRot < sh) {
          proj[yRot] += edges[y * sw + x];
          counts[yRot]++;
        }
      }
    }

    let sumSq = 0;
    for (let y = 0; y < sh; y++) {
      if (counts[y] > sw * 0.35) {
        const mean = proj[y] / counts[y];
        sumSq += mean * mean;
      }
    }
    return sumSq;
  };

  let bestDeg = 0;
  let bestScore = -1;
  for (let deg = -8; deg <= 8; deg += 0.5) {
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = deg;
    }
  }

  // Fine 0.125-deg refinement around coarse peak
  const startFine = bestDeg - 0.5;
  const endFine = bestDeg + 0.5;
  for (let deg = startFine; deg <= endFine; deg += 0.125) {
    const sc = scoreAngle(deg);
    if (sc > bestScore) {
      bestScore = sc;
      bestDeg = deg;
    }
  }

  return Math.abs(bestDeg) < 0.25 ? 0 : Math.round(bestDeg * 100) / 100;
}

/**
 * Rotates an RGBA image by `angleDeg` around its center with bilinear interpolation.
 */
export function rotateRgbaBilinear(
  srcData: Uint8ClampedArray,
  width: number,
  height: number,
  angleDeg: number
): Uint8ClampedArray {
  if (Math.abs(angleDeg) < 0.15) {
    return new Uint8ClampedArray(srcData);
  }
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = dx * cos - dy * sin + cx;
      const sy = dx * sin + dy * cos + cy;

      const dstIdx = (y * width + x) * 4;
      if (sx < 0 || sx >= width - 1 || sy < 0 || sy >= height - 1) {
        out[dstIdx] = 255;
        out[dstIdx + 1] = 255;
        out[dstIdx + 2] = 255;
        out[dstIdx + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + (x0 + 1)) * 4;
      const i01 = ((y0 + 1) * width + x0) * 4;
      const i11 = ((y0 + 1) * width + (x0 + 1)) * 4;

      out[dstIdx] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
      out[dstIdx + 1] =
        srcData[i00 + 1] * w00 +
        srcData[i10 + 1] * w10 +
        srcData[i01 + 1] * w01 +
        srcData[i11 + 1] * w11;
      out[dstIdx + 2] =
        srcData[i00 + 2] * w00 +
        srcData[i10 + 2] * w10 +
        srcData[i01 + 2] * w01 +
        srcData[i11 + 2] * w11;
      out[dstIdx + 3] = 255;
    }
  }
  return out;
}

/**
 * Edge-preserving directional de-moiré filter: suppresses periodic LCD subpixel stripes
 * in low-gradient regions while preserving crisp character stroke edges.
 */
export function deMoireDirectional(
  lum: Float32Array,
  width: number,
  height: number
): Float32Array {
  const out = new Float32Array(lum.length);
  for (let y = 0; y < height; y++) {
    const yPrev = Math.max(0, y - 1);
    const yNext = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const xPrev = Math.max(0, x - 1);
      const xNext = Math.min(width - 1, x + 1);
      const c = lum[idx];
      const hDiff = Math.abs(lum[y * width + xPrev] - lum[y * width + xNext]);
      const vDiff = Math.abs(lum[yPrev * width + x] - lum[yNext * width + x]);

      // Apply light bilateral smoothing only where local contrast isn't a sharp glyph stroke
      if (hDiff < 38 && vDiff < 38) {
        out[idx] =
          (lum[yPrev * width + x] +
            2 * lum[y * width + xPrev] +
            4 * c +
            2 * lum[y * width + xNext] +
            lum[yNext * width + x]) /
          10;
      } else {
        out[idx] = c;
      }
    }
  }
  return out;
}

/**
 * Separable local-max illumination map + glare-preserving contrast normalization.
 */
export function normalizeIlluminationAndGlare(
  lum: Float32Array,
  width: number,
  height: number
): Float32Array {
  const radius = Math.max(12, Math.min(34, Math.round(Math.min(width, height) * 0.025)));
  const bg = estimateLocalMaxBlur(lum, width, height, radius);
  const out = new Float32Array(lum.length);

  for (let i = 0; i < lum.length; i++) {
    const norm = Math.min(255, (lum[i] / Math.max(45, bg[i])) * 255);
    let val = (norm - 196) * 1.55 + 200;
    if (val > 238) val = 255;
    out[i] = Math.max(0, Math.min(255, val));
  }
  return out;
}

/**
 * Removes uneven illumination/vignetting without clipping subtle gray Excel gridlines to white.
 */
export function normalizeForGridDetection(
  lum: Float32Array,
  width: number,
  height: number
): Float32Array {
  const radius = Math.max(14, Math.min(36, Math.round(Math.min(width, height) * 0.03)));
  const bg = estimateLocalMaxBlur(lum, width, height, radius);
  const out = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) {
    out[i] = Math.max(0, Math.min(255, (lum[i] / Math.max(45, bg[i])) * 245));
  }
  return out;
}

function estimateLocalMaxBlur(
  channel: Float32Array,
  width: number,
  height: number,
  radius: number
): Float32Array {
  const temp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const deque = new Int32Array(width);

  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    let head = 0;
    let tail = 0;
    for (let x = 0; x < width + radius; x++) {
      if (x < width) {
        const val = channel[rowOff + x];
        while (tail > head && channel[rowOff + deque[tail - 1]] <= val) tail--;
        deque[tail++] = x;
      }
      const center = x - radius;
      if (center >= 0) {
        while (head < tail && deque[head] < center - radius) head++;
        temp[rowOff + center] = channel[rowOff + deque[head]];
      }
    }
  }

  const vDeque = new Int32Array(height);
  for (let x = 0; x < width; x++) {
    let head = 0;
    let tail = 0;
    for (let y = 0; y < height + radius; y++) {
      if (y < height) {
        const val = temp[y * width + x];
        while (tail > head && temp[vDeque[tail - 1] * width + x] <= val) tail--;
        vDeque[tail++] = y;
      }
      const center = y - radius;
      if (center >= 0) {
        while (head < tail && vDeque[head] < center - radius) head++;
        out[center * width + x] = temp[vDeque[head] * width + x];
      }
    }
  }

  const blurR = Math.max(4, Math.round(radius * 0.4));
  const win = blurR * 2 + 1;
  const bTmp = new Float32Array(width * height);
  const bDst = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let k = -blurR; k <= blurR; k++) sum += out[row + Math.min(width - 1, Math.max(0, k))];
    for (let x = 0; x < width; x++) {
      bTmp[row + x] = sum / win;
      sum += out[row + Math.min(width - 1, x + blurR + 1)] - out[row + Math.max(0, x - blurR)];
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -blurR; k <= blurR; k++) sum += bTmp[Math.min(height - 1, Math.max(0, k)) * width + x];
    for (let y = 0; y < height; y++) {
      bDst[y * width + x] = sum / win;
      sum += bTmp[Math.min(height - 1, y + blurR + 1) * width + x] - bTmp[Math.max(0, y - blurR) * width + x];
    }
  }
  return bDst;
}

/**
 * Fast O(W*H) integral-image Sauvola adaptive thresholding for clean dark-on-light
 * text separation across shaded headers, bright glare spots, and uneven screen luminance.
 */
export function sauvolaAdaptiveThreshold(
  lum: Float32Array,
  width: number,
  height: number,
  radius = 12,
  k = 0.2
): Uint8ClampedArray {
  const n = width * height;
  const intSum = new Float64Array((width + 1) * (height + 1));
  const intSqSum = new Float64Array((width + 1) * (height + 1));
  const stride = width + 1;

  for (let y = 1; y <= height; y++) {
    let rowSum = 0;
    let rowSq = 0;
    for (let x = 1; x <= width; x++) {
      const v = lum[(y - 1) * width + (x - 1)];
      rowSum += v;
      rowSq += v * v;
      intSum[y * stride + x] = intSum[(y - 1) * stride + x] + rowSum;
      intSqSum[y * stride + x] = intSqSum[(y - 1) * stride + x] + rowSq;
    }
  }

  const out = new Uint8ClampedArray(n);
  const R = 128;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      const sum =
        intSum[(y1 + 1) * stride + (x1 + 1)] -
        intSum[y0 * stride + (x1 + 1)] -
        intSum[(y1 + 1) * stride + x0] +
        intSum[y0 * stride + x0];
      const sqSum =
        intSqSum[(y1 + 1) * stride + (x1 + 1)] -
        intSqSum[y0 * stride + (x1 + 1)] -
        intSqSum[(y1 + 1) * stride + x0] +
        intSqSum[y0 * stride + x0];

      const mean = sum / area;
      const variance = Math.max(0, sqSum / area - mean * mean);
      const std = Math.sqrt(variance);
      const thresh = mean * (1 + k * (std / R - 1));

      const v = lum[y * width + x];
      out[y * width + x] = v < thresh ? 0 : 255;
    }
  }
  return out;
}

export interface TableGridGeometry {
  rowYs: number[];
  colXs: number[];
}

/**
 * Detects horizontal gridlines within [xStart, xEnd] across [yStart, yEnd] from luminance.
 * Multi-scale neighbor offsets (+-2 and +-4) catch both 1px digital borders and 2-3px upscaled camera lines.
 */
export function detectHorizontalGridLines(
  lum: Float32Array,
  width: number,
  height: number,
  xStart = 0,
  xEnd = width - 1,
  yStart = 2,
  yEnd = height - 3,
  minRatio = 0.5
): number[] {
  const left = Math.max(0, Math.round(xStart));
  const right = Math.min(width - 1, Math.round(xEnd));
  const span = right - left + 1;
  if (span < 20) return [];

  const yLo = Math.max(2, Math.round(yStart));
  const yHi = Math.min(height - 3, Math.round(yEnd));
  const minPeakGap = Math.max(16, Math.round(height * 0.014));
  const score = new Float32Array(height);

  for (let y = yLo; y <= yHi; y++) {
    const ym2 = Math.max(0, y - 2);
    const ym4 = Math.max(0, y - 4);
    const yp2 = Math.min(height - 1, y + 2);
    const yp4 = Math.min(height - 1, y + 4);
    let hits = 0;
    for (let x = left; x <= right; x += 2) {
      const c = lum[y * width + x];
      const top = Math.max(lum[ym2 * width + x], lum[ym4 * width + x]);
      const bot = Math.max(lum[yp2 * width + x], lum[yp4 * width + x]);
      if (
        c < 228 &&
        ((top - c > 7 && bot - c > 7) || (c <= Math.min(top, bot) + 3 && Math.abs(top - bot) > 20))
      ) {
        hits++;
      }
    }
    score[y] = hits / (span / 2);
  }

  const peaks: number[] = [];
  for (let y = yLo; y <= yHi; y++) {
    const prevScore = y > 0 ? score[y - 1] : 0;
    const nextScore = y + 1 < height ? score[y + 1] : 0;
    if (score[y] >= minRatio && score[y] >= prevScore && score[y] >= nextScore) {
      const prev = peaks[peaks.length - 1];
      if (prev === undefined || y - prev > minPeakGap) {
        peaks.push(y);
      } else if (score[y] > score[prev]) {
        peaks[peaks.length - 1] = y;
      }
    }
  }
  return peaks;
}

/**
 * Detects vertical gridlines within [yStart, yEnd] across [xStart, xEnd] from luminance.
 */
export function detectVerticalGridLines(
  lum: Float32Array,
  width: number,
  height: number,
  yStart = 0,
  yEnd = height - 1,
  xStart = 2,
  xEnd = width - 3,
  minRatio = 0.55
): number[] {
  const top = Math.max(0, Math.round(yStart));
  const bot = Math.min(height - 1, Math.round(yEnd));
  const span = bot - top + 1;
  if (span < 10) return [];

  const xLo = Math.max(2, Math.round(xStart));
  const xHi = Math.min(width - 3, Math.round(xEnd));
  const minColGap = Math.max(40, Math.round(width * 0.04));
  const score = new Float32Array(width);

  for (let x = xLo; x <= xHi; x++) {
    const xm2 = Math.max(0, x - 2);
    const xm4 = Math.max(0, x - 4);
    const xp2 = Math.min(width - 1, x + 2);
    const xp4 = Math.min(width - 1, x + 4);
    let hits = 0;
    for (let y = top; y <= bot; y++) {
      const c = lum[y * width + x];
      const l = Math.max(lum[y * width + xm2], lum[y * width + xm4]);
      const r = Math.max(lum[y * width + xp2], lum[y * width + xp4]);
      if (c < 228 && ((l - c > 6 && r - c > 6) || Math.abs(r - l) > 15)) {
        hits++;
      }
    }
    score[x] = hits / span;
  }

  const peaks: number[] = [];
  for (let x = xLo; x <= xHi; x++) {
    const prevScore = x > 0 ? score[x - 1] : 0;
    const nextScore = x + 1 < width ? score[x + 1] : 0;
    if (score[x] >= minRatio && score[x] >= prevScore && score[x] >= nextScore) {
      const prev = peaks[peaks.length - 1];
      if (prev === undefined || x - prev > minColGap) {
        peaks.push(x);
      } else if (score[x] > score[prev]) {
        peaks[peaks.length - 1] = x;
      }
    }
  }
  return peaks;
}

/**
 * Grid-first geometry detector: extracts complete bordered row & column gridlines
 * from pixel geometry, optionally anchored around a candidate text hint box.
 */
export function detectBorderedTableGrid(
  gridLum: Float32Array,
  width: number,
  height: number,
  options: {
    hintY0?: number;
    hintY1?: number;
    hintX0?: number;
    hintX1?: number;
    maxY?: number;
  } = {}
): TableGridGeometry | null {
  const maxY = Math.min(height - 3, Math.round(options.maxY ?? height - 3));
  const scanX0 = Math.max(4, Math.round((options.hintX0 ?? width * 0.04) - width * 0.05));
  const scanX1 = Math.min(width - 5, Math.round((options.hintX1 ?? width * 0.96) + width * 0.05));

  const allHLines = detectHorizontalGridLines(
    gridLum,
    width,
    height,
    scanX0,
    scanX1,
    2,
    maxY,
    0.42
  );
  if (allHLines.length < 3) return null;

  // Estimate typical row pitch (require >= 5 lines inside hint before preferring inHint over allHLines)
  const hintY0 = options.hintY0 ?? 0;
  const hintY1 = options.hintY1 ?? maxY;
  const inHint = allHLines.filter((y) => y >= hintY0 - 60 && y <= hintY1 + 90);
  const gapSource = inHint.length >= 5 ? inHint : allHLines;
  const minRowGap = Math.max(28, Math.round(height * 0.028));
  const rawGaps: number[] = [];
  for (let i = 1; i < gapSource.length; i++) {
    const g = gapSource[i] - gapSource[i - 1];
    if (g >= minRowGap && g <= height * 0.35) rawGaps.push(g);
  }
  if (rawGaps.length === 0) return null;
  rawGaps.sort((a, b) => a - b);
  const typicalStep = rawGaps[Math.floor(rawGaps.length / 2)];

  // Remove close sub-row peaks (e.g. text baselines / double edges < 58% of typicalStep)
  const dedupHLines = allHLines.filter(
    (y, idx, arr) => idx === 0 || y - arr[idx - 1] >= typicalStep * 0.58
  );

  // Split dedupHLines into vertical table groups separated by > 2.25 * typicalStep
  // (tolerates 1 weak glare-faded horizontal divider without amputating top rows)
  const groups: number[][] = [[dedupHLines[0]]];
  for (let i = 1; i < dedupHLines.length; i++) {
    const gap = dedupHLines[i] - dedupHLines[i - 1];
    if (gap > typicalStep * 2.25) {
      groups.push([dedupHLines[i]]);
    } else {
      groups[groups.length - 1].push(dedupHLines[i]);
    }
  }

  // Pick group with strongest overlap with hintBox (or longest group if no hint)
  let bestGroup = groups[0];
  let bestScore = -1;
  for (const g of groups) {
    if (g.length < 3) continue;
    const overlapCount = g.filter((y) => y >= hintY0 - 40 && y <= hintY1 + 60).length;
    const sc = options.hintY0 !== undefined ? overlapCount * 20 + g.length : g.length;
    if (sc > bestScore) {
      bestScore = sc;
      bestGroup = g;
    }
  }
  if (bestGroup.length < 3) return null;

  // Compute tight table horizontal bounds using continuous vertical borders across table body
  const bodyTop = bestGroup.length >= 4 ? bestGroup[1] : bestGroup[0];
  const bodyBot = bestGroup[bestGroup.length - 1];
  let vLines = detectVerticalGridLines(
    gridLum,
    width,
    height,
    bodyTop + 2,
    bodyBot - 2,
    Math.max(2, scanX0 - 20),
    Math.min(width - 3, scanX1 + 20),
    0.66
  );
  if (vLines.length < 3) {
    vLines = detectVerticalGridLines(
      gridLum,
      width,
      height,
      bodyTop + 2,
      bodyBot - 2,
      Math.max(2, scanX0 - 20),
      Math.min(width - 3, scanX1 + 20),
      0.55
    );
  }
  // Drop Excel row-number gutter on far left if it is a narrow leftmost strip (<5.5% width)
  // whose left border extends up into empty sheet rows above the bordered table.
  if (
    vLines.length >= 4 &&
    vLines[0] < width * 0.08 &&
    vLines[1] - vLines[0] < width * 0.055 &&
    bodyTop > typicalStep * 2
  ) {
    const aboveLeft = detectVerticalGridLines(
      gridLum,
      width,
      height,
      Math.max(4, bodyTop - typicalStep * 2.2),
      bodyTop - 4,
      Math.max(2, vLines[0] - 8),
      vLines[1] + 8,
      0.55
    );
    if (aboveLeft.some((x) => Math.abs(x - vLines[0]) < 14)) {
      vLines = vLines.slice(1);
    }
  }
  if (vLines.length < 3) return null;

  const tblLeft = vLines[0];
  const tblRight = vLines[vLines.length - 1];

  // Refine rowYs specifically within [tblLeft, tblRight], allowing bestGroup to keep
  // all contiguous rows down past sparse Pass-1 hints plus up to ~2 total rows below.
  const tightTop = Math.max(2, bestGroup[0] - Math.round(typicalStep * 1.4));
  const tightBot = Math.min(maxY, bestGroup[bestGroup.length - 1] + Math.round(typicalStep * 2.2));
  const tblHLines = detectHorizontalGridLines(
    gridLum,
    width,
    height,
    tblLeft + 4,
    tblRight - 4,
    tightTop,
    tightBot,
    0.42
  );

  // Deduplicate any sliver gaps smaller than 58% of typicalStep
  const cleanHLines = (tblHLines.length >= 3 ? tblHLines : bestGroup).filter(
    (y, idx, arr) => idx === 0 || y - arr[idx - 1] >= typicalStep * 0.58
  );

  if (cleanHLines.length < 3) {
    return { rowYs: bestGroup, colXs: vLines };
  }
  const midTarget = (bestGroup[0] + bestGroup[bestGroup.length - 1]) / 2;
  const subGroups: number[][] = [[cleanHLines[0]]];
  for (let i = 1; i < cleanHLines.length; i++) {
    if (cleanHLines[i] - cleanHLines[i - 1] > typicalStep * 2.25) {
      subGroups.push([cleanHLines[i]]);
    } else {
      subGroups[subGroups.length - 1].push(cleanHLines[i]);
    }
  }
  const chosenRows = subGroups.reduce((best, cur) => {
    const containsMid = cur[0] <= midTarget && cur[cur.length - 1] >= midTarget ? 100 : 0;
    const bestMid = best[0] <= midTarget && best[best.length - 1] >= midTarget ? 100 : 0;
    return cur.length + containsMid > best.length + bestMid ? cur : best;
  }, subGroups[0]);

  if (chosenRows.length < 3) return null;

  // Recompute body row step directly from chosenRows (immune to outlier gaps elsewhere on page)
  const chosenGaps = chosenRows
    .slice(1)
    .map((y, idx) => y - chosenRows[idx])
    .filter((g) => g >= minRowGap)
    .sort((a, b) => a - b);
  const bodyStep =
    chosenGaps.length > 0 ? chosenGaps[Math.floor(chosenGaps.length / 2)] : typicalStep;

  // Subdivide ONLY genuine double-height intervals (> 1.65 * bodyStep) where a real horizontal line peak exists
  const finalRowYs: number[] = [chosenRows[0]];
  for (let i = 1; i < chosenRows.length; i++) {
    const prevY = finalRowYs[finalRowYs.length - 1];
    const curY = chosenRows[i];
    const span = curY - prevY;
    if (span > bodyStep * 1.65 && span < bodyStep * 3.2) {
      const nSub = Math.round(span / bodyStep);
      if (nSub >= 2) {
        const subPeaks = detectHorizontalGridLines(
          gridLum,
          width,
          height,
          tblLeft + 4,
          tblRight - 4,
          prevY + Math.round(bodyStep * 0.58),
          curY - Math.round(bodyStep * 0.58),
          0.32
        );
        for (let s = 1; s < nSub; s++) {
          const targetY = prevY + Math.round((span * s) / nSub);
          const nearPeak = subPeaks.find((py) => Math.abs(py - targetY) <= bodyStep * 0.3);
          if (nearPeak !== undefined || subPeaks.length >= nSub - 1) {
            finalRowYs.push(nearPeak ?? targetY);
          }
        }
      }
    }
    finalRowYs.push(curY);
  }

  return { rowYs: finalRowYs, colXs: vLines };
}

/**
 * Cleans cell borders (top/bottom/left/right), normalizes local shaded cell backgrounds
 * (e.g. blue/gray Excel headers), and detects whether a cell is genuinely empty.
 */
export function cleanCellPatchAndCheckEmpty(
  lum: Float32Array,
  imgW: number,
  imgH: number,
  xLeft: number,
  xRight: number,
  yTop: number,
  yBot: number
): CellInkAnalysis {
  const insetX = Math.min(3, Math.max(1, Math.round((xRight - xLeft) * 0.015)));
  const insetY = Math.min(4, Math.max(2, Math.round((yBot - yTop) * 0.06)));
  const sx = Math.max(0, Math.round(xLeft + insetX));
  const ex = Math.min(imgW, Math.round(xRight - insetX));
  const sy = Math.max(0, Math.round(yTop + insetY));
  const ey = Math.min(imgH, Math.round(yBot - insetY));
  const cw = Math.max(0, ex - sx);
  const ch = Math.max(0, ey - sy);

  if (cw < 8 || ch < 8) {
    return {
      isEmpty: true,
      inkCount: 0,
      inkRatio: 0,
      contrastSnr: 0,
      patchLum: new Float32Array(0),
      patchW: 0,
      patchH: 0,
    };
  }

  const patch = new Float32Array(cw * ch);
  const sortedVals: number[] = [];
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const v = lum[(sy + y) * imgW + (sx + x)];
      patch[y * cw + x] = v;
      sortedVals.push(v);
    }
  }
  sortedVals.sort((a, b) => a - b);
  // 80th percentile captures the cell's true fill background (works for both white and shaded blue headers)
  const bgLevel = sortedVals[Math.min(sortedVals.length - 1, Math.floor(sortedVals.length * 0.8))];

  // Remove residual horizontal border lines (outer 20% top/bottom bands) relative to bgLevel
  const borderThresh = Math.max(120, bgLevel - 40);
  const maxStripY = Math.min(14, Math.max(6, Math.round(ch * 0.2)));
  for (let y = 0; y < ch; y++) {
    if (y >= maxStripY && y < ch - maxStripY) continue;
    let dark = 0;
    for (let x = 0; x < cw; x++) {
      if (patch[y * cw + x] < borderThresh) dark++;
    }
    if (dark >= cw * 0.68) {
      for (let x = 0; x < cw; x++) patch[y * cw + x] = bgLevel;
    }
  }

  // Remove residual vertical border lines (tight 2-4px outer left/right edge only so leading 'H'/'O'/'I' stems aren't erased)
  const maxStripX = Math.min(4, Math.max(2, Math.round(cw * 0.03)));
  for (let x = 0; x < cw; x++) {
    if (x >= maxStripX && x < cw - maxStripX) continue;
    let dark = 0;
    for (let y = 0; y < ch; y++) {
      if (patch[y * cw + x] < borderThresh) dark++;
    }
    if (dark >= ch * 0.8) {
      for (let y = 0; y < ch; y++) patch[y * cw + x] = bgLevel;
    }
  }

  let inkCount = 0;
  let interiorInkCount = 0;
  let inkMin = 255;
  const inkCutoff = Math.min(188, bgLevel - 38);
  const coreY0 = Math.min(ch - 1, Math.max(2, Math.round(ch * 0.16)));
  const coreY1 = Math.max(coreY0 + 1, Math.round(ch * 0.84));
  const coreX0 = Math.min(cw - 1, Math.max(2, Math.round(cw * 0.06)));
  const coreX1 = Math.max(coreX0 + 1, Math.round(cw * 0.94));

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const v = patch[y * cw + x];
      if (v < inkCutoff) {
        inkCount++;
        if (y >= coreY0 && y < coreY1 && x >= coreX0 && x < coreX1) {
          interiorInkCount++;
        }
        if (v < inkMin) inkMin = v;
      }
    }
  }

  const contrastSnr = inkCount > 0 ? Math.max(0, bgLevel - inkMin) : 0;
  const inkRatio = inkCount / (cw * ch);
  // Require real interior ink so residual tilted cell borders near top/bottom rims don't fake text in empty cells
  const isEmpty = interiorInkCount < 8 || inkCount < 8 || contrastSnr < 28;

  // Normalize patch brightness so local shaded background maps cleanly to 255 for OCR
  if (!isEmpty && bgLevel > inkMin + 20) {
    const whitePoint = Math.max(inkMin + 25, bgLevel * 0.93);
    const blackPoint = Math.max(0, inkMin * 0.85);
    const range = Math.max(20, whitePoint - blackPoint);
    for (let i = 0; i < patch.length; i++) {
      const stretched = ((patch[i] - blackPoint) / range) * 255;
      patch[i] = Math.max(0, Math.min(255, stretched));
    }
  }

  return {
    isEmpty,
    inkCount,
    inkRatio,
    contrastSnr,
    patchLum: patch,
    patchW: cw,
    patchH: ch,
  };
}

/**
 * Classifies whether a header represents an ID / string / label column that MUST be
 * preserved verbatim as a string (never coerced as numeric or stripped of leading zeros).
 */
export function isIdentifierHeader(header: string): boolean {
  const norm = header.toLowerCase().trim();
  if (!norm) return false;
  return /\b(id|sfid|code|deal\s*id|dealer\s*id|dealer\s*code|customer\s*id|finnone|opportunity|owner|dealer|stage|issued|date|name|ref|account)\b/.test(
    norm
  );
}

/**
 * Classifies whether a header represents a numeric count/metric column.
 */
export function isStrictNumericHeader(header: string): boolean {
  const norm = header.toLowerCase().trim();
  if (!norm) return false;
  if (isIdentifierHeader(norm) && !/\b(count|counter|total|qty|amount|preparation|post\s*do|qc\s*hold|submitted)\b/.test(norm)) {
    return false;
  }
  return /\b(count|counter|prep|preparation|post\s*do|qc\s*hold|submitted|grand\s*total|sub\s*total|total|qty|amount|bills|vas|cd|cdd|vs|vsd|ifc)\b/.test(
    norm
  );
}

/**
 * Detects if a value looks like an alphanumeric ID or leading-zero code string.
 */
export function looksLikeStringIdValue(val: string): boolean {
  const v = val.trim();
  if (!v) return false;
  if (/^0\d+$/.test(v)) return true; // leading zeros like 00412
  return /[a-zA-Z]/.test(v) && /\d/.test(v); // alphanumeric like A129149011, LA4703863251
}

/**
 * Evaluates a cell's OCR confidence and ambiguity WITHOUT silently substituting characters
 * (never changes O->0, I->1, S->5, etc.). Flags uncertain cells with explicit reasons.
 */
export function evaluateCellConfidenceAndFlags(params: {
  value: string;
  ocrConfidence: number;
  contrastSnr: number;
  isIdColumn: boolean;
  isNumericColumn: boolean;
  isHeaderRow: boolean;
}): { confidence: number; uncertain: boolean; reasons: string[] } {
  const {
    value,
    ocrConfidence,
    contrastSnr,
    isIdColumn,
    isNumericColumn,
    isHeaderRow,
  } = params;

  const trimmed = value.trim();
  if (trimmed === '') {
    return { confidence: 100, uncertain: false, reasons: [] };
  }

  const reasons: string[] = [];
  let effectiveConf = Math.round(ocrConfidence);

  if (ocrConfidence < 82) {
    reasons.push(`Low OCR confidence (${Math.round(ocrConfidence)}%)`);
  }
  if (contrastSnr > 0 && contrastSnr < 42) {
    reasons.push(`Low cell contrast / possible glare`);
    effectiveConf = Math.min(effectiveConf, 72);
  }

  if (!isHeaderRow) {
    // Flag unexpected non-digits in numeric-expected columns WITHOUT changing them
    if (isNumericColumn && !/^-?\d+(\.\d+)?%?$/.test(trimmed)) {
      reasons.push(`Non-numeric characters "${trimmed}" in numeric column — verify original`);
      effectiveConf = Math.min(effectiveConf, 55);
    }

    // Flag alphanumeric IDs containing notoriously ambiguous OCR glyphs when confidence isn't very high
    if (
      (isIdColumn || looksLikeStringIdValue(trimmed)) &&
      /[O0Il1S5B8]/.test(trimmed) &&
      ocrConfidence < 93
    ) {
      reasons.push(`ID/code contains O/0, I/l/1, S/5, or B/8 — verify characters`);
    }
  }

  return {
    confidence: Math.max(0, Math.min(100, effectiveConf)),
    uncertain: reasons.length > 0,
    reasons,
  };
}

/**
 * Cross-checks numeric row sums against Grand Total column & column sums against Grand Total row
 * ONLY to flag discrepancies for human visual review — NEVER alters or invents cell values.
 */
export function checkTableSumDiscrepancies(
  cells: ExtractedCell[][],
  headerRowIdx: number
): string[] {
  const warnings: string[] = [];
  if (cells.length <= headerRowIdx + 1) return warnings;

  const headers = cells[headerRowIdx].map((c) => c.value);
  const totalColIdx = headers.findIndex((h) => /\b(grand\s*total|row\s*total|^total$)\b/i.test(h));
  if (totalColIdx < 2) return warnings;

  // Check horizontal row sums (sum of numeric cols 1 .. totalColIdx - 1 vs totalColIdx)
  for (let r = headerRowIdx + 1; r < cells.length; r++) {
    const totalStr = cells[r][totalColIdx]?.value.trim() ?? '';
    if (!/^\d+$/.test(totalStr)) {
      if (totalStr !== '') {
        cells[r][totalColIdx].uncertain = true;
        cells[r][totalColIdx].reasons.push('Grand Total cell is non-numeric');
      }
      continue;
    }
    const expectedTotal = parseInt(totalStr, 10);
    let rowSum = 0;
    let hasInvalidPart = false;

    for (let c = 1; c < totalColIdx; c++) {
      const cellVal = cells[r][c]?.value.trim() ?? '';
      if (cellVal === '') continue;
      if (/^\d+$/.test(cellVal)) {
        rowSum += parseInt(cellVal, 10);
      } else {
        hasInvalidPart = true;
      }
    }

    if (!hasInvalidPart && rowSum !== expectedTotal) {
      const label = cells[r][0]?.value || `Row ${r + 1}`;
      const msg = `${label}: row sum (${rowSum}) != Grand Total (${expectedTotal})`;
      warnings.push(msg);
      cells[r][totalColIdx].uncertain = true;
      cells[r][totalColIdx].reasons.push(msg);
    }
  }

  // Check vertical column sums if bottom row is Grand Total
  const lastIdx = cells.length - 1;
  if (lastIdx > headerRowIdx + 1 && /\b(grand\s*total|total)\b/i.test(cells[lastIdx][0]?.value ?? '')) {
    for (let c = 1; c <= totalColIdx; c++) {
      const gtStr = cells[lastIdx][c]?.value.trim() ?? '';
      let colSum = 0;
      let anyNum = false;
      let invalidColCell = false;

      for (let r = headerRowIdx + 1; r < lastIdx; r++) {
        const val = cells[r][c]?.value.trim() ?? '';
        if (val === '') continue;
        if (/^\d+$/.test(val)) {
          colSum += parseInt(val, 10);
          anyNum = true;
        } else {
          invalidColCell = true;
        }
      }

      if (!invalidColCell && anyNum) {
        if (gtStr === '') {
          const colLabel = headers[c] || `Col ${c + 1}`;
          const msg = `${colLabel}: Grand Total cell is blank (sum of rows above is ${colSum})`;
          warnings.push(msg);
          cells[lastIdx][c].uncertain = true;
          cells[lastIdx][c].reasons.push(msg);
        } else if (/^\d+$/.test(gtStr) && parseInt(gtStr, 10) !== colSum) {
          const colLabel = headers[c] || `Col ${c + 1}`;
          const msg = `${colLabel}: column sum (${colSum}) != Grand Total (${gtStr})`;
          warnings.push(msg);
          cells[lastIdx][c].uncertain = true;
          cells[lastIdx][c].reasons.push(msg);
        }
      }
    }
  }

  return warnings;
}
