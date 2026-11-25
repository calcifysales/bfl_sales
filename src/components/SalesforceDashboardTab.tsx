import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  ClipboardPaste,
  Download,
  FileSpreadsheet,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { DashboardRenderOptions, OwnerRecord } from '../types/dashboard';
import {
  calcRowBills,
  calcRowVas,
  calcVasPct,
  computeDashboardSummary,
  getVasHeatmapStyle,
  parseDelimitedText,
  parseSpreadsheetFile,
} from '../utils/dashboardCalculations';
import {
  downloadCanvasImage,
  exportCanvasAsPdf,
  exportDashboardAsExcel,
  renderDashboardToCanvas,
} from '../utils/dashboardCanvasRenderer';
import { extractSalesforceReportFromImage } from '../utils/ocrExtractor';
import {
  CameraCaptureModal,
  isTouchMobileDevice,
} from './CameraCaptureModal';

type StageView = 'generated' | 'editor';

const BEST_RENDER_OPTIONS: DashboardRenderOptions = {
  includeTitleBanner: false,
  titleText: '',
  subtitleText: '',
  showTimestamp: false,
  scale: 3,
};

export const SalesforceDashboardTab: React.FC = () => {
  const [records, setRecords] = useState<OwnerRecord[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);

  const [stageView, setStageView] = useState<StageView>('generated');
  const [generatedPreviewUrl, setGeneratedPreviewUrl] = useState<string>('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string>('');

  const renderedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileCameraInputRef = useRef<HTMLInputElement | null>(null);

  const summary = useMemo(() => computeDashboardSummary(records), [records]);

  useEffect(() => {
    if (records.length === 0) {
      renderedCanvasRef.current = null;
      setGeneratedPreviewUrl('');
      return;
    }
    const canvas = renderDashboardToCanvas(summary, BEST_RENDER_OPTIONS);
    renderedCanvasRef.current = canvas;
    setGeneratedPreviewUrl(canvas.toDataURL('image/png'));
  }, [records.length, summary]);

  async function runImageExtraction(imageDataUrl: string) {
    setIsProcessing(true);
    setErrorBanner('');
    setProgressPct(10);
    setProgressText('Reading attached image...');
    try {
      const result = await extractSalesforceReportFromImage(imageDataUrl, {
        forceScan: false,
        onProgress: (msg, pct) => {
          setProgressText(msg);
          setProgressPct(pct);
        },
      });
      if (result.records.length > 0) {
        setRecords(result.records);
        setStageView('generated');
      } else {
        setErrorBanner(
          'No structured table rows detected. Use Paste Table or tap the Edit icon to enter rows.'
        );
      }
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to parse attached image'
      );
    } finally {
      setIsProcessing(false);
      setProgressPct(0);
    }
  }

  async function handleFileSelected(file: File) {
    setErrorBanner('');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
      setIsProcessing(true);
      setProgressText('Reading spreadsheet...');
      setProgressPct(55);
      try {
        const parsed = await parseSpreadsheetFile(file);
        if (parsed.length === 0) {
          setErrorBanner(
            `No valid rows found in ${file.name}. Ensure columns include Opportunity Owner and CD/CDD/VS/VSD/IFC.`
          );
        } else {
          setRecords(parsed);
          setStageView('generated');
        }
      } catch (err) {
        setErrorBanner(
          `Failed to read ${file.name}: ${err instanceof Error ? err.message : 'Invalid file'}`
        );
      } finally {
        setIsProcessing(false);
        setProgressPct(0);
      }
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (dataUrl) void runImageExtraction(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  function handleCameraButtonClick() {
    if (isTouchMobileDevice()) {
      mobileCameraInputRef.current?.click();
    } else {
      setCameraOpen(true);
    }
  }

  function updateRecordField<K extends keyof OwnerRecord>(
    id: string,
    field: K,
    value: OwnerRecord[K]
  ) {
    setRecords((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
  }

  function addBlankRow() {
    const lastDealer = records[records.length - 1]?.dealerCode || '';
    setRecords((prev) => [
      ...prev,
      {
        id: `manual-${Date.now()}`,
        dealerCode: lastDealer,
        ownerName: 'New Opportunity Owner',
        cd: 0,
        cdd: 0,
        vs: 0,
        vsd: 0,
        ifc: 0,
        confidence: 100,
        needsReview: false,
      },
    ]);
  }

  function deleteRow(id: string) {
    setRecords((prev) => prev.filter((r) => r.id !== id));
  }

  function handleApplyPaste() {
    const parsed = parseDelimitedText(pasteText);
    if (parsed.length === 0) {
      setErrorBanner('Could not detect table rows in pasted text.');
      return;
    }
    setErrorBanner('');
    setRecords(parsed);
    setPasteOpen(false);
    setPasteText('');
    setStageView('generated');
  }

  return (
    <div className="space-y-5">
      {/* Compact Input Bar / Upload Card */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 sm:p-5 space-y-4">
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFileSelected(file);
          }}
          onClick={() => fileInputRef.current?.click()}
          className="group cursor-pointer rounded-xl border-2 border-dashed border-slate-300 hover:border-sky-500 hover:bg-sky-50/40 transition-all p-5 sm:p-6 text-center"
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
              e.target.value = '';
            }}
          />
          <input
            ref={mobileCameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
              e.target.value = '';
            }}
          />
          <div className="mx-auto w-11 h-11 rounded-xl bg-slate-100 group-hover:bg-sky-100 text-slate-600 group-hover:text-sky-600 flex items-center justify-center mb-2.5 transition-colors">
            <Upload className="w-5 h-5" />
          </div>
          <p className="text-sm font-semibold text-slate-800">
            Attach Billing Image or Excel / CSV
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Tap to browse or drop PNG, JPG, XLSX, CSV
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2.5 sm:max-w-md sm:mx-auto">
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleCameraButtonClick}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-45 text-xs sm:text-sm font-semibold text-white transition-colors"
          >
            <Camera className="w-4 h-4" />
            Camera
          </button>
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => setPasteOpen(true)}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-45 text-xs sm:text-sm font-semibold text-slate-700 transition-colors"
          >
            <ClipboardPaste className="w-4 h-4" />
            Paste Table
          </button>
        </div>

        {isProcessing && (
          <div className="rounded-xl bg-sky-50 border border-sky-200 p-3 space-y-2 max-w-xl mx-auto">
            <div className="flex items-center justify-between text-xs font-semibold text-sky-900">
              <span className="flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                {progressText || 'Processing...'}
              </span>
              <span>{progressPct}%</span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-sky-200 overflow-hidden">
              <div
                className="h-full bg-sky-600 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {errorBanner && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 text-xs text-rose-800 max-w-xl mx-auto">
            {errorBanner}
          </div>
        )}
      </div>

      {/* Generated Output Card (only rendered after data is attached/entered) */}
      {records.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1">
              <button
                type="button"
                onClick={() => setStageView('generated')}
                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                  stageView === 'generated'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Dashboard Image
              </button>
              <button
                type="button"
                onClick={() =>
                  setStageView((v) => (v === 'editor' ? 'generated' : 'editor'))
                }
                aria-label="Edit Data"
                title="Edit Data"
                className={`p-2 rounded-lg transition-all ${
                  stageView === 'editor'
                    ? 'bg-white text-sky-600 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                }`}
              >
                <Pencil className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  renderedCanvasRef.current &&
                  exportDashboardAsExcel(summary, 'salesforce-vas-dashboard')
                }
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-colors"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                Excel
              </button>
              <button
                type="button"
                onClick={() =>
                  renderedCanvasRef.current &&
                  exportCanvasAsPdf(renderedCanvasRef.current, 'salesforce-vas-dashboard')
                }
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-colors"
              >
                <FileText className="w-3.5 h-3.5 text-rose-600" />
                PDF
              </button>
              <button
                type="button"
                onClick={() =>
                  renderedCanvasRef.current &&
                  downloadCanvasImage(
                    renderedCanvasRef.current,
                    'jpeg',
                    'salesforce-vas-dashboard'
                  )
                }
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-xs transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Download JPG
              </button>
              <button
                type="button"
                onClick={() => {
                  setRecords([]);
                  setGeneratedPreviewUrl('');
                  setStageView('generated');
                }}
                aria-label="Clear Output"
                title="Clear Output"
                className="inline-flex items-center justify-center min-h-[40px] px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-rose-50 hover:text-rose-600 text-slate-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {stageView === 'generated' && generatedPreviewUrl && (
            <div className="p-3 sm:p-6 stage-grid">
              <div className="max-w-4xl mx-auto rounded-xl overflow-hidden shadow-md border border-slate-300 bg-white">
                <img
                  src={generatedPreviewUrl}
                  alt="Generated Salesforce Dashboard Output"
                  className="w-full h-auto block"
                />
              </div>
            </div>
          )}

          {stageView === 'editor' && (
            <div className="p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900">Edit Data</h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addBlankRow}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Row
                  </button>
                  <button
                    type="button"
                    onClick={() => setStageView('generated')}
                    className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
                  >
                    Done
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs text-left min-w-[680px]">
                  <thead className="bg-slate-100 text-slate-700 font-bold uppercase text-[10px]">
                    <tr>
                      <th className="px-2 py-2.5">Dealer</th>
                      <th className="px-2 py-2.5">Opportunity Owner</th>
                      <th className="px-1 py-2.5 text-center">CD</th>
                      <th className="px-1 py-2.5 text-center">CDD</th>
                      <th className="px-1 py-2.5 text-center">IFC</th>
                      <th className="px-1 py-2.5 text-center">VS</th>
                      <th className="px-1 py-2.5 text-center">VSD</th>
                      <th className="px-1.5 py-2.5 text-center bg-sky-50">BILLS</th>
                      <th className="px-1.5 py-2.5 text-center bg-sky-50">VAS</th>
                      <th className="px-2 py-2.5 text-center">VAS %</th>
                      <th className="px-1.5 py-2.5 text-center">Del</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {records.map((row) => {
                      const bills = calcRowBills(row);
                      const vas = calcRowVas(row);
                      const pct = calcVasPct(bills, vas);
                      const heat = getVasHeatmapStyle(pct);
                      return (
                        <tr key={row.id} className="bg-white hover:bg-slate-50/70">
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={row.dealerCode}
                              onChange={(e) =>
                                updateRecordField(row.id, 'dealerCode', e.target.value)
                              }
                              className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 font-semibold text-slate-800 focus:border-sky-500 focus:outline-none"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={row.ownerName}
                              onChange={(e) =>
                                updateRecordField(row.id, 'ownerName', e.target.value)
                              }
                              className="w-40 rounded-lg border border-slate-200 px-2 py-1.5 text-slate-800 focus:border-sky-500 focus:outline-none"
                            />
                          </td>
                          {(['cd', 'cdd', 'ifc', 'vs', 'vsd'] as const).map((field) => (
                            <td key={field} className="px-1 py-1.5 text-center">
                              <input
                                type="number"
                                min={0}
                                value={row[field]}
                                onChange={(e) =>
                                  updateRecordField(
                                    row.id,
                                    field,
                                    Math.max(0, parseInt(e.target.value || '0', 10) || 0)
                                  )
                                }
                                className="w-11 text-center rounded-lg border border-slate-200 py-1.5 font-mono font-semibold text-slate-800 focus:border-sky-500 focus:outline-none"
                              />
                            </td>
                          ))}
                          <td className="px-1.5 py-1.5 text-center font-bold text-slate-900 bg-sky-50/50">
                            {bills}
                          </td>
                          <td className="px-1.5 py-1.5 text-center font-bold text-slate-900 bg-sky-50/50">
                            {vas}
                          </td>
                          <td
                            className="px-2 py-1.5 text-center font-bold whitespace-nowrap"
                            style={{ backgroundColor: heat.bg, color: heat.text }}
                          >
                            {pct.toFixed(2)}%
                          </td>
                          <td className="px-1.5 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => deleteRow(row.id)}
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                              title="Delete row"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Paste Table Modal */}
      {pasteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4">
          <div className="w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Paste Salesforce / Excel Table
                </h3>
                <p className="text-xs text-slate-500">
                  Copy rows from Salesforce or Excel and paste below
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPasteOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <textarea
                rows={8}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={
                  'FinnOne Dealer Code\tOpportunity Owner\tCD\tCDD\tVS\tVSD\tIFC\n14126\tAmmanaboina Gopi\t1\t1\t0\t0\t0'
                }
                className="w-full rounded-xl border border-slate-300 p-3 text-xs font-mono text-slate-800 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPasteOpen(false)}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApplyPaste}
                  className="px-4 py-2.5 rounded-xl text-xs font-semibold text-white bg-sky-600 hover:bg-sky-700"
                >
                  Generate Dashboard
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <CameraCaptureModal
        isOpen={cameraOpen}
        onCapture={(dataUrl) => void runImageExtraction(dataUrl)}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
};
