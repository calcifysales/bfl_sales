import React, { useEffect, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Camera,
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
import {
  downloadCanvasImage,
  exportCanvasAsPdf,
  renderGenericTableToCanvas,
} from '../utils/dashboardCanvasRenderer';
import { extractTableMatrixFromImage } from '../utils/tableImageExtractor';
import {
  CameraCaptureModal,
  isTouchMobileDevice,
} from './CameraCaptureModal';

type StageView = 'output' | 'editor';

export const ReportsEnhancerTab: React.FC = () => {
  const [matrix, setMatrix] = useState<string[][]>([]);
  const [outputUrl, setOutputUrl] = useState<string>('');
  const [stageView, setStageView] = useState<StageView>('output');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string>('');
  const [cameraOpen, setCameraOpen] = useState(false);

  const outputCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mobileCameraInputRef = useRef<HTMLInputElement | null>(null);

  // Re-render crisp digitalized table image whenever matrix changes
  useEffect(() => {
    if (matrix.length === 0) {
      outputCanvasRef.current = null;
      setOutputUrl('');
      return;
    }
    const canvas = renderGenericTableToCanvas(matrix, 3);
    outputCanvasRef.current = canvas;
    setOutputUrl(canvas.toDataURL('image/png'));
  }, [matrix]);

  async function processImageDataUrl(dataUrl: string) {
    setIsProcessing(true);
    setErrorBanner('');
    setProgressPct(10);
    setProgressText('Extracting table from image...');
    try {
      const result = await extractTableMatrixFromImage(dataUrl, (msg, pct) => {
        setProgressText(msg);
        setProgressPct(pct);
      });
      if (result.matrix.length > 0) {
        setMatrix(result.matrix);
        setStageView('output');
      } else {
        setErrorBanner(
          'Could not detect table rows in this image. Try a clearer crop or upload Excel/CSV.'
        );
      }
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : 'Unable to process attached image'
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
      setProgressPct(60);
      try {
        const buffer = await file.arrayBuffer();
        const wb = XLSX.read(buffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
          header: 1,
          defval: '',
        });
        const clean = raw
          .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '').trim()) : []))
          .filter((r) => r.some((c) => c !== ''));
        if (clean.length === 0) {
          setErrorBanner(`No rows found in ${file.name}.`);
        } else {
          setMatrix(clean);
          setStageView('output');
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
      const url = String(reader.result || '');
      if (url) void processImageDataUrl(url);
    };
    reader.readAsDataURL(file);
  }

  function handleCameraClick() {
    if (isTouchMobileDevice()) {
      mobileCameraInputRef.current?.click();
    } else {
      setCameraOpen(true);
    }
  }

  function updateCell(rIdx: number, cIdx: number, val: string) {
    setMatrix((prev) =>
      prev.map((row, r) =>
        r === rIdx ? row.map((cell, c) => (c === cIdx ? val : cell)) : row
      )
    );
  }

  function addRow() {
    const cols = Math.max(1, ...matrix.map((r) => r.length));
    setMatrix((prev) => [...prev, new Array<string>(cols).fill('')]);
  }

  function deleteRow(rIdx: number) {
    setMatrix((prev) => prev.filter((_, idx) => idx !== rIdx));
  }

  function exportExcel() {
    if (matrix.length === 0) return;
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, 'digitalized-report.xlsx');
  }

  const colCount = Math.max(1, ...matrix.map((r) => r.length));

  return (
    <div className="space-y-5">
      {/* Simple Mobile-Friendly Upload & Camera Card */}
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
            Attach Camera Photo or Excel / CSV
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Converts table in image into a clean digitalized output image
          </p>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            disabled={isProcessing}
            onClick={handleCameraClick}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] w-full sm:w-64 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 disabled:opacity-45 text-xs sm:text-sm font-semibold text-white transition-colors"
          >
            <Camera className="w-4 h-4" />
            Camera
          </button>
        </div>

        {isProcessing && (
          <div className="rounded-xl bg-sky-50 border border-sky-200 p-3 space-y-2 max-w-xl mx-auto">
            <div className="flex items-center justify-between text-xs font-semibold text-sky-900">
              <span className="flex items-center gap-1.5">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                {progressText || 'Extracting table...'}
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

      {/* Digitalized Output Image Card */}
      {matrix.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1">
              <button
                type="button"
                onClick={() => setStageView('output')}
                className={`px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                  stageView === 'output'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Digitalized Output
              </button>
              <button
                type="button"
                onClick={() =>
                  setStageView((v) => (v === 'editor' ? 'output' : 'editor'))
                }
                aria-label="Edit Table Text"
                title="Edit Table Text"
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
                onClick={exportExcel}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                Excel
              </button>
              <button
                type="button"
                onClick={() =>
                  outputCanvasRef.current &&
                  exportCanvasAsPdf(outputCanvasRef.current, 'digitalized-report')
                }
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700"
              >
                <FileText className="w-3.5 h-3.5 text-rose-600" />
                PDF
              </button>
              <button
                type="button"
                onClick={() =>
                  outputCanvasRef.current &&
                  downloadCanvasImage(outputCanvasRef.current, 'jpeg', 'digitalized-report')
                }
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold shadow-xs"
              >
                <Download className="w-3.5 h-3.5" />
                Download JPG
              </button>
              <button
                type="button"
                onClick={() => {
                  setMatrix([]);
                  setOutputUrl('');
                  setStageView('output');
                }}
                aria-label="Clear Output"
                title="Clear Output"
                className="inline-flex items-center justify-center min-h-[40px] px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-rose-50 hover:text-rose-600 text-slate-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {stageView === 'output' && outputUrl && (
            <div className="p-3 sm:p-6 stage-grid">
              <div className="max-w-4xl mx-auto rounded-xl overflow-hidden shadow-md border border-slate-300 bg-white">
                <img
                  src={outputUrl}
                  alt="Digitalized Report Table Output"
                  className="w-full h-auto block"
                />
              </div>
            </div>
          )}

          {stageView === 'editor' && (
            <div className="p-4 sm:p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-slate-900">Edit Extracted Table</h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addRow}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Row
                  </button>
                  <button
                    type="button"
                    onClick={() => setStageView('output')}
                    className="px-3.5 py-2 rounded-xl bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
                  >
                    Done
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs text-left">
                  <tbody className="divide-y divide-slate-200">
                    {matrix.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className={rIdx === 0 ? 'bg-sky-50/70 font-semibold' : 'bg-white'}
                      >
                        {Array.from({ length: colCount }).map((_, cIdx) => (
                          <td key={cIdx} className="px-1.5 py-1.5">
                            <input
                              type="text"
                              value={row[cIdx] ?? ''}
                              onChange={(e) => updateCell(rIdx, cIdx, e.target.value)}
                              className="min-w-[56px] w-full rounded-lg border border-slate-200 px-2 py-1.5 text-slate-800 focus:border-sky-500 focus:outline-none"
                            />
                          </td>
                        ))}
                        <td className="px-1.5 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() => deleteRow(rIdx)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                            title="Delete row"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <CameraCaptureModal
        isOpen={cameraOpen}
        onCapture={(dataUrl) => void processImageDataUrl(dataUrl)}
        onClose={() => setCameraOpen(false)}
      />
    </div>
  );
};
