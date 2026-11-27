import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  Camera,
  Check,
  Crop,
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
import {
  extractTableMatrixFromImage,
  type CornerPoints,
  type ExtractedCell,
  type ExtractedTableResult,
} from '../utils/tableImageExtractor';
import {
  CameraCaptureModal,
  isTouchMobileDevice,
} from './CameraCaptureModal';

type StageView = 'output' | 'editor' | 'crop';
type CornerKey = keyof CornerPoints;

const FULL_FRAME_CORNERS: CornerPoints = {
  tl: { x: 0.02, y: 0.02 },
  tr: { x: 0.98, y: 0.02 },
  br: { x: 0.98, y: 0.98 },
  bl: { x: 0.02, y: 0.98 },
};

export const ReportsEnhancerTab: React.FC = () => {
  const [cells, setCells] = useState<ExtractedCell[][]>([]);
  const [extractionMeta, setExtractionMeta] = useState<{
    originalImageUrl: string;
    dewarpedImageUrl: string;
    dewarpedDimensions: { width: number; height: number };
    averageConfidence: number;
    rowIntegrityWarnings: string[];
    skewAngleDeg: number;
    fromSpreadsheet: boolean;
  } | null>(null);

  const [selectedCell, setSelectedCell] = useState<{ r: number; c: number } | null>(null);
  const [corners, setCorners] = useState<CornerPoints>(FULL_FRAME_CORNERS);

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
  const cropStageRef = useRef<HTMLDivElement | null>(null);
  const activeCornerRef = useRef<CornerKey | null>(null);

  const matrix = useMemo(
    () => cells.map((row) => row.map((cell) => cell.value)),
    [cells]
  );

  const flaggedCoords = useMemo(() => {
    const list: Array<{ r: number; c: number }> = [];
    cells.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell.uncertain && !cell.verifiedByUser) {
          list.push({ r, c });
        }
      });
    });
    return list;
  }, [cells]);

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

  async function processImageDataUrl(dataUrl: string, customCorners?: CornerPoints) {
    setIsProcessing(true);
    setErrorBanner('');
    setProgressPct(10);
    setProgressText('Extracting table from image...');
    try {
      const result: ExtractedTableResult = await extractTableMatrixFromImage(
        dataUrl,
        (msg, pct) => {
          setProgressText(msg);
          setProgressPct(pct);
        },
        customCorners ? { customCorners } : {}
      );

      if (result.cells.length > 0) {
        setCells(result.cells);
        setExtractionMeta({
          originalImageUrl: result.originalImageUrl,
          dewarpedImageUrl: result.dewarpedImageUrl,
          dewarpedDimensions: result.dewarpedDimensions,
          averageConfidence: result.averageConfidence,
          rowIntegrityWarnings: result.rowIntegrityWarnings,
          skewAngleDeg: result.skewAngleDeg,
          fromSpreadsheet: false,
        });
        if (!customCorners) {
          setCorners(FULL_FRAME_CORNERS);
        }

        const firstFlagged = findFirstFlagged(result.cells);
        setSelectedCell(firstFlagged);
        setStageView(result.canReconstructReliably ? 'output' : 'editor');
        if (!result.canReconstructReliably) {
          setErrorBanner(
            'Low structural confidence — please review against the original photo or adjust 4-corner crop.'
          );
        }
      } else {
        setExtractionMeta({
          originalImageUrl: dataUrl,
          dewarpedImageUrl: dataUrl,
          dewarpedDimensions: { width: 1000, height: 700 },
          averageConfidence: 0,
          rowIntegrityWarnings: [],
          skewAngleDeg: 0,
          fromSpreadsheet: false,
        });
        setStageView('crop');
        setErrorBanner(
          'Could not reliably reconstruct the table automatically. Adjust the 4 corners onto your table and tap Re-Extract.'
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

  function findFirstFlagged(tableCells: ExtractedCell[][]): { r: number; c: number } | null {
    for (let r = 0; r < tableCells.length; r++) {
      for (let c = 0; c < tableCells[r].length; c++) {
        if (tableCells[r][c].uncertain && !tableCells[r][c].verifiedByUser) {
          return { r, c };
        }
      }
    }
    return tableCells.length > 0 && tableCells[0].length > 0 ? { r: 0, c: 0 } : null;
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
          setCells(
            clean.map((row) =>
              row.map((val) => ({
                value: val,
                confidence: 100,
                uncertain: false,
                reasons: [],
                isIdColumn: false,
                verifiedByUser: true,
              }))
            )
          );
          setExtractionMeta({
            originalImageUrl: '',
            dewarpedImageUrl: '',
            dewarpedDimensions: { width: 0, height: 0 },
            averageConfidence: 100,
            rowIntegrityWarnings: [],
            skewAngleDeg: 0,
            fromSpreadsheet: true,
          });
          setSelectedCell(null);
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
    setCells((prev) =>
      prev.map((row, r) =>
        r === rIdx
          ? row.map((cell, c) =>
              c === cIdx
                ? {
                    ...cell,
                    value: val,
                    verifiedByUser: true,
                    uncertain: false,
                  }
                : cell
            )
          : row
      )
    );
  }

  function verifyCell(rIdx: number, cIdx: number) {
    setCells((prev) =>
      prev.map((row, r) =>
        r === rIdx
          ? row.map((cell, c) =>
              c === cIdx ? { ...cell, verifiedByUser: true, uncertain: false } : cell
            )
          : row
      )
    );
    // Advance to next flagged cell automatically
    const next = flaggedCoords.find((p) => !(p.r === rIdx && p.c === cIdx));
    if (next) setSelectedCell(next);
  }

  function addRow() {
    const cols = Math.max(1, ...cells.map((r) => r.length));
    setCells((prev) => [
      ...prev,
      Array.from({ length: cols }, () => ({
        value: '',
        confidence: 100,
        uncertain: false,
        reasons: [],
        isIdColumn: false,
        verifiedByUser: true,
      })),
    ]);
  }

  function addColumn() {
    setCells((prev) =>
      prev.map((row) => [
        ...row,
        {
          value: '',
          confidence: 100,
          uncertain: false,
          reasons: [],
          isIdColumn: false,
          verifiedByUser: true,
        },
      ])
    );
  }

  function deleteRow(rIdx: number) {
    setCells((prev) => prev.filter((_, idx) => idx !== rIdx));
    setSelectedCell(null);
  }

  function exportExcel() {
    if (matrix.length === 0) return;
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, 'digitalized-report.xlsx');
  }

  function handleCropPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const key = activeCornerRef.current;
    const stage = cropStageRef.current;
    if (!key || !stage) return;
    const rect = stage.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setCorners((prev) => ({ ...prev, [key]: { x: nx, y: ny } }));
  }

  const colCount = Math.max(1, ...cells.map((r) => r.length));
  const activeCellObj =
    selectedCell && cells[selectedCell.r]?.[selectedCell.c]
      ? cells[selectedCell.r][selectedCell.c]
      : null;

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
            Converts table in image into a clean digitalized output with review flags
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

      {/* Digitalized Output & Visual Review Card */}
      {(cells.length > 0 || (extractionMeta && extractionMeta.originalImageUrl)) && (
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="px-4 sm:px-5 py-3 border-b border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2.5">
            <div className="inline-flex items-center gap-1 rounded-xl bg-slate-200/70 p-1">
              {cells.length > 0 && (
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
              )}
              {cells.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setStageView((v) => (v === 'editor' ? 'output' : 'editor'))
                  }
                  aria-label="Visual Review & Edit"
                  title="Visual Review & Edit"
                  className={`relative p-2 rounded-lg transition-all ${
                    stageView === 'editor'
                      ? 'bg-white text-sky-600 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <Pencil className="w-4 h-4" />
                  {flaggedCoords.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white" />
                  )}
                </button>
              )}
              {extractionMeta && !extractionMeta.fromSpreadsheet && extractionMeta.originalImageUrl && (
                <button
                  type="button"
                  onClick={() =>
                    setStageView((v) => (v === 'crop' ? 'output' : 'crop'))
                  }
                  aria-label="Adjust 4-Corner Crop"
                  title="Adjust 4-Corner Crop"
                  className={`p-2 rounded-lg transition-all ${
                    stageView === 'crop'
                      ? 'bg-white text-sky-600 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
                  }`}
                >
                  <Crop className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {flaggedCoords.length > 0 && stageView !== 'editor' && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCell(flaggedCoords[0]);
                    setStageView('editor');
                  }}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-xs font-semibold text-amber-900"
                >
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                  Review {flaggedCoords.length} Flagged
                </button>
              )}
              {cells.length > 0 && (
                <>
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
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setCells([]);
                  setExtractionMeta(null);
                  setSelectedCell(null);
                  setOutputUrl('');
                  setStageView('output');
                  setErrorBanner('');
                }}
                aria-label="Clear Output"
                title="Clear Output"
                className="inline-flex items-center justify-center min-h-[40px] px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-rose-50 hover:text-rose-600 text-slate-500 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Honest OCR Confidence & Integrity Strip (for camera/image inputs) */}
          {extractionMeta && !extractionMeta.fromSpreadsheet && cells.length > 0 && (
            <div className="px-4 sm:px-5 py-2 border-b border-slate-100 bg-slate-50/40 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
              <span>
                OCR avg confidence: <strong>{extractionMeta.averageConfidence}%</strong>
                {Math.abs(extractionMeta.skewAngleDeg) >= 0.35
                  ? ` · Auto-deskewed ${extractionMeta.skewAngleDeg}°`
                  : ''}
                {' · '}Verify flagged cells against the original photo.
              </span>
              {extractionMeta.rowIntegrityWarnings.length > 0 && (
                <span className="text-amber-800 font-semibold">
                  {extractionMeta.rowIntegrityWarnings.length} total mismatch warning(s)
                </span>
              )}
            </div>
          )}

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
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Visual Review & Manual Correction
                  </h3>
                  <p className="text-xs text-slate-500">
                    Tap any cell to inspect its original photo snippet. Amber cells require verification.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={addRow}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Row
                  </button>
                  <button
                    type="button"
                    onClick={addColumn}
                    className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Col
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

              {/* Active Cell Original-Photo Visual Inspector */}
              {activeCellObj && selectedCell && extractionMeta && !extractionMeta.fromSpreadsheet && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                  <div className="md:col-span-5 space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      Original Photo Crop (Row {selectedCell.r + 1}, Col {selectedCell.c + 1})
                    </div>
                    {activeCellObj.sourceCropDataUrl ? (
                      <div className="rounded-lg border border-slate-300 bg-white p-2 flex items-center justify-center min-h-[54px]">
                        <img
                          src={activeCellObj.sourceCropDataUrl}
                          alt="Original photo cell crop"
                          className="max-h-20 w-auto object-contain"
                        />
                      </div>
                    ) : (
                      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-400 text-center">
                        Empty cell region
                      </div>
                    )}
                  </div>

                  <div className="md:col-span-7 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-700">
                        Confidence: {activeCellObj.confidence}%
                        {activeCellObj.isIdColumn ? ' · Preserved as String ID' : ''}
                      </span>
                      {activeCellObj.uncertain && !activeCellObj.verifiedByUser && (
                        <button
                          type="button"
                          onClick={() => verifyCell(selectedCell.r, selectedCell.c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold"
                        >
                          <Check className="w-3 h-3" />
                          Confirm Value
                        </button>
                      )}
                    </div>
                    <input
                      type="text"
                      value={activeCellObj.value}
                      onChange={(e) =>
                        updateCell(selectedCell.r, selectedCell.c, e.target.value)
                      }
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-900 focus:border-sky-500 focus:outline-none"
                    />
                    {activeCellObj.reasons.length > 0 && (
                      <p className="text-[11px] text-amber-800">
                        {activeCellObj.reasons.join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Editable Table Grid with Uncertainty Highlights */}
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs text-left">
                  <tbody className="divide-y divide-slate-200">
                    {cells.map((row, rIdx) => (
                      <tr
                        key={rIdx}
                        className={rIdx === 0 ? 'bg-sky-50/70 font-semibold' : 'bg-white'}
                      >
                        {Array.from({ length: colCount }).map((_, cIdx) => {
                          const cell = row[cIdx];
                          const isSelected =
                            selectedCell?.r === rIdx && selectedCell?.c === cIdx;
                          const isFlagged = Boolean(cell?.uncertain && !cell?.verifiedByUser);
                          return (
                            <td key={cIdx} className="px-1.5 py-1.5">
                              <input
                                type="text"
                                value={cell?.value ?? ''}
                                onFocus={() => setSelectedCell({ r: rIdx, c: cIdx })}
                                onChange={(e) => updateCell(rIdx, cIdx, e.target.value)}
                                title={
                                  cell?.reasons.length
                                    ? cell.reasons.join(' | ')
                                    : `Confidence: ${cell?.confidence ?? 100}%`
                                }
                                className={`min-w-[64px] w-full rounded-lg border px-2 py-1.5 text-slate-800 focus:outline-none ${
                                  isSelected
                                    ? 'border-sky-500 ring-2 ring-sky-500/20 bg-white'
                                    : isFlagged
                                      ? 'border-amber-400 bg-amber-50 text-amber-950 font-medium'
                                      : 'border-slate-200'
                                }`}
                              />
                            </td>
                          );
                        })}
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

              {/* Full Original Source Photo Reference with Flagged Bounding Boxes */}
              {extractionMeta &&
                !extractionMeta.fromSpreadsheet &&
                extractionMeta.dewarpedImageUrl && (
                  <div className="space-y-2 pt-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-700">
                        Original Photograph Reference (Source of Truth)
                      </span>
                      <span className="text-[11px] text-slate-500">
                        Amber = flagged · Blue = selected · Tap any cell above to inspect
                      </span>
                    </div>
                    <div className="relative w-fit max-w-full mx-auto rounded-xl overflow-hidden border border-slate-300 bg-slate-900">
                      <img
                        src={extractionMeta.dewarpedImageUrl}
                        alt="Original Photograph Reference"
                        className="max-h-[420px] w-auto block"
                      />
                      <svg
                        viewBox={`0 0 ${extractionMeta.dewarpedDimensions.width || 1000} ${extractionMeta.dewarpedDimensions.height || 700}`}
                        preserveAspectRatio="none"
                        className="absolute inset-0 w-full h-full pointer-events-none"
                      >
                        {cells.map((row, rIdx) =>
                          row.map((cell, cIdx) => {
                            if (!cell.sourceBox) return null;
                            const isSel =
                              selectedCell?.r === rIdx && selectedCell?.c === cIdx;
                            const isFlag = cell.uncertain && !cell.verifiedByUser;
                            if (!isSel && !isFlag) return null;
                            const b = cell.sourceBox;
                            return (
                              <rect
                                key={`${rIdx}-${cIdx}`}
                                x={b.x0}
                                y={b.y0}
                                width={Math.max(4, b.x1 - b.x0)}
                                height={Math.max(4, b.y1 - b.y0)}
                                fill={
                                  isSel
                                    ? 'rgba(14, 165, 233, 0.2)'
                                    : 'rgba(245, 158, 11, 0.18)'
                                }
                                stroke={isSel ? '#0284C7' : '#D97706'}
                                strokeWidth={isSel ? 4 : 2.5}
                              />
                            );
                          })
                        )}
                      </svg>
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* 4-Corner Manual Perspective Correction Stage */}
          {stageView === 'crop' && extractionMeta?.originalImageUrl && (
            <div className="p-4 sm:p-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-700 font-medium">
                  Drag the 4 blue handles onto the corners of your table to correct perspective
                  distortion, then tap Re-Extract Table.
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCorners(FULL_FRAME_CORNERS)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Reset Corners
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() =>
                      void processImageDataUrl(extractionMeta.originalImageUrl, corners)
                    }
                    className="px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold"
                  >
                    Re-Extract Table
                  </button>
                </div>
              </div>

              <div
                ref={cropStageRef}
                onPointerMove={handleCropPointerMove}
                onPointerUp={() => {
                  activeCornerRef.current = null;
                }}
                onPointerLeave={() => {
                  activeCornerRef.current = null;
                }}
                className="relative mx-auto w-fit max-w-full rounded-xl overflow-hidden shadow-md border border-slate-300 select-none touch-none bg-slate-900"
              >
                <img
                  src={extractionMeta.originalImageUrl}
                  alt="Original Photograph Perspective Crop"
                  className="max-h-[480px] w-auto block"
                  draggable={false}
                />
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="absolute inset-0 w-full h-full pointer-events-none"
                >
                  <polygon
                    points={`${corners.tl.x * 100},${corners.tl.y * 100} ${corners.tr.x * 100},${corners.tr.y * 100} ${corners.br.x * 100},${corners.br.y * 100} ${corners.bl.x * 100},${corners.bl.y * 100}`}
                    fill="rgba(14, 165, 233, 0.14)"
                    stroke="#0284C7"
                    strokeWidth="0.6"
                  />
                </svg>
                {(['tl', 'tr', 'br', 'bl'] as CornerKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-label={`Adjust ${key} corner`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      activeCornerRef.current = key;
                    }}
                    style={{
                      left: `${corners[key].x * 100}%`,
                      top: `${corners[key].y * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-sky-600 border-2 border-white shadow-md cursor-grab active:cursor-grabbing"
                  />
                ))}
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
