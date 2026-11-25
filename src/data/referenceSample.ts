import type { OwnerRecord } from '../types/dashboard';

export const BILLING_SAMPLE_IMAGE_URL = `${import.meta.env.BASE_URL}samples/billing-sample.png`;
export const EXPECTED_OUTPUT_IMAGE_URL = `${import.meta.env.BASE_URL}samples/expected-output.jpg`;

/**
 * Exact ground-truth records matching the attached Salesforce Billing Sample
 * (FinnOne Dealer Code x Opportunity Owner x Product Code: CD, CDD, VS, VSD, IFC).
 */
export const REFERENCE_BILLING_RECORDS: OwnerRecord[] = [
  {
    id: 'ref-1',
    dealerCode: '14126',
    ownerName: 'Ammanaboina Gopi',
    cd: 1,
    cdd: 1,
    vs: 0,
    vsd: 0,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-2',
    dealerCode: '14126',
    ownerName: 'Kattula Bhuvaneswari',
    cd: 0,
    cdd: 1,
    vs: 0,
    vsd: 0,
    ifc: 1,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-3',
    dealerCode: '14126',
    ownerName: 'Syed Aayan',
    cd: 0,
    cdd: 1,
    vs: 0,
    vsd: 0,
    ifc: 0,
    sourceRowTotal: 1,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-4',
    dealerCode: '314350',
    ownerName: 'ROHIT SINGH',
    cd: 1,
    cdd: 0,
    vs: 0,
    vsd: 1,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-5',
    dealerCode: '314350',
    ownerName: 'Vanga Shekar',
    cd: 0,
    cdd: 1,
    vs: 0,
    vsd: 1,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-6',
    dealerCode: '314350',
    ownerName: 'Y Mounika',
    cd: 0,
    cdd: 1,
    vs: 2,
    vsd: 1,
    ifc: 0,
    sourceRowTotal: 4,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-7',
    dealerCode: '327843',
    ownerName: 'MOHAMMED AHMED',
    cd: 0,
    cdd: 1,
    vs: 0,
    vsd: 0,
    ifc: 0,
    sourceRowTotal: 1,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-8',
    dealerCode: '803568',
    ownerName: 'Bonkuri Aparna',
    cd: 1,
    cdd: 0,
    vs: 1,
    vsd: 0,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-9',
    dealerCode: '803568',
    ownerName: 'Gajre Ravikumar',
    cd: 0,
    cdd: 2,
    vs: 0,
    vsd: 0,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
  {
    id: 'ref-10',
    dealerCode: '815954',
    ownerName: 'SHAIK ZAKER',
    cd: 0,
    cdd: 1,
    vs: 0,
    vsd: 1,
    ifc: 0,
    sourceRowTotal: 2,
    confidence: 100,
    needsReview: false,
  },
];

/**
 * Generates a realistic synthetic "camera-taken photo" of a printed report sheet
 * with warm desk background, perspective tilt, shadow gradient, and subtle sensor grain
 * so users can immediately test Tab 2 (Reports) even before uploading their own photo.
 */
export function generateSyntheticCameraPhotoDataUrl(): string {
  const width = 1080;
  const height = 760;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Desk surface background
  const deskGrad = ctx.createLinearGradient(0, 0, width, height);
  deskGrad.addColorStop(0, '#5a4e43');
  deskGrad.addColorStop(1, '#3b332c');
  ctx.fillStyle = deskGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle drop shadow under paper
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-0.035);
  ctx.transform(1, 0.02, -0.04, 1, 0, 0);

  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetX = 8;
  ctx.shadowOffsetY = 14;

  const paperW = 860;
  const paperH = 560;
  const px = -paperW / 2;
  const py = -paperH / 2;

  // Slightly warm/unevenly lit paper
  const paperGrad = ctx.createRadialGradient(-120, -100, 40, 60, 60, 680);
  paperGrad.addColorStop(0, '#f3efe6');
  paperGrad.addColorStop(0.6, '#ded8cb');
  paperGrad.addColorStop(1, '#bab2a3');
  ctx.fillStyle = paperGrad;
  ctx.fillRect(px, py, paperW, paperH);
  ctx.shadowColor = 'transparent';

  // Report content on paper
  ctx.fillStyle = '#252930';
  ctx.font = 'bold 24px Inter, Arial, sans-serif';
  ctx.fillText('DAILY DEALER BILLING & VAS SUMMARY REPORT', px + 40, py + 58);

  ctx.fillStyle = '#4b5563';
  ctx.font = '15px Inter, Arial, sans-serif';
  ctx.fillText('Region: Telangana South   |   Cycle: Nov 2026   |   Status: Verified', px + 40, py + 88);

  // Table on paper
  const tableX = px + 40;
  const tableY = py + 115;
  const colWidths = [150, 260, 120, 120, 130];
  const headers = ['Dealer Code', 'Opportunity Owner', 'BILLS', 'VAS', 'VAS %'];
  const rows: Array<[string, string, string, string, string, string]> = [
    ['14126', 'Ammanaboina Gopi', '2', '0', '0.00%', '#f6b888'],
    ['', 'Kattula Bhuvaneswari', '2', '0', '0.00%', '#f6b888'],
    ['314350', 'ROHIT SINGH', '1', '1', '100.00%', '#bae890'],
    ['', 'Vanga Shekar', '1', '1', '100.00%', '#bae890'],
    ['', 'Y Mounika', '1', '3', '300.00%', '#35b462'],
    ['803568', 'Bonkuri Aparna', '1', '1', '100.00%', '#bae890'],
    ['', 'Gajre Ravikumar', '2', '0', '0.00%', '#f6b888'],
    ['815954', 'SHAIK ZAKER', '1', '1', '100.00%', '#bae890'],
    ['', 'Grand Total', '11', '7', '63.64%', '#f7ea8b'],
  ];

  // Draw header
  let cx = tableX;
  const rowH = 38;
  ctx.fillStyle = '#c8e4f5';
  ctx.fillRect(tableX, tableY, colWidths.reduce((a, b) => a + b, 0), rowH);
  ctx.strokeStyle = '#5f6773';
  ctx.lineWidth = 1.2;
  headers.forEach((h, i) => {
    ctx.strokeRect(cx, tableY, colWidths[i], rowH);
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 15px Inter, Arial, sans-serif';
    ctx.textAlign = i >= 2 ? 'center' : 'left';
    const tx = i >= 2 ? cx + colWidths[i] / 2 : cx + 10;
    ctx.fillText(h, tx, tableY + 24);
    cx += colWidths[i];
  });

  // Draw rows
  rows.forEach((r, rIdx) => {
    const ry = tableY + rowH * (rIdx + 1);
    const isTotal = r[1] === 'Grand Total';
    let rx = tableX;
    for (let c = 0; c < 5; c++) {
      ctx.fillStyle =
        c === 4
          ? r[5]
          : isTotal
            ? '#646c77'
            : rIdx % 2 === 0
              ? 'rgba(255,255,255,0.65)'
              : 'rgba(240,244,248,0.65)';
      ctx.fillRect(rx, ry, colWidths[c], rowH);
      ctx.strokeRect(rx, ry, colWidths[c], rowH);

      ctx.fillStyle = isTotal && c !== 4 ? '#ffffff' : '#1f2937';
      ctx.font =
        c === 0 || c >= 2 || isTotal
          ? 'bold 15px Inter, Arial, sans-serif'
          : '15px Inter, Arial, sans-serif';
      ctx.textAlign = c >= 2 ? 'center' : isTotal && c === 1 ? 'right' : 'left';
      const tx =
        c >= 2
          ? rx + colWidths[c] / 2
          : isTotal && c === 1
            ? rx + colWidths[c] - 12
            : rx + 10;
      ctx.fillText(r[c], tx, ry + 24);
      rx += colWidths[c];
    }
  });

  // Simulate diagonal phone shadow across bottom-right corner
  const shadowOverlay = ctx.createLinearGradient(px + 200, py + 120, px + paperW, py + paperH);
  shadowOverlay.addColorStop(0, 'rgba(30,25,20,0)');
  shadowOverlay.addColorStop(0.55, 'rgba(30,25,20,0.08)');
  shadowOverlay.addColorStop(1, 'rgba(20,16,12,0.38)');
  ctx.fillStyle = shadowOverlay;
  ctx.fillRect(px, py, paperW, paperH);

  ctx.restore();
  return canvas.toDataURL('image/jpeg', 0.88);
}
