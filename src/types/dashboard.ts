export type ExtractionMethod =
  | 'reference-match'
  | 'excel-csv'
  | 'gemini-vision'
  | 'tesseract-ocr'
  | 'manual-paste';

export interface OwnerRecord {
  id: string;
  dealerCode: string;
  ownerName: string;
  cd: number;
  cdd: number;
  vs: number;
  vsd: number;
  ifc: number;
  /** Row Grand Total read from source image/file for mathematical cross-check */
  sourceRowTotal?: number;
  /** OCR confidence score (0-100) when extracted from an image */
  confidence?: number;
  /** True if row sum didn't match sourceRowTotal or OCR confidence was low */
  needsReview?: boolean;
  reviewReason?: string;
}

export interface DealerGroup {
  dealerCode: string;
  owners: OwnerRecord[];
  bills: number;
  vas: number;
  vasPct: number;
  cdTotal: number;
  cddTotal: number;
  vsTotal: number;
  vsdTotal: number;
  ifcTotal: number;
}

export interface IntegrityIssue {
  rowId?: string;
  dealerCode: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface DashboardSummary {
  groups: DealerGroup[];
  grandBills: number;
  grandVas: number;
  grandVasPct: number;
  grandCd: number;
  grandCdd: number;
  grandVs: number;
  grandVsd: number;
  grandIfc: number;
  totalOwners: number;
  totalDealers: number;
  integrityIssues: IntegrityIssue[];
  isVerified: boolean;
}

export interface DashboardRenderOptions {
  includeTitleBanner: boolean;
  titleText: string;
  subtitleText: string;
  showTimestamp: boolean;
  scale: 2 | 3;
}
