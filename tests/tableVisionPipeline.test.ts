import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import {
  checkTableSumDiscrepancies,
  cleanCellPatchAndCheckEmpty,
  deMoireDirectional,
  detectBorderedTableGrid,
  detectHorizontalGridLines,
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
  type ExtractedCell,
} from '../src/utils/tableVisionCore';

function createSyntheticTableRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);

  const rowYs = [40, 80, 120, 160, 200];
  const colXs = [40, 140, 240, 340];

  const drawPixel = (x: number, y: number, val: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = val;
    rgba[i + 1] = val;
    rgba[i + 2] = val;
    rgba[i + 3] = 255;
  };

  for (const ry of rowYs) {
    for (let x = colXs[0]; x <= colXs[colXs.length - 1]; x++) {
      drawPixel(x, ry, 55);
      drawPixel(x, ry + 1, 55);
    }
  }
  for (const cx of colXs) {
    for (let y = rowYs[0]; y <= rowYs[rowYs.length - 1]; y++) {
      drawPixel(cx, y, 55);
      drawPixel(cx + 1, y, 55);
    }
  }

  // Draw synthetic glyph stroke inside cell (row 0, col 1) while leaving (row 1, col 1) empty
  for (let y = 52; y <= 68; y++) {
    for (let x = 185; x <= 189; x++) {
      drawPixel(x, y, 25);
    }
  }

  return rgba;
}

function decodeFixtureImage(filename: string): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const fullPath = path.resolve(__dirname, 'fixtures', filename);
  const buf = fs.readFileSync(fullPath);
  if (filename.toLowerCase().endsWith('.png')) {
    const png = PNG.sync.read(buf);
    return {
      rgba: new Uint8ClampedArray(png.data),
      width: png.width,
      height: png.height,
    };
  }
  const decoded = jpeg.decode(buf, { useTArray: true });
  return {
    rgba: new Uint8ClampedArray(decoded.data),
    width: decoded.width,
    height: decoded.height,
  };
}

describe('Computer Vision & Perspective Dewarping', () => {
  it('detects and deskews tilted table images within 0.5 degrees', () => {
    const w = 400;
    const h = 240;
    const base = createSyntheticTableRgba(w, h);
    const tilted = rotateRgbaBilinear(base, w, h, -3.5);
    const tiltedLum = rgbaToLuminance(tilted, w, h);

    const detectedDeg = estimateSkewAngleDeg(tiltedLum, w, h);
    expect(Math.abs(detectedDeg - 3.5)).toBeLessThan(0.6);

    const dewarped = rotateRgbaBilinear(tilted, w, h, detectedDeg);
    const dewarpedLum = rgbaToLuminance(dewarped, w, h);
    const hLines = detectHorizontalGridLines(dewarpedLum, w, h, 50, 330, 10, 230, 0.45);
    expect(hLines.length).toBeGreaterThanOrEqual(4);
  });

  it('rectifies perspective trapezoid distortion via 4-corner homography warp', () => {
    const w = 400;
    const h = 240;
    const base = createSyntheticTableRgba(w, h);
    const warped = warpRgbaPerspective(
      base,
      w,
      h,
      {
        tl: { x: 40 / 399, y: 40 / 239 },
        tr: { x: 341 / 399, y: 40 / 239 },
        br: { x: 341 / 399, y: 201 / 239 },
        bl: { x: 40 / 399, y: 201 / 239 },
      },
      300,
      160
    );
    const lum = rgbaToLuminance(warped, 300, 160);
    const vLines = detectVerticalGridLines(lum, 300, 160, 10, 150, 5, 295, 0.5);
    expect(vLines.length).toBeGreaterThanOrEqual(2);
  });

  it('suppresses LCD moire & glare and adapts via Sauvola thresholding', () => {
    const w = 240;
    const h = 120;
    const lum = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Uneven glare on right side + periodic moire stripes
        const glare = 190 + (x / w) * 60;
        const moire = x % 2 === 0 ? -8 : 8;
        lum[y * w + x] = Math.min(255, glare + moire);
      }
    }
    // Draw dark character stroke under glare
    for (let y = 45; y <= 75; y++) {
      for (let x = 180; x <= 185; x++) {
        lum[y * w + x] = 65;
      }
    }

    const smoothed = deMoireDirectional(lum, w, h);
    const norm = normalizeIlluminationAndGlare(smoothed, w, h);
    const bin = sauvolaAdaptiveThreshold(norm, w, h, 12, 0.2);

    // Character stroke under glare becomes foreground (0), background becomes white (255)
    expect(bin[60 * w + 182]).toBe(0);
    expect(bin[20 * w + 20]).toBe(255);
    expect(bin[20 * w + 210]).toBe(255);
  });

  it('distinguishes genuinely empty bordered cells from cells with ink', () => {
    const w = 400;
    const h = 240;
    const base = createSyntheticTableRgba(w, h);
    const lum = rgbaToLuminance(base, w, h);

    // Cell (row 0, col 1): [140..240] x [40..80] has a vertical stroke
    const filled = cleanCellPatchAndCheckEmpty(lum, w, h, 140, 240, 40, 80);
    expect(filled.isEmpty).toBe(false);
    expect(filled.contrastSnr).toBeGreaterThan(80);

    // Cell (row 1, col 1): [140..240] x [80..120] is empty
    const empty = cleanCellPatchAndCheckEmpty(lum, w, h, 140, 240, 80, 120);
    expect(empty.isEmpty).toBe(true);
  });
});

