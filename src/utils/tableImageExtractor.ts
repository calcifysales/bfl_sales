import { createWorker, PSM } from 'tesseract.js';
import { loadImageElement } from './ocrExtractor';
import {
  checkTableSumDiscrepancies,
  cleanCellPatchAndCheckEmpty,
  deMoireDirectional,
  detectBorderedTableGrid,
  detectVerticalGridLines,
  estimateSkewAngleDeg,
  evaluateCellConfidenceAndFlags,
  isIdentifierHeader,
  isStrictNumericHeader,
  looksLikeStringIdValue,
  normalizeForGridDetection,
  normalizeIlluminationAndGlare,
  rgbaToLuminance,
  rotateRgbaBilinear,
  sauvolaAdaptiveThreshold,
  warpRgbaPerspective,
  type CornerPoints,
  type ExtractedCell,
} from './tableVisionCore';

export type { CornerPoints, ExtractedCell };

export interface ExtractedTableResult {
  matrix: string[][];
  cells: ExtractedCell[][];
  headers: string[];
  averageConfidence: number;
  uncertainCount: number;
  rowIntegrityWarnings: string[];
  originalImageUrl: string;
  dewarpedImageUrl: string;
  dewarpedDimensions: { width: number; height: number };
  skewAngleDeg: number;
  canReconstructReliably: boolean;
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
 * Extracts a structured text/table matrix + per-cell confidence & source-photo crops
 * from a camera photo or screenshot without silently altering IDs or inventing missing data.
 */
export async function extractTableMatrixFromImage(
  imageDataUrl: string,
  onProgress?: TableProgressCallback,
  options: { customCorners?: CornerPoints } = {}
): Promise<ExtractedTableResult> {
  onProgress?.('Preparing perspective dewarp & de-moiré...', 10);
  const img = await loadImageElement(imageDataUrl);

  // Build normalized working RGBA buffer (upscale small screenshots, cap large photos at 2000px)
  const targetMax = Math.max(img.naturalWidth, img.naturalHeight) < 1200 ? 1900 : 2000;
  const scale = Math.min(2.6, targetMax / Math.max(img.naturalWidth, img.naturalHeight));
  let w = Math.max(1, Math.round(img.naturalWidth * scale));
  let h = Math.max(1, Math.round(img.naturalHeight * scale));

  const workCanvas = document.createElement('canvas');
  workCanvas.width = w;
  workCanvas.height = h;
  const wCtx = workCanvas.getContext('2d')!;
  wCtx.imageSmoothingEnabled = true;
  wCtx.imageSmoothingQuality = 'high';
  wCtx.drawImage(img, 0, 0, w, h);

  let rgba = wCtx.getImageData(0, 0, w, h).data;
  let skewAngleDeg = 0;

  // Step 1: Perspective correction (manual 4-corner quad if provided) + automatic deskew
  if (options.customCorners) {
    const c = options.customCorners;
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
    const dstW = Math.max(240, Math.min(2200, Math.round((dist(c.tl, c.tr) + dist(c.bl, c.br)) / 2)));
    const dstH = Math.max(200, Math.min(2200, Math.round((dist(c.tl, c.bl) + dist(c.tr, c.br)) / 2)));
    rgba = warpRgbaPerspective(rgba, w, h, c, dstW, dstH);
    w = dstW;
    h = dstH;
  } else {
    const rawLum = rgbaToLuminance(rgba, w, h);
    skewAngleDeg = estimateSkewAngleDeg(rawLum, w, h);
    if (Math.abs(skewAngleDeg) >= 0.35) {
      rgba = rotateRgbaBilinear(rgba, w, h, skewAngleDeg);
    }
  }

  // Keep a clean RGB canvas of the dewarped original image as visual source-of-truth for cell crops
  const dewarpedOrigCanvas = document.createElement('canvas');
  dewarpedOrigCanvas.width = w;
  dewarpedOrigCanvas.height = h;
  dewarpedOrigCanvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const dewarpedImageUrl = dewarpedOrigCanvas.toDataURL('image/jpeg', 0.92);

  // Detect dark monitor bezel/taskbar at bottom (must be a contiguous >=18px dark band, never a 1-3px gridline!)
  let cutBottomY = h;
  let darkRun = 0;
  for (let y = Math.floor(h * 0.72); y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 4) {
      const i = (y * w + x) * 4;
      rowSum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    if (rowSum / (w / 4) < 115) {
      darkRun++;
      if (darkRun >= 18) {
        cutBottomY = Math.max(0, y - darkRun - 4);
        break;
      }
    } else {
      darkRun = 0;
    }
  }

  // Step 2: Directional de-moiré + grid-preserving normalization + OCR illumination normalization
  const lum0 = rgbaToLuminance(rgba, w, h);
  const deMoired = deMoireDirectional(lum0, w, h);
  const gridLum = normalizeForGridDetection(deMoired, w, h);
  const cleanLum = normalizeIlluminationAndGlare(deMoired, w, h);

  // Mask bottom dark taskbar region on cleanLum
  for (let y = cutBottomY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      cleanLum[y * w + x] = 255;
    }
  }

