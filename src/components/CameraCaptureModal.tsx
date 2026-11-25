import React, { useEffect, useRef, useState } from 'react';
import { Camera, Upload, X } from 'lucide-react';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

export function isTouchMobileDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(pointer: coarse)').matches &&
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onCapture,
  onClose,
}) => {
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }

    let cancelled = false;
    setCameraError('');

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Live camera preview is unavailable in this browser. Choose a photo below.');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch {
        if (!cancelled) {
          setCameraError('Could not access camera. You can still take or select a photo below.');
        }
      }
    }

    void startCamera();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  function captureFrame() {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    onClose();
    onCapture(dataUrl);
  }

  function handleFallbackFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      if (url) {
        onClose();
        onCapture(url);
      }
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/65 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-slate-100">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Camera className="w-4 h-4 text-sky-600" />
            Capture Image from Camera
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            aria-label="Close camera"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 sm:p-5 space-y-4">
          {cameraError ? (
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-xs text-amber-900">
              {cameraError}
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden bg-slate-950 aspect-video flex items-center justify-center">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain"
              />
            </div>
          )}

          <input
            ref={fallbackInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFallbackFile(f);
              e.target.value = '';
            }}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => fallbackInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs font-semibold text-slate-700"
            >
              <Upload className="w-3.5 h-3.5" />
              Use Device Camera / File
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              {!cameraError && (
                <button
                  type="button"
                  onClick={captureFrame}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold text-white bg-sky-600 hover:bg-sky-700"
                >
                  <Camera className="w-3.5 h-3.5" />
                  Capture Photo
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