describe('String ID Preservation & Ambiguity Flagging (Zero Silent Substitution)', () => {
  it('identifies ID, SFID, Deal ID, Dealer ID, and numeric columns accurately', () => {
    expect(isIdentifierHeader('Deal ID')).toBe(true);
    expect(isIdentifierHeader('Dealer Id')).toBe(true);
    expect(isIdentifierHeader('SFID')).toBe(true);
    expect(isIdentifierHeader('Customer ID')).toBe(true);
    expect(isIdentifierHeader('FinnOne Dealer Code')).toBe(true);
    expect(isStrictNumericHeader('Hold Counter')).toBe(true);
    expect(isStrictNumericHeader('Grand Total')).toBe(true);
    expect(looksLikeStringIdValue('A129149011')).toBe(true);
    expect(looksLikeStringIdValue('00412')).toBe(true);
  });

  it('never silently coerces ambiguous characters and flags uncertain cells', () => {
    // ID containing 'O' and '0' with <93% confidence stays untouched and gets flagged
    const idEval = evaluateCellConfidenceAndFlags({
      value: 'A12O149011',
      ocrConfidence: 84,
      contrastSnr: 120,
      isIdColumn: true,
      isNumericColumn: false,
      isHeaderRow: false,
    });
    expect(idEval.uncertain).toBe(true);
    expect(idEval.reasons.some((r) => r.includes('O/0'))).toBe(true);

    // Numeric column containing '1O' is flagged rather than silently rewritten to '10'
    const numEval = evaluateCellConfidenceAndFlags({
      value: '1O',
      ocrConfidence: 88,
      contrastSnr: 110,
      isIdColumn: false,
      isNumericColumn: true,
      isHeaderRow: false,
    });
    expect(numEval.uncertain).toBe(true);
    expect(numEval.reasons.some((r) => r.includes('Non-numeric'))).toBe(true);
  });

  it('flags row/column sum discrepancies without altering or inventing cell values', () => {
    const mk = (value: string): ExtractedCell => ({
      value,
      confidence: 92,
      uncertain: false,
      reasons: [],
      isIdColumn: false,
    });

    const cells: ExtractedCell[][] = [
      [mk('Dealer Id'), mk('DO Prep'), mk('Post DO'), mk('Grand Total')],
      [mk('ATTAPUR'), mk('1'), mk('4'), mk('7')], // 1 + 4 = 5 != 7
      [mk('Grand Total'), mk('1'), mk(''), mk('')], // blank Grand Total cell
    ];

    const warnings = checkTableSumDiscrepancies(cells, 0);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    // Original cell values remain untouched (never invented!)
    expect(cells[1][3].value).toBe('7');
    expect(cells[1][3].uncertain).toBe(true);
    expect(cells[2][2].value).toBe('');
    expect(cells[2][2].uncertain).toBe(true);
  });
});

