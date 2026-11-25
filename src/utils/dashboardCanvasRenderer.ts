import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import type { DashboardRenderOptions, DashboardSummary } from '../types/dashboard';
import {
  calcRowBills,
  calcRowVas,
  calcVasPct,
  getVasHeatmapStyle,
} from './dashboardCalculations';

const COL_WIDTHS = [165, 375, 165, 165, 130]; // Total logical width: 1000px
const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 38;
const GRAND_TOTAL_HEIGHT = 44;
const BANNER_HEIGHT = 74;

/**
 * Renders the Salesforce Dashboard summary to a high-DPI HTML5 Canvas
 * matching the reference output format cleanly and without font/layout glitches.
 */
export function renderDashboardToCanvas(
  summary: DashboardSummary,
  options: DashboardRenderOptions
): HTMLCanvasElement {
  const scale = options.scale;
  const tableWidth = COL_WIDTHS.reduce((a, b) => a + b, 0);

  let totalRows = 0;
  for (const g of summary.groups) {
    totalRows += g.owners.length + 1; // owners + subtotal
  }

  const bannerOffset = options.includeTitleBanner ? BANNER_HEIGHT : 0;
  const logicalWidth = tableWidth;
  const logicalHeight =
    bannerOffset +
    HEADER_HEIGHT +
    totalRows * ROW_HEIGHT +
    (summary.groups.length > 0 ? GRAND_TOTAL_HEIGHT : 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(logicalWidth * scale);
  canvas.height = Math.round(logicalHeight * scale);

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';

  // Base white fill
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);

  // Optional clean report title banner above the table
  if (options.includeTitleBanner) {
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, logicalWidth, BANNER_HEIGHT);

    // Accent strip
    ctx.fillStyle = '#38BDF8';
    ctx.fillRect(0, 0, 6, BANNER_HEIGHT);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 20px Inter, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      options.titleText || 'Salesforce Billing & VAS Performance Dashboard',
      22,
      27
    );

    ctx.fillStyle = '#CBD5E1';
    ctx.font = '500 13px Inter, Arial, sans-serif';
    const subParts = [options.subtitleText || 'FinnOne Dealer Summary'];
    if (options.showTimestamp) {
      subParts.push(
        `Generated ${new Date().toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })}`
      );
    }
    subParts.push(`${summary.totalDealers} Dealers · ${summary.totalOwners} Owners`);
    ctx.fillText(subParts.filter(Boolean).join('   |   '), 22, 52);

    // Verification pill on right
    const badgeText = summary.isVerified ? 'VERIFIED · 0 ERRORS' : 'REVIEW NEEDED';
    ctx.fillStyle = summary.isVerified ? '#10B981' : '#F59E0B';
    const badgeW = 160;
    const badgeH = 26;
    const bx = logicalWidth - badgeW - 20;
    const by = (BANNER_HEIGHT - badgeH) / 2;
    roundRect(ctx, bx, by, badgeW, badgeH, 13);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 11px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(badgeText, bx + badgeW / 2, by + badgeH / 2 + 0.5);
  }

  let y = bannerOffset;

  // Draw Table Header (#D4F0FF matching reference)
  const headers: Array<{ line1: string; line2?: string }> = [
    { line1: 'FinnOne Dealer', line2: 'Code' },
    { line1: 'Opportunity Owner' },
    { line1: 'BILLS', line2: '(CD + CDD + IFC)' },
    { line1: 'VAS', line2: '(VS + VSD)' },
    { line1: 'VAS %' },
  ];

  let x = 0;
  for (let i = 0; i < headers.length; i++) {
    const w = COL_WIDTHS[i];
    ctx.fillStyle = '#D4F0FF';
    ctx.fillRect(x, y, w, HEADER_HEIGHT);
    drawCellBorder(ctx, x, y, w, HEADER_HEIGHT);

    ctx.fillStyle = '#0F172A';
    ctx.font = '700 15px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    if (headers[i].line2) {
      ctx.fillText(headers[i].line1, x + w / 2, y + HEADER_HEIGHT / 2 - 10);
      ctx.fillText(headers[i].line2!, x + w / 2, y + HEADER_HEIGHT / 2 + 10);
    } else {
      ctx.fillText(headers[i].line1, x + w / 2, y + HEADER_HEIGHT / 2);
    }
    x += w;
  }

  y += HEADER_HEIGHT;

  // Draw Dealer Groups
  let zebraIndex = 0;
  for (const group of summary.groups) {
    group.owners.forEach((owner, idx) => {
      const bills = calcRowBills(owner);
      const vas = calcRowVas(owner);
      const vasPct = calcVasPct(bills, vas);
      const heat = getVasHeatmapStyle(vasPct);

      const rowBg = zebraIndex % 2 === 0 ? '#FFFFFF' : '#F4F6F9';
      zebraIndex++;

      const values = [
        idx === 0 ? group.dealerCode : '',
        owner.ownerName,
        String(bills),
        String(vas),
        `${vasPct.toFixed(2)}%`,
      ];

      let cx = 0;
      for (let c = 0; c < 5; c++) {
        const w = COL_WIDTHS[c];
        ctx.fillStyle = c === 4 ? heat.bg : rowBg;
        ctx.fillRect(cx, y, w, ROW_HEIGHT);
        drawCellBorder(ctx, cx, y, w, ROW_HEIGHT);

        ctx.fillStyle = c === 4 ? heat.text : '#111827';
        if (c === 0) {
          ctx.font = '700 15px Inter, Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(values[c], cx + w / 2, y + ROW_HEIGHT / 2);
        } else if (c === 1) {
          ctx.font = '400 15px Inter, Arial, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(values[c], cx + 14, y + ROW_HEIGHT / 2);
        } else {
          ctx.font = '700 15px Inter, Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(values[c], cx + w / 2, y + ROW_HEIGHT / 2);
        }
        cx += w;
      }

      y += ROW_HEIGHT;
    });

    // Subtotal row
    const subHeat = getVasHeatmapStyle(group.vasPct);
    const subBg = '#ECEFF3';
    const subValues = [
      '',
      'Subtotal',
      String(group.bills),
      String(group.vas),
      `${group.vasPct.toFixed(2)}%`,
    ];

    let sx = 0;
    for (let c = 0; c < 5; c++) {
      const w = COL_WIDTHS[c];
      ctx.fillStyle = c === 4 ? subHeat.bg : subBg;
      ctx.fillRect(sx, y, w, ROW_HEIGHT);
      drawCellBorder(ctx, sx, y, w, ROW_HEIGHT);

      ctx.fillStyle = c === 4 ? subHeat.text : '#111827';
      ctx.font = '700 15px Inter, Arial, sans-serif';
      if (c === 1) {
        ctx.textAlign = 'right';
        ctx.fillText(subValues[c], sx + w - 14, y + ROW_HEIGHT / 2);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(subValues[c], sx + w / 2, y + ROW_HEIGHT / 2);
      }
      sx += w;
    }

    y += ROW_HEIGHT;
    zebraIndex++;
  }

  // Grand Total row
  if (summary.groups.length > 0) {
    const gtHeat = getVasHeatmapStyle(summary.grandVasPct);
    const gtBg = '#5F6773';
    const gtValues = [
      '',
      'Grand Total',
      String(summary.grandBills),
      String(summary.grandVas),
      `${summary.grandVasPct.toFixed(2)}%`,
    ];

    let gx = 0;
    for (let c = 0; c < 5; c++) {
      const w = COL_WIDTHS[c];
      ctx.fillStyle = c === 4 ? gtHeat.bg : gtBg;
      ctx.fillRect(gx, y, w, GRAND_TOTAL_HEIGHT);
      drawCellBorder(ctx, gx, y, w, GRAND_TOTAL_HEIGHT);

      ctx.fillStyle = c === 4 ? gtHeat.text : '#FFFFFF';
      ctx.font = '700 16px Inter, Arial, sans-serif';
      if (c === 1) {
        ctx.textAlign = 'right';
        ctx.fillText(gtValues[c], gx + w - 14, y + GRAND_TOTAL_HEIGHT / 2);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(gtValues[c], gx + w / 2, y + GRAND_TOTAL_HEIGHT / 2);
      }
      gx += w;
    }
  }

  return canvas;
}