  // Build normalized grayscale canvas for Pass 1 layout OCR
  const cleanCanvas = document.createElement('canvas');
  cleanCanvas.width = w;
  cleanCanvas.height = h;
  const cleanRgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < cleanLum.length; i++, p += 4) {
    const v = cleanLum[i];
    cleanRgba[p] = v;
    cleanRgba[p + 1] = v;
    cleanRgba[p + 2] = v;
    cleanRgba[p + 3] = 255;
  }
  cleanCanvas.getContext('2d')!.putImageData(new ImageData(cleanRgba, w, h), 0, 0);

  onProgress?.('Detecting table structure & text...', 30);
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        onProgress?.('Reading table layout...', 32 + Math.round(m.progress * 26));
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

    onProgress?.('Segmenting cells & checking confidence...', 62);
    const extracted = await buildStructuredCells(
      words,
      gridLum,
      cleanLum,
      dewarpedOrigCanvas,
      w,
      h,
      cutBottomY,
      worker,
      onProgress
    );

    const matrix = extracted.cells.map((row) => row.map((cell) => cell.value));
    const headers = extracted.headerRowIdx >= 0 && matrix[extracted.headerRowIdx]
      ? matrix[extracted.headerRowIdx]
      : matrix[0] || [];

    const allFlat = extracted.cells.flat();
    const nonEmptyCells = allFlat.filter((c) => c.value !== '' || c.uncertain);
    const avgConf =
      nonEmptyCells.length > 0
        ? Math.round(nonEmptyCells.reduce((s, c) => s + c.confidence, 0) / nonEmptyCells.length)
        : Math.round(res.data.confidence || 0);
    const uncertainCount = allFlat.filter((c) => c.uncertain).length;
    const canReconstructReliably =
      matrix.length >= 2 && (matrix[0]?.length ?? 0) >= 2 && avgConf >= 45;

    return {
      matrix,
      cells: extracted.cells,
      headers,
      averageConfidence: avgConf,
      uncertainCount,
      rowIntegrityWarnings: extracted.rowIntegrityWarnings,
      originalImageUrl: imageDataUrl,
      dewarpedImageUrl,
      dewarpedDimensions: { width: w, height: h },
      skewAngleDeg,
      canReconstructReliably,
      notes: canReconstructReliably
        ? `Extracted ${matrix.length} rows × ${matrix[0].length} columns (avg confidence ${avgConf}%, ${uncertainCount} flagged for review).`
        : 'Table structure could not be reliably reconstructed. Use 4-corner crop or manual editing.',
    };
  } finally {
    await worker.terminate();
  }
}

function patchLumToOcrDataUrl(
  patchLum: Float32Array,
  cw: number,
  ch: number,
  useSauvola = false
): string {
  const tmp = document.createElement('canvas');
  tmp.width = cw;
  tmp.height = ch;
  const rgba = new Uint8ClampedArray(cw * ch * 4);

  if (useSauvola) {
    const bin = sauvolaAdaptiveThreshold(patchLum, cw, ch, 10, 0.18);
    for (let i = 0, p = 0; i < bin.length; i++, p += 4) {
      rgba[p] = bin[i];
      rgba[p + 1] = bin[i];
      rgba[p + 2] = bin[i];
      rgba[p + 3] = 255;
    }
  } else {
    for (let i = 0, p = 0; i < patchLum.length; i++, p += 4) {
      const v = Math.max(0, Math.min(255, patchLum[i]));
      rgba[p] = v;
      rgba[p + 1] = v;
      rgba[p + 2] = v;
      rgba[p + 3] = 255;
    }
  }
  tmp.getContext('2d')!.putImageData(new ImageData(rgba, cw, ch), 0, 0);

  const scale = ch < 40 ? 2.4 : 1.6;
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

function cropOriginalCellSnippet(
  origCanvas: HTMLCanvasElement,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): string {
  const sx = Math.max(0, Math.round(x0));
  const sy = Math.max(0, Math.round(y0));
  const sw = Math.max(8, Math.min(origCanvas.width - sx, Math.round(x1 - x0)));
  const sh = Math.max(8, Math.min(origCanvas.height - sy, Math.round(y1 - y0)));

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d')!.drawImage(origCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/jpeg', 0.9);
}