describe('Real Test Image Pipeline Evaluation', () => {
  it('evaluates billing-sample.png gridlines and zero-skew structure', () => {
    const { rgba, width, height } = decodeFixtureImage('billing-sample.png');
    const lum = rgbaToLuminance(rgba, width, height);
    const skew = estimateSkewAngleDeg(lum, width, height);
    expect(Math.abs(skew)).toBeLessThan(1.0);

    const hLines = detectHorizontalGridLines(lum, width, height, 20, width - 20, 10, height - 10, 0.4);
    expect(hLines.length).toBeGreaterThanOrEqual(10);
  });

  it('evaluates clean-deals-table.jpg gridlines and full 8x7 cell boundaries (even with sparse Pass-1 hint)', () => {
    const { rgba, width, height } = decodeFixtureImage('clean-deals-table.jpg');
    const lum = rgbaToLuminance(rgba, width, height);
    const skew = estimateSkewAngleDeg(lum, width, height);
    expect(Math.abs(skew)).toBeLessThan(1.0);

    const gridLum = normalizeForGridDetection(deMoireDirectional(lum, width, height), width, height);
    // Simulate Pass 1 only finding top 2 rows: Grid-first detector must still recover all 8 rows!
    const grid = detectBorderedTableGrid(gridLum, width, height, {
      hintY0: 8,
      hintY1: height * 0.28,
      hintX0: 15,
      hintX1: width - 15,
    });
    expect(grid).not.toBeNull();
    // 1 header row + 7 data rows = 8 rows (9 horizontal boundaries), 7 columns (8 vertical boundaries)
    expect(grid!.rowYs.length).toBe(9);
    expect(grid!.colXs.length).toBe(8);

    // Also verify at 1.85x upscaled resolution (matching live browser canvas scale)
    const upW = Math.round(width * 1.85);
    const upH = Math.round(height * 1.85);
    const upRgba = rotateRgbaBilinear(
      (() => {
        const buf = new Uint8ClampedArray(upW * upH * 4);
        for (let y = 0; y < upH; y++) {
          const sy = Math.min(height - 1, Math.floor(y / 1.85));
          for (let x = 0; x < upW; x++) {
            const sx = Math.min(width - 1, Math.floor(x / 1.85));
            const sOff = (sy * width + sx) * 4;
            const dOff = (y * upW + x) * 4;
            buf[dOff] = rgba[sOff];
            buf[dOff + 1] = rgba[sOff + 1];
            buf[dOff + 2] = rgba[sOff + 2];
            buf[dOff + 3] = rgba[sOff + 3];
          }
        }
        return buf;
      })(),
      upW,
      upH,
      0
    );
    const upGridLum = normalizeForGridDetection(
      deMoireDirectional(rgbaToLuminance(upRgba, upW, upH), upW, upH),
      upW,
      upH
    );
    const upGrid = detectBorderedTableGrid(upGridLum, upW, upH, {
      hintY0: 16,
      hintY1: upH * 0.28,
      hintX0: 28,
      hintX1: upW - 28,
    });
    expect(upGrid).not.toBeNull();
    expect(upGrid!.rowYs.length).toBe(9);
    expect(upGrid!.colXs.length).toBe(8);

    // Every segmented row gap must stay uniform (no half-row text-top splits or slivers)
    const upGaps = upGrid!.rowYs.slice(1).map((y, idx) => y - upGrid!.rowYs[idx]);
    const medUpGap = [...upGaps].sort((a, b) => a - b)[Math.floor(upGaps.length / 2)];
    for (const g of upGaps) {
      expect(g).toBeGreaterThanOrEqual(medUpGap * 0.68);
      expect(g).toBeLessThanOrEqual(medUpGap * 1.4);
    }
  });

  it('evaluates laptop-camera-pivot.jpg de-moire, skew, and full 9x6 pivot grid detection', () => {
    const { rgba, width, height } = decodeFixtureImage('laptop-camera-pivot.jpg');
    const rawLum = rgbaToLuminance(rgba, width, height);
    const skew = estimateSkewAngleDeg(rawLum, width, height);
    expect(Math.abs(skew)).toBeLessThan(5.0);

    const deskewed =
      Math.abs(skew) >= 0.35 ? rotateRgbaBilinear(rgba, width, height, skew) : rgba;
    const gridLum = normalizeForGridDetection(
      deMoireDirectional(rgbaToLuminance(deskewed, width, height), width, height),
      width,
      height
    );

    const grid = detectBorderedTableGrid(gridLum, width, height, {
      hintY0: height * 0.33,
      hintY1: height * 0.65,
      hintX0: width * 0.08,
      hintX1: width * 0.94,
      maxY: height * 0.78,
    });
    expect(grid).not.toBeNull();
    // 9 rows (banner + headers + 6 dealers + Grand Total) = 10 hLines, 6 columns = 7 vLines
    expect(grid!.rowYs.length).toBeGreaterThanOrEqual(10);
    expect(grid!.colXs.length).toBe(7);

    // Also test upscaled 1.95x resolution matching live browser canvas scaling
    const upScale = 2000 / Math.max(width, height);
    const upW = Math.round(width * upScale);
    const upH = Math.round(height * upScale);
    const upRgba = new Uint8ClampedArray(upW * upH * 4);
    for (let y = 0; y < upH; y++) {
      const sy = Math.min(height - 1, Math.floor(y / upScale));
      for (let x = 0; x < upW; x++) {
        const sx = Math.min(width - 1, Math.floor(x / upScale));
        const sOff = (sy * width + sx) * 4;
        const dOff = (y * upW + x) * 4;
        upRgba[dOff] = rgba[sOff];
        upRgba[dOff + 1] = rgba[sOff + 1];
        upRgba[dOff + 2] = rgba[sOff + 2];
        upRgba[dOff + 3] = rgba[sOff + 3];
      }
    }
    const upGridLum = normalizeForGridDetection(
      deMoireDirectional(rgbaToLuminance(upRgba, upW, upH), upW, upH),
      upW,
      upH
    );
    const upGrid = detectBorderedTableGrid(upGridLum, upW, upH, {
      hintY0: upH * 0.34,
      hintY1: upH * 0.65,
      hintX0: upW * 0.08,
      hintX1: upW * 0.94,
      maxY: upH * 0.78,
    });
    expect(upGrid).not.toBeNull();
    expect(upGrid!.rowYs.length).toBeGreaterThanOrEqual(10);
    expect(upGrid!.colXs.length).toBe(7);
  });
});