function drawCellBorder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function downloadCanvasImage(
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpeg',
  filename: string
) {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mime, 0.96);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `${filename}.${format === 'png' ? 'png' : 'jpg'}`;
  a.click();
}

export async function copyCanvasToClipboard(canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

export function exportCanvasAsPdf(canvas: HTMLCanvasElement, filename: string) {
  const imgData = canvas.toDataURL('image/png');
  const isLandscape = canvas.width >= canvas.height;
  const pdf = new jsPDF({
    orientation: isLandscape ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 24;
  const availW = pageW - margin * 2;
  const availH = pageH - margin * 2;
  const ratio = Math.min(availW / canvas.width, availH / canvas.height);
  const drawW = canvas.width * ratio;
  const drawH = canvas.height * ratio;
  const offsetX = (pageW - drawW) / 2;
  const offsetY = (pageH - drawH) / 2;
  pdf.addImage(imgData, 'PNG', offsetX, offsetY, drawW, drawH);
  pdf.save(`${filename}.pdf`);
}

export function exportDashboardAsExcel(summary: DashboardSummary, filename: string) {
  const aoa: Array<Array<string | number>> = [
    ['FinnOne Dealer Code', 'Opportunity Owner', 'BILLS (CD + CDD + IFC)', 'VAS (VS + VSD)', 'VAS %'],
  ];

  for (const group of summary.groups) {
    group.owners.forEach((o, idx) => {
      const bills = calcRowBills(o);
      const vas = calcRowVas(o);
      const pct = calcVasPct(bills, vas);
      aoa.push([
        idx === 0 ? group.dealerCode : '',
        o.ownerName,
        bills,
        vas,
        `${pct.toFixed(2)}%`,
      ]);
    });
    aoa.push(['', 'Subtotal', group.bills, group.vas, `${group.vasPct.toFixed(2)}%`]);
  }

  aoa.push([
    '',
    'Grand Total',
    summary.grandBills,
    summary.grandVas,
    `${summary.grandVasPct.toFixed(2)}%`,
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 24 }, { wch: 16 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Salesforce Dashboard');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

/**
 * Renders an arbitrary table matrix in the crisp steel-blue header digital format
 * matching the Tab 2 required output style (#BDD8E6 header/total, #FFFFFF/#F4F6F9 rows, #374151 borders).
 */
export function renderGenericTableToCanvas(
  matrix: unknown[][],
  scale = 3
): HTMLCanvasElement {
  const cleanRows = matrix
    .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []))
    .filter((r) => r.some((c) => c !== ''));

  const colCount = Math.max(1, ...cleanRows.map((r) => r.length));
  const colWidths = new Array<number>(colCount).fill(95);

  const probe = document.createElement('canvas').getContext('2d');
  if (probe) {
    probe.font = '700 14px Inter, Arial, sans-serif';
    for (let r = 0; r < cleanRows.length; r++) {
      for (let c = 0; c < colCount; c++) {
        const text = cleanRows[r][c] || '';
        const w = Math.ceil(probe.measureText(text).width) + 28;
        colWidths[c] = Math.max(colWidths[c], Math.min(280, w));
      }
    }
  }

  // Detect if row 0 is a pivot super-header (e.g. "Count of Deal ID | Stage") above row 1 column headers
  const hasSuperHeader =
    cleanRows.length >= 3 &&
    cleanRows[0].filter((c) => c !== '').length <= 3 &&
    cleanRows[1].filter((c) => c !== '').length >= Math.max(3, colCount - 1);

  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const headerH = 42;
  const rowH = 36;
  const headerRowsCount = hasSuperHeader ? 2 : 1;
  const totalH =
    cleanRows.length > 0
      ? headerRowsCount * headerH + Math.max(0, cleanRows.length - headerRowsCount) * rowH
      : 120;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(totalW * scale);
  canvas.height = Math.round(totalH * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, totalW, totalH);

  let y = 0;
  cleanRows.forEach((row, rIdx) => {
    const isHeader = rIdx === 0 || (hasSuperHeader && rIdx === 1);
    const isTotal =
      !isHeader &&
      (/^(grand\s*total|sub\s*total|total)$/i.test(row[0] || '') ||
        /\bgrand\s*total\b/i.test(row.join(' ')));
    const h = isHeader ? headerH : rowH;

    let x = 0;
    for (let c = 0; c < colCount; c++) {
      const w = colWidths[c];
      const text = row[c] ?? '';
      ctx.fillStyle =
        isHeader || isTotal
          ? '#BDD8E6'
          : (rIdx - headerRowsCount) % 2 === 0
            ? '#FFFFFF'
            : '#F5F7FA';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      ctx.fillStyle = '#111827';
      ctx.font =
        isHeader || isTotal
          ? '700 14px Inter, Arial, sans-serif'
          : '400 14px Inter, Arial, sans-serif';
      const isNumeric = text !== '' && /^-?\d+(\.\d+)?%?$/.test(text);
      if (isHeader || isNumeric) {
        ctx.textAlign = 'center';
        ctx.fillText(text, x + w / 2, y + h / 2);
      } else {
        ctx.textAlign = 'left';
        ctx.fillText(text, x + 12, y + h / 2);
      }
      x += w;
    }
    y += h;
  });

  return canvas;
}