async function buildStructuredCells(
  allWords: OcrWord[],
  gridLum: Float32Array,
  _cleanLum: Float32Array,
  origCanvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  maxY: number,
  worker: Awaited<ReturnType<typeof createWorker>>,
  onProgress?: TableProgressCallback
): Promise<{
  cells: ExtractedCell[][];
  headerRowIdx: number;
  rowIntegrityWarnings: string[];
}> {
  // 1. Cluster Pass 1 words (when available) solely to locate candidate table hint region
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

  // Strip Excel left row-number gutter (ascending integers e.g. 30, 31, 32...)
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

  // Filter Excel UI chrome rows (A B C D E F, Sheet1/Sheet2, Workbook Statistics, fx bar)
  const filteredRows: Array<{ words: OcrWord[]; yCenter: number }> = [];
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
    filteredRows.push({ words: rowWords, yCenter });
  }

  let targetBlock: typeof filteredRows = [];
  let typicalStep = medianH * 1.9;
  if (filteredRows.length > 0) {
    const ySteps: number[] = [];
    for (let i = 1; i < filteredRows.length; i++) {
      const step = filteredRows[i].yCenter - filteredRows[i - 1].yCenter;
      if (step > medianH * 0.8 && step < medianH * 3.5) ySteps.push(step);
    }
    if (ySteps.length > 0) {
      typicalStep = ySteps.sort((a, b) => a - b)[Math.floor(ySteps.length / 2)];
    }

    const blocks: Array<typeof filteredRows> = [[filteredRows[0]]];
    for (let i = 1; i < filteredRows.length; i++) {
      const gap = filteredRows[i].yCenter - filteredRows[i - 1].yCenter;
      if (gap > typicalStep * 2.0) {
        blocks.push([filteredRows[i]]);
      } else {
        blocks[blocks.length - 1].push(filteredRows[i]);
      }
    }

    targetBlock = blocks[0];
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
  }

  // 2. Grid-first pixel geometry detection (does NOT drop rows/columns missed by Pass 1!)
  const hintBox =
    targetBlock.length > 0
      ? {
          hintX0: Math.max(
            gutterRightX,
            Math.min(...targetBlock.flatMap((r) => r.words.map((w) => w.x0))) - 18
          ),
          hintX1: Math.min(
            imgW - 2,
            Math.max(...targetBlock.flatMap((r) => r.words.map((w) => w.x1))) + 18
          ),
          hintY0: Math.max(2, targetBlock[0].yCenter - typicalStep * 0.6),
          hintY1: Math.min(maxY - 2, targetBlock[targetBlock.length - 1].yCenter + typicalStep * 0.6),
          maxY,
        }
      : { hintX0: gutterRightX, hintX1: imgW - 2, maxY };

  const gridGeom = detectBorderedTableGrid(gridLum, imgW, imgH, hintBox);

  let rowBounds: Array<[number, number]> = [];
  let colBounds: Array<[number, number]> = [];

  if (gridGeom && gridGeom.rowYs.length >= 3 && gridGeom.colXs.length >= 3) {
    for (let r = 0; r < gridGeom.rowYs.length - 1; r++) {
      if (gridGeom.rowYs[r + 1] - gridGeom.rowYs[r] >= 14) {
        rowBounds.push([gridGeom.rowYs[r], gridGeom.rowYs[r + 1]]);
      }
    }
    for (let c = 0; c < gridGeom.colXs.length - 1; c++) {
      if (gridGeom.colXs[c + 1] - gridGeom.colXs[c] >= 24) {
        colBounds.push([gridGeom.colXs[c], gridGeom.colXs[c + 1]]);
      }
    }
  } else {
    // Fallback for borderless tables using Pass 1 row/column word clusters
    if (targetBlock.length === 0) {
      return { cells: [], headerRowIdx: 0, rowIntegrityWarnings: [] };
    }
    rowBounds = targetBlock.map((r) => [
      Math.max(0, r.yCenter - typicalStep * 0.48),
      Math.min(maxY, r.yCenter + typicalStep * 0.48),
    ]);
    const headerCandidate = targetBlock[0];
    const groups: OcrWord[][] = [];
    for (const w of headerCandidate.words) {
      const prev = groups[groups.length - 1];
      if (prev && w.x0 - prev[prev.length - 1].x1 < Math.max(26, medianH * 1.4)) {
        prev.push(w);
      } else {
        groups.push([w]);
      }
    }
    const centers = groups.map((g) => (g[0].x0 + g[g.length - 1].x1) / 2);
    const minX = hintBox.hintX0 ?? gutterRightX;
    const maxX = hintBox.hintX1 ?? imgW;
    colBounds = centers.map((c, i) => [
      i === 0 ? minX : (centers[i - 1] + c) / 2,
      i === centers.length - 1 ? maxX : (c + centers[i + 1]) / 2,
    ]);
  }

  if (rowBounds.length === 0 || colBounds.length === 0) {
    return { cells: [], headerRowIdx: 0, rowIntegrityWarnings: [] };
  }

  // Check if Row 0 is a merged Pivot banner row (fewer internal vertical dividers than body rows)
  let row0MergedSpanStart: number | null = null;
  if (rowBounds.length >= 4 && colBounds.length >= 4) {
    const [r0Top, r0Bot] = rowBounds[0];
    const r0Borders = detectVerticalGridLines(
      gridLum,
      imgW,
      imgH,
      r0Top + 3,
      r0Bot - 3,
      colBounds[0][0] - 4,
      colBounds[colBounds.length - 1][1] + 4,
      0.55
    );
    if (r0Borders.length <= 3) {
      row0MergedSpanStart = colBounds.length >= 2 ? 1 : 0;
    }
  }

  // 3. Read EVERY cell via padded high-res cell OCR + Sauvola fallback (ZERO silent substitution)
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: '',
  });

  type RawCellRead = {
    value: string;
    rawConf: number;
    contrastSnr: number;
    box: { x0: number; y0: number; x1: number; y1: number };
    sourceCropDataUrl?: string;
  };

  const rawTable: RawCellRead[][] = [];

  for (let r = 0; r < rowBounds.length; r++) {
    const [rowYTop, rowYBot] = rowBounds[r];
    onProgress?.(
      `Extracting & scoring row ${r + 1} of ${rowBounds.length}...`,
      64 + Math.round(((r + 1) / rowBounds.length) * 32)
    );

    const rowReads: RawCellRead[] = [];

    for (let c = 0; c < colBounds.length; c++) {
      let [cl, cr] = colBounds[c];
      let skipMergedCell = false;

      // Handle Pivot banner Row 0 merged right-side span ("Stage" centered across cols 1..last)
      if (r === 0 && row0MergedSpanStart !== null) {
        if (c === row0MergedSpanStart) {
          cr = colBounds[colBounds.length - 1][1];
        } else if (c > row0MergedSpanStart) {
          skipMergedCell = true;
        }
      }

      const box = {
        x0: Math.max(0, cl),
        y0: Math.max(0, rowYTop),
        x1: Math.min(imgW, cr),
        y1: Math.min(imgH, rowYBot),
      };

      if (skipMergedCell) {
        rowReads.push({ value: '', rawConf: 100, contrastSnr: 0, box });
        continue;
      }

      const ink = cleanCellPatchAndCheckEmpty(gridLum, imgW, imgH, cl, cr, rowYTop, rowYBot);
      if (ink.isEmpty) {
        rowReads.push({ value: '', rawConf: 100, contrastSnr: ink.contrastSnr, box });
        continue;
      }

      const cellUrl = patchLumToOcrDataUrl(ink.patchLum, ink.patchW, ink.patchH, false);
      const cellRes = await worker.recognize(cellUrl);
      let text = (cellRes.data.text || '')
        .replace(/\r?\n/g, ' ')
        .replace(/[|_[\]{}~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      let conf = Math.round(cellRes.data.confidence || 0);

      // Retry with Sauvola adaptive thresholding when uncertain or empty
      if (text === '' || conf < 80 || /^[^a-zA-Z0-9]+$/.test(text)) {
        const sauvolaUrl = patchLumToOcrDataUrl(ink.patchLum, ink.patchW, ink.patchH, true);
        const sRes = await worker.recognize(sauvolaUrl);
        const sText = (sRes.data.text || '')
          .replace(/\r?\n/g, ' ')
          .replace(/[|_[\]{}~`]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        const sConf = Math.round(sRes.data.confidence || 0);
        if (sText !== '' && (text === '' || /^[^a-zA-Z0-9]+$/.test(text) || sConf > conf)) {
          text = sText;
          conf = sConf;
        }
      }

      // Clean trailing Excel filter arrow glyph only on header rows
      if (r <= 1) {
        text = text.replace(/\s+[vVyY>]$/, '').trim();
      }

      // Treat pure border-line punctuation artifacts (no alphanumeric characters) as empty
      if (text !== '' && !/[a-zA-Z0-9]/.test(text)) {
        text = '';
        conf = 100;
      }

      rowReads.push({
        value: text,
        rawConf: conf,
        contrastSnr: ink.contrastSnr,
        box,
        sourceCropDataUrl: cropOriginalCellSnippet(origCanvas, box.x0, box.y0, box.x1, box.y1),
      });
    }

    if (rowReads.some((cell) => cell.value !== '')) {
      rawTable.push(rowReads);
    }
  }

  // Drop trailing/interior completely empty columns
  const keepCols: number[] = [];
  for (let c = 0; c < colBounds.length; c++) {
    if (rawTable.some((row) => (row[c]?.value ?? '') !== '')) {
      keepCols.push(c);
    }
  }
  const prunedRaw = rawTable.map((row) => keepCols.map((c) => row[c]));

  // Trim any noise fragment rows below a Grand Total summary footer row (e.g. Excel cursor box)
  const gtIdx = prunedRaw.findIndex((row) =>
    /^\s*(grand\s*total|total)\s*$/i.test(row[0]?.value ?? '')
  );
  if (gtIdx >= 2 && gtIdx < prunedRaw.length - 1) {
    prunedRaw.splice(gtIdx + 1);
  }

  // Drop narrow far-left Excel row-number gutter column if present (e.g. sequential 30..47)
  if (prunedRaw.length >= 4 && prunedRaw[0].length >= 4) {
    const col0Sample = prunedRaw.slice(1).map((r) => r[0].value.trim());
    const col0Box = prunedRaw[0][0].box;
    const isNarrowLeft = col0Box.x0 < imgW * 0.08 && col0Box.x1 - col0Box.x0 < imgW * 0.06;
    const numericOrShortCount = col0Sample.filter((v) => /^\d{1,3}$/.test(v) || v.length <= 2).length;
    if (isNarrowLeft && numericOrShortCount >= col0Sample.length * 0.65) {
      prunedRaw.forEach((row) => row.shift());
    }
  }

  // 4. Identify true column header row (row 0 vs row 1 if row 0 is merged Pivot banner)
  let headerRowIdx = 0;
  if (prunedRaw.length >= 3) {
    const r0NonEmpty = prunedRaw[0].filter((c) => c.value !== '').length;
    const r1NonEmpty = prunedRaw[1].filter((c) => c.value !== '').length;
    const r1Joined = prunedRaw[1].map((c) => c.value).join(' ');
    if (
      r1NonEmpty > r0NonEmpty &&
      /\b(dealer|deal\s*id|issued|opportunity|owner|stage|preparation|post\s*do|submitted|grand\s*total|hold)\b/i.test(
        r1Joined
      )
    ) {
      headerRowIdx = 1;
    }
  }

  // 5. Evaluate confidence & string-ID / ambiguity flags against true column headers
  const headers = (prunedRaw[headerRowIdx] || []).map((c) => c.value);
  const finalCells: ExtractedCell[][] = prunedRaw.map((row, r) =>
    row.map((cell, c) => {
      const headerLabel = headers[c] ?? '';
      const isIdCol = isIdentifierHeader(headerLabel);
      const isNumCol = !isIdCol && isStrictNumericHeader(headerLabel);
      const idColDetected = isIdCol || looksLikeStringIdValue(cell.value);

      const evalRes = evaluateCellConfidenceAndFlags({
        value: cell.value,
        ocrConfidence: cell.rawConf,
        contrastSnr: cell.contrastSnr,
        isIdColumn: idColDetected,
        isNumericColumn: isNumCol && !idColDetected,
        isHeaderRow: r <= headerRowIdx,
      });

      return {
        value: cell.value,
        confidence: evalRes.confidence,
        uncertain: evalRes.uncertain,
        reasons: evalRes.reasons,
        isIdColumn: idColDetected,
        sourceBox: cell.box,
        sourceCropDataUrl: cell.sourceCropDataUrl,
      };
    })
  );

  // 6. Run sum discrepancy check (flags mismatches without ever inventing or editing data!)
  const rowIntegrityWarnings = checkTableSumDiscrepancies(finalCells, headerRowIdx);

  return {
    cells: finalCells,
    headerRowIdx,
    rowIntegrityWarnings,
  };
}
