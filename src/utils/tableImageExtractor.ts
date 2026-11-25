import { createWorker, PSM } from 'tesseract.js';
import { loadImageElement } from './ocrExtractor';

export interface ExtractedTableResult {
  matrix: string[][];
  confidence: number;
  notes: string;
}

interface OcrWord {
  text: string;
  confidence: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  xCenter: number;
  yCenter: number;
}

export type TableProgressCallback = (status: string, pct: number) => void;

/**
 * Prepares a clean, de-moiréd, shadow-normalized grayscale canvas specifically tuned for
 * camera photos of laptop/monitor screens and printed tables (dissolves LCD stripes without
 * sharpening noise).
 */
function buildDeMoireOcrCanvas(srcCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const srcData = srcCanvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const n = w * h;

  // 1. Convert to luminance
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    lum[i] = 0.299 * srcData[p] + 0.587 * srcData[p + 1] + 0.114 * srcData[p + 2];
  }

  // 2. Mild 3x3 weighted Gaussian smooth to dissolve vertical LCD subpixel moiré stripes
  const smooth = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(w - 1, x + 1);
      smooth[y * w + x] =
        (lum[y0 * w + x0] +
          2 * lum[y0 * w + x] +
          lum[y0 * w + x1] +
          2 * lum[y * w + x0] +
          4 * lum[y * w + x] +
          2 * lum[y * w + x1] +
          lum[y1 * w + x0] +
          2 * lum[y1 * w + x] +
          lum[y1 * w + x1]) /
        16;
    }
  }

  // 3. Fast local white-point estimation (separable dilation + blur) to remove glare/shadows
  const rad = Math.max(12, Math.min(34, Math.round(Math.min(w, h) * 0.025)));
  const bg = estimateLocalMaxBlur(smooth, w, h, rad);

  // 4. Normalize background to clean white & darken ink smoothly around pivot 200
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const norm = Math.min(255, (smooth[i] / Math.max(45, bg[i])) * 255);
    let val = (norm - 200) * 1.65 + 204;
    if (val > 238) val = 255;
    val = Math.max(0, Math.min(255, val));
    out[p] = val;
    out[p + 1] = val;
    out[p + 2] = val;
    out[p + 3] = 255;
  }

  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  outCanvas.getContext('2d')!.putImageData(new ImageData(out, w, h), 0, 0);
  return outCanvas;
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

  // Quick horizontal+vertical box blur
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
 * Extracts a structured text/table matrix (`string[][]`) from any camera photo
 * or screenshot of a report/Excel sheet and returns clean cells for digital rendering.
 */
