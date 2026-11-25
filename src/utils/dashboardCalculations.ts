import * as XLSX from 'xlsx';
import type {
  DashboardSummary,
  DealerGroup,
  IntegrityIssue,
  OwnerRecord,
} from '../types/dashboard';

export interface VasHeatmapColor {
  bg: string;
  text: string;
  tier: 'zero' | 'mid' | 'high' | 'super';
}

/**
 * Matches the conditional color palette in the reference Salesforce output image:
 * - 0%          -> warm peach/orange (#F9B582)
 * - >0% to <75% -> soft yellow (#FFF394)
 * - 75% to <200%-> fresh lime green (#B9EE8C)
 * - >=200%      -> rich emerald green (#26BA59)
 */
export function getVasHeatmapStyle(vasPct: number): VasHeatmapColor {
  if (vasPct <= 0.001) {
    return { bg: '#F9B582', text: '#111827', tier: 'zero' };
  }
  if (vasPct < 75) {
    return { bg: '#FFF394', text: '#111827', tier: 'mid' };
  }
  if (vasPct < 200) {
    return { bg: '#B9EE8C', text: '#111827', tier: 'high' };
  }
  return { bg: '#26BA59', text: '#0B1F12', tier: 'super' };
}

export function calcRowBills(row: Pick<OwnerRecord, 'cd' | 'cdd' | 'ifc'>): number {
  return safeNum(row.cd) + safeNum(row.cdd) + safeNum(row.ifc);
}

export function calcRowVas(row: Pick<OwnerRecord, 'vs' | 'vsd'>): number {
  return safeNum(row.vs) + safeNum(row.vsd);
}

/**
 * Calculates VAS % = (VAS / BILLS) * 100, returning 0 when BILLS is 0.
 */
export function calcVasPct(bills: number, vas: number): number {
  if (bills <= 0) {
    return 0;
  }
  return (vas / bills) * 100;
}

function safeNum(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

export function computeDashboardSummary(records: OwnerRecord[]): DashboardSummary {
  const groupOrder: string[] = [];
  const groupMap = new Map<string, OwnerRecord[]>();
  const integrityIssues: IntegrityIssue[] = [];

  for (const raw of records) {
    const dealerCode = (raw.dealerCode || '').trim() || 'UNASSIGNED';
    const ownerName = (raw.ownerName || '').trim();
    if (!ownerName) continue;

    const cleanRow: OwnerRecord = {
      ...raw,
      dealerCode,
      ownerName,
      cd: safeNum(raw.cd),
      cdd: safeNum(raw.cdd),
      vs: safeNum(raw.vs),
      vsd: safeNum(raw.vsd),
      ifc: safeNum(raw.ifc),
    };

    const rowProductSum =
      cleanRow.cd + cleanRow.cdd + cleanRow.vs + cleanRow.vsd + cleanRow.ifc;

    if (
      typeof cleanRow.sourceRowTotal === 'number' &&
      cleanRow.sourceRowTotal !== rowProductSum
    ) {
      cleanRow.needsReview = true;
      cleanRow.reviewReason = `Product sum (${rowProductSum}) != Source Grand Total (${cleanRow.sourceRowTotal})`;
      integrityIssues.push({
        rowId: cleanRow.id,
        dealerCode,
        severity: 'error',
        message: `${ownerName}: CD+CDD+VS+VSD+IFC = ${rowProductSum}, expected ${cleanRow.sourceRowTotal}`,
      });
    } else if (cleanRow.needsReview) {
      integrityIssues.push({
        rowId: cleanRow.id,
        dealerCode,
        severity: 'warning',
        message:
          cleanRow.reviewReason ||
          `${ownerName}: Low OCR confidence (${cleanRow.confidence ?? '?'}%) — verify spelling/counts`,
      });
    }

    if (!groupMap.has(dealerCode)) {
      groupMap.set(dealerCode, []);
      groupOrder.push(dealerCode);
    }
    groupMap.get(dealerCode)!.push(cleanRow);
  }

  let grandBills = 0;
  let grandVas = 0;
  let grandCd = 0;
  let grandCdd = 0;
  let grandVs = 0;
  let grandVsd = 0;
  let grandIfc = 0;

  const groups: DealerGroup[] = groupOrder.map((dealerCode) => {
    const owners = groupMap.get(dealerCode)!;
    let cdTotal = 0;
    let cddTotal = 0;
    let vsTotal = 0;
    let vsdTotal = 0;
    let ifcTotal = 0;

    for (const o of owners) {
      cdTotal += o.cd;
      cddTotal += o.cdd;
      vsTotal += o.vs;
      vsdTotal += o.vsd;
      ifcTotal += o.ifc;
    }

    const bills = cdTotal + cddTotal + ifcTotal;
    const vas = vsTotal + vsdTotal;
    const vasPct = calcVasPct(bills, vas);

    grandCd += cdTotal;
    grandCdd += cddTotal;
    grandVs += vsTotal;
    grandVsd += vsdTotal;
    grandIfc += ifcTotal;
    grandBills += bills;
    grandVas += vas;

    return {
      dealerCode,
      owners,
      bills,
      vas,
      vasPct,
      cdTotal,
      cddTotal,
      vsTotal,
      vsdTotal,
      ifcTotal,
    };
  });

  const grandVasPct = calcVasPct(grandBills, grandVas);

  return {
    groups,
    grandBills,
    grandVas,
    grandVasPct,
    grandCd,
    grandCdd,
    grandVs,
    grandVsd,
    grandIfc,
    totalOwners: groups.reduce((sum, g) => sum + g.owners.length, 0),
    totalDealers: groups.length,
    integrityIssues,
    isVerified: integrityIssues.length === 0 && groups.length > 0,
  };
}

/**
 * Parses an Excel (.xlsx / .xls) or CSV Salesforce report export into OwnerRecord[].
 */
export async function parseSpreadsheetFile(file: File): Promise<OwnerRecord[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, {
    header: 1,
    defval: '',
  });
  return parseMatrixRows(matrix);
}

/**
 * Parses tab-separated or comma-separated pasted text from Salesforce / Excel.
 */
export function parseDelimitedText(text: string): OwnerRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const matrix = lines.map((line) => line.split(delimiter).map((c) => c.trim()));
  return parseMatrixRows(matrix);
}

function normalizeHeader(cell: unknown): string {
  return String(cell ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseMatrixRows(matrix: unknown[][]): OwnerRecord[] {
  if (matrix.length === 0) return [];

  // Find header row containing dealer/owner or product columns (handling 2-row Salesforce headers)
  let headerIdx = -1;
  let colDealer = -1;
  let colOwner = -1;
  let colCd = -1;
  let colCdd = -1;
  let colVs = -1;
  let colVsd = -1;
  let colIfc = -1;
  let colTotal = -1;
  let colBills = -1;
  let colVas = -1;

  for (let r = 0; r < Math.min(matrix.length, 15); r++) {
    const row = matrix[r];
    if (!Array.isArray(row)) continue;
    const norm = row.map(normalizeHeader);

    const ownerIdx = norm.findIndex(
      (h) => h.includes('opportunityowner') || h === 'owner' || h.includes('ownername')
    );
    const dealerIdx = norm.findIndex(
      (h) => h.includes('dealercode') || h.includes('finnone') || h === 'dealer'
    );
    const cdIdx = norm.findIndex((h) => h === 'cd');
    const cddIdx = norm.findIndex((h) => h === 'cdd');
    const vsIdx = norm.findIndex((h) => h === 'vs');
    const vsdIdx = norm.findIndex((h) => h === 'vsd');
    const ifcIdx = norm.findIndex((h) => h === 'ifc');
    const billsIdx = norm.findIndex((h) => h.startsWith('bills'));
    const vasIdx = norm.findIndex((h) => h === 'vas' || h.startsWith('vasvs'));

    if (
      ownerIdx !== -1 ||
      (cdIdx !== -1 && cddIdx !== -1) ||
      (billsIdx !== -1 && vasIdx !== -1)
    ) {
      headerIdx = r;
      colDealer = dealerIdx !== -1 ? dealerIdx : 0;
      colOwner = ownerIdx !== -1 ? ownerIdx : colDealer + 1;
      colCd = cdIdx;
      colCdd = cddIdx;
      colVs = vsIdx;
      colVsd = vsdIdx;
      colIfc = ifcIdx;
      colBills = billsIdx;
      colVas = vasIdx;
      colTotal = norm.findIndex((h) => h === 'grandtotal' || h === 'total');

      // Check previous row for merged "Grand Total" header if absent on this row
      if (colTotal === -1 && r > 0 && Array.isArray(matrix[r - 1])) {
        const prevNorm = matrix[r - 1].map(normalizeHeader);
        colTotal = prevNorm.findIndex((h) => h === 'grandtotal' || h === 'total');
      }
      break;
    }
  }

  // Fallback positional layout if no explicit header row (auto-skip any "Record Count" column)
  const startRow = headerIdx >= 0 ? headerIdx + 1 : 0;
  if (headerIdx === -1) {
    const firstRow = matrix[0] || [];
    const hasRecordCountCol = matrix
      .slice(0, 8)
      .some((r) => Array.isArray(r) && r.some((c) => /record\s*count/i.test(String(c ?? ''))));
    const recIdx = hasRecordCountCol
      ? firstRow.findIndex((_, idx) =>
          matrix.slice(0, 8).some((r) => Array.isArray(r) && /record\s*count/i.test(String(r[idx] ?? '')))
        )
      : -1;

    colDealer = 0;
    colOwner = 1;
    const numStart = recIdx === 2 ? 3 : 2;
    colCd = numStart;
    colCdd = numStart + 1;
    colVs = numStart + 2;
    colVsd = numStart + 3;
    colIfc = numStart + 4;
    colTotal = numStart + 5;
  }

  const results: OwnerRecord[] = [];
  let activeDealer = '';

  for (let r = startRow; r < matrix.length; r++) {
    const row = matrix[r];
    if (!Array.isArray(row) || row.every((c) => String(c ?? '').trim() === '')) {
      continue;
    }

    const rawDealer = String(row[colDealer] ?? '').trim();
    const rawOwner = String(row[colOwner] ?? '').trim();
    const rowLeadText = row.slice(0, 3).map((c) => String(c ?? '').trim()).join(' ');

    if (
      /\b(sub\s*-?\s*total|grand\s*total)\b|^total$/i.test(rawOwner) ||
      /\b(sub\s*-?\s*total|grand\s*total)\b|^total$/i.test(rawDealer) ||
      /\b(sub\s*-?\s*total|grand\s*total)\b/i.test(rowLeadText)
    ) {
      continue;
    }

    if (rawDealer) {
      activeDealer = rawDealer;
    }
    if (!rawOwner || /record\s*count/i.test(rawOwner)) {
      continue;
    }

    const numAt = (idx: number): number => {
      if (idx < 0 || idx >= row.length) return 0;
      const val = Number(String(row[idx] ?? '').replace(/,/g, '').trim());
      return Number.isFinite(val) && val >= 0 ? Math.round(val) : 0;
    };

    const cd = colCd !== -1 ? numAt(colCd) : colBills !== -1 ? numAt(colBills) : 0;
    const cdd = colCdd !== -1 ? numAt(colCdd) : 0;
    const vs = colVs !== -1 ? numAt(colVs) : colVas !== -1 ? numAt(colVas) : 0;
    const vsd = colVsd !== -1 ? numAt(colVsd) : 0;
    const ifc = colIfc !== -1 ? numAt(colIfc) : 0;
    const sourceRowTotal =
      colTotal !== -1 && String(row[colTotal] ?? '').trim() !== ''
        ? numAt(colTotal)
        : undefined;

    results.push({
      id: `row-${r}-${Date.now()}`,
      dealerCode: activeDealer || 'UNASSIGNED',
      ownerName: rawOwner,
      cd,
      cdd,
      vs,
      vsd,
      ifc,
      sourceRowTotal,
      confidence: 100,
      needsReview: false,
    });
  }

  return results;
}