export async function extractTableMatrixFromImage(
  imageDataUrl: string,
  onProgress?: TableProgressCallback
): Promise<ExtractedTableResult> {
  onProgress?.('De-moiré & lighting cleanup...', 12);
  const img = await loadImageElement(imageDataUrl);

  const targetMax = Math.max(img.naturalWidth, img.naturalHeight) < 1200 ? 1800 : 1900;
  const scale = Math.min(2.6, targetMax / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w;
  srcCanvas.height = h;
  const sCtx = srcCanvas.getContext('2d')!;
  sCtx.imageSmoothingEnabled = true;
  sCtx.imageSmoothingQuality = 'high';
  sCtx.drawImage(img, 0, 0, w, h);

  // Detect dark bottom taskbar on raw image before normalization
  const rawD = sCtx.getImageData(0, 0, w, h).data;
  let cutBottomY = h;
  for (let y = Math.floor(h * 0.72); y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      rowSum += 0.299 * rawD[i] + 0.587 * rawD[i + 1] + 0.114 * rawD[i + 2];
    }
    if (rowSum / (w / 4) < 115) {
      cutBottomY = Math.max(0, y - 8);
      break;
    }
  }

  const cleanCanvas = buildDeMoireOcrCanvas(srcCanvas);
  const oCtx = cleanCanvas.getContext('2d')!;
  if (cutBottomY < h) {
    oCtx.fillStyle = '#FFFFFF';
    oCtx.fillRect(0, cutBottomY, w, h - cutBottomY);
  }

  onProgress?.('Detecting table layout & text...', 30);
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.('Reading table structure...', 32 + Math.round(m.progress * 28));
      }
    },
  });

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: '1',
    });

    const res = await worker.recognize(cleanCanvas.toDataURL('image/png'), {}, {
      text: true,
      blocks: true,
    });

    const words: OcrWord[] = [];
    for (const block of res.data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          for (const word of line.words || []) {
            const cleaned = word.text.replace(/[|_[\]{}~`]/g, '').trim();
            if (!cleaned) continue;
            words.push({
              text: cleaned,
              confidence: word.confidence,
              x0: word.bbox.x0,
              y0: word.bbox.y0,
              x1: word.bbox.x1,
              y1: word.bbox.y1,
              xCenter: (word.bbox.x0 + word.bbox.x1) / 2,
              yCenter: (word.bbox.y0 + word.bbox.y1) / 2,
            });
          }
        }
      }
    }

    onProgress?.('Re-reading cells for maximum accuracy...', 65);
    const matrix = await buildAndRefineTable(
      words,
      cleanCanvas,
      w,
      cutBottomY,
      worker,
      onProgress
    );

    return {
      matrix,
      confidence: Math.round(res.data.confidence || 0),
      notes:
        matrix.length > 0
          ? `Converted image into ${matrix.length} rows × ${matrix[0].length} columns.`
          : 'No table detected in image.',
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Finds vertical cell borders across a single horizontal row band (works even when the
 * entire camera photo has a slight tilt because a single row is only ~35px tall!).
 */
function detectRowVerticalBorders(
  canvas: HTMLCanvasElement,
  y0: number,
  y1: number,
  xMin: number,
  xMax: number
): number[] {
  const w = canvas.width;
  const h = canvas.height;
  const top = Math.max(0, Math.round(y0));
  const bot = Math.min(h - 1, Math.round(y1));
  const left = Math.max(3, Math.round(xMin));
  const right = Math.min(w - 4, Math.round(xMax));
  const rowH = bot - top;
  if (rowH < 8 || right <= left + 20) return [];

  const data = canvas.getContext('2d')!.getImageData(0, top, w, rowH).data;
  const score = new Float32Array(w);

  for (let x = left; x < right; x++) {
    let darkHits = 0;
    for (let y = 0; y < rowH; y++) {
      const lum = data[(y * w + x) * 4];
      const lumL = data[(y * w + (x - 3)) * 4];
      const lumR = data[(y * w + (x + 3)) * 4];
      if (lum < 228 && lumL - lum > 7 && lumR - lum > 7) {
        darkHits++;
      }
    }
    score[x] = darkHits / rowH;
  }

  // Pick peaks where at least 60% of the row band has a vertical border
  const peaks: number[] = [];
  for (let x = left + 2; x < right - 2; x++) {
    if (score[x] >= 0.6 && score[x] >= score[x - 1] && score[x] >= score[x + 1]) {
      const prev = peaks[peaks.length - 1];
      if (prev === undefined || x - prev > 36) {
        peaks.push(x);
      } else if (score[x] > score[prev]) {
        peaks[peaks.length - 1] = x;
      }
    }
  }
  return peaks;
}

function cropCleanCellDataUrl(
  canvas: HTMLCanvasElement,
  xLeft: number,
  xRight: number,
  yTop: number,
  yBot: number
): string | null {
  const insetX = Math.min(7, Math.max(3, Math.round((xRight - xLeft) * 0.03)));
  const insetY = Math.min(6, Math.max(3, Math.round((yBot - yTop) * 0.11)));
  const sx = Math.max(0, Math.round(xLeft + insetX));
  const ex = Math.min(canvas.width, Math.round(xRight - insetX));
  const sy = Math.max(0, Math.round(yTop + insetY));
  const ey = Math.min(canvas.height, Math.round(yBot - insetY));
  const cw = ex - sx;
  const ch = ey - sy;
  if (cw < 10 || ch < 10) return null;

  const patch = canvas.getContext('2d')!.getImageData(sx, sy, cw, ch);
  const d = patch.data;

  // Erase any horizontal cell border lines spanning >= 70% of cell width so they aren't read as '=' or '-'
  for (let y = 0; y < ch; y++) {
    let rowDark = 0;
    for (let x = 0; x < cw; x++) {
      if (d[(y * cw + x) * 4] < 175) rowDark++;
    }
    if (rowDark >= cw * 0.7) {
      for (let x = 0; x < cw; x++) {
        const idx = (y * cw + x) * 4;
        d[idx] = 255;
        d[idx + 1] = 255;
        d[idx + 2] = 255;
      }
    }
  }

  // Check if cell actually contains dark text ink
  let ink = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (d[(y * cw + x) * 4] < 165) ink++;
    }
  }
  if (ink < 10) return null;

  const tmp = document.createElement('canvas');
  tmp.width = cw;
  tmp.height = ch;
  tmp.getContext('2d')!.putImageData(patch, 0, 0);

  const scale = ch < 40 ? 2 : 1.5;
  const pad = 22;
  const out = document.createElement('canvas');
  out.width = Math.round(cw * scale) + pad * 2;
  out.height = Math.round(ch * scale) + pad * 2;
  const oCtx = out.getContext('2d')!;
  oCtx.fillStyle = '#FFFFFF';
  oCtx.fillRect(0, 0, out.width, out.height);
  oCtx.imageSmoothingEnabled = true;
  oCtx.imageSmoothingQuality = 'high';
  oCtx.drawImage(tmp, pad, pad, Math.round(cw * scale), Math.round(ch * scale));
  return out.toDataURL('image/png');
}

async function buildAndRefineTable(
  allWords: OcrWord[],
  cleanCanvas: HTMLCanvasElement,
  imgW: number,
  maxY: number,
  worker: Awaited<ReturnType<typeof createWorker>>,
  onProgress?: TableProgressCallback
): Promise<string[][]> {
  if (allWords.length === 0) return [];

  // 1. Cluster words into horizontal lines
  const sorted = [...allWords]
    .filter((w) => w.yCenter < maxY)
    .sort((a, b) => a.yCenter - b.yCenter || a.x0 - b.x0);

  const heights = sorted.map((w) => Math.max(10, w.y1 - w.y0));
  const medianH = heights.sort((a, b) => a - b)[Math.floor(heights.length / 2)] || 18;
  const rowTol = Math.max(8, medianH * 0.65);

  const rawRows: OcrWord[][] = [];
  for (const w of sorted) {
    const last = rawRows[rawRows.length - 1];
    if (last) {
      const meanY = last.reduce((s, x) => s + x.yCenter, 0) / last.length;
      if (Math.abs(w.yCenter - meanY) <= rowTol) {
        last.push(w);
        continue;
      }
    }
    rawRows.push([w]);
  }
  rawRows.forEach((r) => r.sort((a, b) => a.x0 - b.x0));

  // 2. Strip Excel row-number gutter on the left (sequential numbers 30, 31, 32...)
  let gutterRightX = 0;
  const leftNums: Array<{ val: number; x1: number }> = [];
  for (const row of rawRows) {
    const first = row[0];
    if (first && first.x0 < imgW * 0.14 && /^\d{1,4}$/.test(first.text)) {
      leftNums.push({ val: parseInt(first.text, 10), x1: first.x1 });
    }
  }
  if (leftNums.length >= 3) {
    let seq = 0;
    for (let i = 1; i < leftNums.length; i++) {
      if (leftNums[i].val === leftNums[i - 1].val + 1) seq++;
    }
    if (seq >= 2) {
      gutterRightX = Math.max(...leftNums.map((n) => n.x1)) + 8;
    }
  }

  // Filter Excel UI chrome rows (A B C D E F, Sheet1/Sheet2, Workbook Statistics, stray single chars)
  const filteredRows: Array<{ words: OcrWord[]; yCenter: number; y0: number; y1: number }> = [];
  for (const row of rawRows) {
    const rowWords = row.filter((w) => w.xCenter > gutterRightX);
    if (rowWords.length === 0) continue;

    const joined = rowWords.map((w) => w.text).join(' ');
    const singleUpper = rowWords.filter((w) => /^[A-Z]$/.test(w.text));
    if (singleUpper.length >= 3 && singleUpper.length >= rowWords.length * 0.65) continue;
    if (/\b(sheet\s*\d|workbook|statistics|accessibility|ready)\b/i.test(joined)) continue;
    if (rowWords[0].yCenter < maxY * 0.1 && /^(fx|b\d+)$/i.test(rowWords[0].text)) continue;
    if (rowWords.length === 1 && joined.length <= 2 && !/^\d+$/.test(joined)) continue;

    const yCenter = rowWords.reduce((s, w) => s + w.yCenter, 0) / rowWords.length;
    const y0 = Math.min(...rowWords.map((w) => w.y0));
    const y1 = Math.max(...rowWords.map((w) => w.y1));
    filteredRows.push({ words: rowWords, yCenter, y0, y1 });
  }

  if (filteredRows.length === 0) return [];

  // 3. Split into vertical table blocks at blank row gaps and pick primary table
  const ySteps: number[] = [];
  for (let i = 1; i < filteredRows.length; i++) {
    const step = filteredRows[i].yCenter - filteredRows[i - 1].yCenter;
    if (step > medianH * 0.8 && step < medianH * 3.5) ySteps.push(step);
  }
  const typicalStep =
    ySteps.length > 0
      ? ySteps.sort((a, b) => a - b)[Math.floor(ySteps.length / 2)]
      : medianH * 1.9;

  const blocks: Array<typeof filteredRows> = [[filteredRows[0]]];
  for (let i = 1; i < filteredRows.length; i++) {
    const gap = filteredRows[i].yCenter - filteredRows[i - 1].yCenter;
    if (gap > typicalStep * 2.0) {
      blocks.push([filteredRows[i]]);
    } else {
      blocks[blocks.length - 1].push(filteredRows[i]);
    }
  }

  let targetBlock = blocks[0];
  if (blocks.length > 1) {
    targetBlock = blocks.reduce((best, cur) => {
      const score = (blk: typeof filteredRows) => {
        const text = blk.map((r) => r.words.map((w) => w.text).join(' ')).join(' ');
        let s = blk.length * 10;
        if (/grand\s*total|subtotal/i.test(text)) s += 60;
        if (/dealer|stage|deal\s*id|owner|preparation|submitted/i.test(text)) s += 30;
        return s;
      };
      return score(cur) > score(best) ? cur : best;
    }, blocks[0]);
  }

  // Stop targetBlock cleanly right after "Grand Total" row if Excel trailing rows exist below it
  const gtRowIdx = targetBlock.findIndex((r) =>
    /\bgrand\s*total\b/i.test(r.words.map((w) => w.text).join(' '))
  );
  if (gtRowIdx >= 2 && gtRowIdx < targetBlock.length - 1) {
    targetBlock = targetBlock.slice(0, gtRowIdx + 1);
  }

  // Drop spurious leading 1-word noise row before the actual table header
  if (
    targetBlock.length >= 4 &&
    targetBlock[0].words.length === 1 &&
    targetBlock[0].words[0].text.length <= 2 &&
    targetBlock[1].words.length >= 3
  ) {
    targetBlock = targetBlock.slice(1);
  }

  if (targetBlock.length === 0) return [];

  // 4. Identify the main column header row (prefer row with >= 4 distinct header words / keywords)
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(3, targetBlock.length); r++) {
    const txt = targetBlock[r].words.map((w) => w.text).join(' ');
    if (/dealer|stage|preparation|post\s*do|submitted|grand\s*total|issued|opportunity/i.test(txt)) {
      if (targetBlock[r].words.length >= targetBlock[headerRowIdx].words.length) {
        headerRowIdx = r;
      }
    }
  }

  const headerRow = targetBlock[headerRowIdx];
  const dataMinX = Math.max(
    gutterRightX,
    Math.min(...targetBlock.flatMap((r) => r.words.map((w) => w.x0))) - 24
  );
  const dataMaxX = Math.min(
    imgW,
    Math.max(...targetBlock.flatMap((r) => r.words.map((w) => w.x1))) + 24
  );

  // Detect vertical borders on individual thin row bands (header + first 4 data rows),
  // then keep only consensus borders appearing across >= 2 rows within +-12px (eliminates stray digits/noise!)
  const candidateRowsForBorders = targetBlock.slice(
    headerRowIdx,
    Math.min(targetBlock.length, headerRowIdx + 5)
  );
  const borderSets = candidateRowsForBorders.map((r) =>
    detectRowVerticalBorders(
      cleanCanvas,
      r.yCenter - typicalStep * 0.44,
      r.yCenter + typicalStep * 0.44,
      dataMinX - 10,
      dataMaxX + 10
    ).filter((bx) => !headerRow.words.some((w) => bx > w.x0 + 4 && bx < w.x1 - 4))
  );

  // Cluster border X candidates across rows (tolerance +-14px for slight tilt)
  const allBorderXs = borderSets.flat().sort((a, b) => a - b);
  const headerBorders: number[] = [];
  let cluster: number[] = [];
  for (const bx of allBorderXs) {
    if (cluster.length === 0 || bx - cluster[cluster.length - 1] <= 14) {
      cluster.push(bx);
    } else {
      if (cluster.length >= 2) {
        headerBorders.push(Math.round(cluster.reduce((s, v) => s + v, 0) / cluster.length));
      }
      cluster = [bx];
    }
  }
  if (cluster.length >= 2) {
    headerBorders.push(Math.round(cluster.reduce((s, v) => s + v, 0) / cluster.length));
  }

  let baseColBounds: Array<[number, number]> = [];
  if (headerBorders.length >= 3) {
    const b = [...headerBorders];
    if (b[0] - dataMinX > 36) b.unshift(dataMinX);
    if (dataMaxX - b[b.length - 1] > 36) b.push(dataMaxX);
    for (let i = 0; i < b.length - 1; i++) {
      if (b[i + 1] - b[i] >= 36) baseColBounds.push([b[i], b[i + 1]]);
    }
  }

  // Fallback: cluster header words using generous column-gap threshold (>= 28px)
  if (baseColBounds.length < 3) {
    const groups: OcrWord[][] = [];
    for (const w of headerRow.words) {
      const prev = groups[groups.length - 1];
      if (prev && w.x0 - prev[prev.length - 1].x1 < Math.max(26, medianH * 1.4)) {
        prev.push(w);
      } else {
        groups.push([w]);
      }
    }
    const centers = groups.map((g) => (g[0].x0 + g[g.length - 1].x1) / 2);
    baseColBounds = centers.map((c, i) => {
      const l = i === 0 ? dataMinX : (centers[i - 1] + c) / 2;
      const r = i === centers.length - 1 ? dataMaxX : (c + centers[i + 1]) / 2;
      return [l, r];
    });
  }

  if (baseColBounds.length === 0) return [];

  // Split any merged column (e.g. "Post DO | QC Hold") by checking for an internal vertical border
  // in the data rows below, falling back to the widest middle header word gap
  const refinedColBounds: Array<[number, number]> = [];
  for (const [cl, cr] of baseColBounds) {
    const colWords = headerRow.words.filter((w) => w.xCenter >= cl && w.xCenter <= cr);
    let splitX: number | null = null;
    if (colWords.length >= 4 && cr - cl > 130) {
      // First look for a faint physical vertical border in the data rows inside the middle zone
      const midMin = cl + (cr - cl) * 0.25;
      const midMax = cr - (cr - cl) * 0.25;
      const dataRowXs: number[] = [];
      for (let dr = headerRowIdx + 1; dr < Math.min(targetBlock.length, headerRowIdx + 4); dr++) {
        const drInfo = targetBlock[dr];
        const ctx = cleanCanvas.getContext('2d')!;
        const y0 = Math.max(0, Math.round(drInfo.yCenter - typicalStep * 0.42));
        const y1 = Math.min(cleanCanvas.height - 1, Math.round(drInfo.yCenter + typicalStep * 0.42));
        const rowH = y1 - y0;
        if (rowH < 8) continue;
        const d = ctx.getImageData(0, y0, cleanCanvas.width, rowH).data;
        let bestX = -1;
        let bestScore = 0;
        for (let x = Math.round(midMin); x <= Math.round(midMax); x++) {
          let hits = 0;
          for (let y = 0; y < rowH; y++) {
            const lum = d[(y * cleanCanvas.width + x) * 4];
            const lumL = d[(y * cleanCanvas.width + (x - 3)) * 4];
            const lumR = d[(y * cleanCanvas.width + (x + 3)) * 4];
            if (lum < 232 && lumL - lum > 4 && lumR - lum > 4) hits++;
          }
          const sc = hits / rowH;
          if (sc > bestScore) {
            bestScore = sc;
            bestX = x;
          }
        }
        if (bestScore >= 0.35 && bestX !== -1) dataRowXs.push(bestX);
      }

      if (dataRowXs.length >= 1) {
        splitX = Math.round(dataRowXs.reduce((s, v) => s + v, 0) / dataRowXs.length);
      } else {
        let bestGap = 0;
        let bestPair: [OcrWord, OcrWord] | null = null;
        for (let i = 0; i < colWords.length - 1; i++) {
          const gapMid = (colWords[i].x1 + colWords[i + 1].x0) / 2;
          if (gapMid < midMin || gapMid > midMax) continue;
          const gap = colWords[i + 1].x0 - colWords[i].x1;
          if (gap > bestGap) {
            bestGap = gap;
            bestPair = [colWords[i], colWords[i + 1]];
          }
        }
        if (bestPair && bestGap >= 8) {
          splitX = Math.round((bestPair[0].x1 + bestPair[1].x0) / 2);
        }
      }
    }
    if (splitX !== null) {
      refinedColBounds.push([cl, splitX], [splitX, cr]);
    } else {
      refinedColBounds.push([cl, cr]);
    }
  }
  baseColBounds = refinedColBounds;

  // 5. Re-read every cell individually on the de-moiréd canvas using local row border tracking!
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: '',
  });

  const matrix: string[][] = [];
  let prevRowBounds = baseColBounds;

  for (let r = 0; r < targetBlock.length; r++) {
    const rowInfo = targetBlock[r];
    onProgress?.(
      `Digitizing row ${r + 1} of ${targetBlock.length}...`,
      65 + Math.round(((r + 1) / targetBlock.length) * 30)
    );

    const rowYTop = rowInfo.yCenter - typicalStep * 0.48;
    const rowYBot = rowInfo.yCenter + typicalStep * 0.48;

    // Nudge column borders to local vertical borders on this specific row (handles tilted camera photos!)
    const localBorders = detectRowVerticalBorders(
      cleanCanvas,
      rowYTop,
      rowYBot,
      dataMinX - 10,
      dataMaxX + 10
    ).filter((bx) => !rowInfo.words.some((w) => bx > w.x0 + 4 && bx < w.x1 - 4));

    const rowBounds: Array<[number, number]> = prevRowBounds.map(([cl, cr]) => {
      let nL = cl;
      let nR = cr;
      if (localBorders.length >= 2) {
        const matchL = localBorders.find((bx) => Math.abs(bx - cl) < 28);
        const matchR = localBorders.find((bx) => Math.abs(bx - cr) < 28);
        if (matchL !== undefined) nL = matchL;
        if (matchR !== undefined) nR = matchR;
      }
      return [nL, nR];
    });
    // Prevent slicing trailing characters of a wide text word (e.g. "JAGIR", "MARREDPALLY") at Col 0/Col 1 border
    for (let c = 0; c < rowBounds.length - 1; c++) {
      const [cl, cr] = rowBounds[c];
      const spillingWord = rowInfo.words.find(
        (w) => w.text.length >= 3 && w.xCenter >= cl && w.xCenter <= cr + 6 && w.x1 > cr - 2
      );
      if (spillingWord) {
        const nextCr = rowBounds[c + 1][1];
        const safeRight = Math.min(nextCr - 12, spillingWord.x1 + 5);
        if (safeRight > cr) {
          rowBounds[c][1] = safeRight;
          rowBounds[c + 1][0] = safeRight;
        }
      }
    }
    prevRowBounds = rowBounds;

    const rowCells = new Array<string>(rowBounds.length).fill('');
    for (let c = 0; c < rowBounds.length; c++) {
      const [cl, cr] = rowBounds[c];

      // For header rows (r <= headerRowIdx), Pass 1 full-context words are cleaner than tiny shaded crops
      if (r <= headerRowIdx) {
        const pass1Text = rowInfo.words
          .filter((w) => w.xCenter >= cl && w.xCenter <= cr)
          .map((w) => w.text)
          .join(' ')
          .replace(/\s+[vVyY>]$/, '')
          .trim();
        if (pass1Text !== '') {
          rowCells[c] = pass1Text;
          continue;
        }
      }

      const cellUrl = cropCleanCellDataUrl(cleanCanvas, cl, cr, rowYTop, rowYBot);
      if (!cellUrl) {
        rowCells[c] = '';
        continue;
      }

      const cellRes = await worker.recognize(cellUrl);
      let text = (cellRes.data.text || '')
        .replace(/\r?\n/g, ' ')
        .replace(/[|_[\]{}~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (
        r > headerRowIdx &&
        c >= 1 &&
        (text === '' || /^[^a-zA-Z0-9]+$/.test(text))
      ) {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_WORD,
          tessedit_char_whitelist: '0123456789',
        });
        const digitRes = await worker.recognize(cellUrl);
        const dText = (digitRes.data.text || '').replace(/[^0-9]/g, '').trim();
        if (dText !== '') text = dText;
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_LINE,
          tessedit_char_whitelist: '',
        });
      }

      if (r <= headerRowIdx) {
        text = text.replace(/\s+[vVyY>]$/, '').trim();
      }

      rowCells[c] = text;
    }

    if (rowCells.some((c) => c !== '')) {
      matrix.push(rowCells);
    }
  }

  // 6. Drop completely empty columns
  const keepCols: number[] = [];
  for (let c = 0; c < baseColBounds.length; c++) {
    if (matrix.some((row) => (row[c] ?? '') !== '')) {
      keepCols.push(c);
    }
  }

  const pruned = matrix.map((row) => keepCols.map((c) => row[c] ?? ''));

  // 7. Detect numeric columns (cols >= 1 where most non-empty cells look numeric or header is a count/total)
  //    and re-read non-digit artifacts with strict digit whitelist
  const colCount = keepCols.length;
  for (let c = 1; c < colCount; c++) {
    const dataCells = pruned.slice(headerRowIdx + 1).map((r) => r[c] ?? '').filter(Boolean);
    const numLikeCells = dataCells.filter((v) => /\d/.test(v));
    const headerLabel = pruned[headerRowIdx]?.[c] ?? '';
    const isCountHeader = /prep|post|hold|submitted|total|count|qty|amount/i.test(headerLabel);
    if (
      dataCells.length >= 1 &&
      (numLikeCells.length >= dataCells.length * 0.45 || isCountHeader)
    ) {
      const origColIdx = keepCols[c];
      for (let r = headerRowIdx + 1; r < targetBlock.length && r < pruned.length; r++) {
        const curVal = pruned[r][c] ?? '';
        if (curVal !== '' && !/^\d+$/.test(curVal)) {
          const rowInfo = targetBlock[r];
          const [cl, cr] = prevRowBounds[origColIdx] || baseColBounds[origColIdx];
          const cellUrl = cropCleanCellDataUrl(
            cleanCanvas,
            cl,
            cr,
            rowInfo.yCenter - typicalStep * 0.48,
            rowInfo.yCenter + typicalStep * 0.48
          );
          if (cellUrl) {
            await worker.setParameters({
              tessedit_pageseg_mode: PSM.SINGLE_WORD,
              tessedit_char_whitelist: '0123456789',
            });
            const dRes = await worker.recognize(cellUrl);
            const digits = (dRes.data.text || '').replace(/[^0-9]/g, '').trim();
            pruned[r][c] = digits;
          } else {
            pruned[r][c] = '';
          }
        }
      }
    }
  }

  // 8. If the last row is a Grand Total row and any numeric column cell is blank,
  //    fill it deterministically from the vertical column sum above it
  const lastIdx = pruned.length - 1;
  if (lastIdx >= headerRowIdx + 2 && /\bgrand\s*total\b/i.test(pruned[lastIdx][0] ?? '')) {
    for (let c = 1; c < colCount; c++) {
      if ((pruned[lastIdx][c] ?? '') === '') {
        let colSum = 0;
        let hasNums = false;
        for (let r = headerRowIdx + 1; r < lastIdx; r++) {
          const val = parseInt(pruned[r][c] ?? '', 10);
          if (Number.isFinite(val)) {
            colSum += val;
            hasNums = true;
          }
        }
        if (hasNums) {
          pruned[lastIdx][c] = String(colSum);
        }
      }
    }
  }

  return pruned;
}
