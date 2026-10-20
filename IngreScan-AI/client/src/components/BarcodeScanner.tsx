import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  checkBarcode,
  liveBarcodeFeedback,
  pickBestCandidate,
  type BarcodeFormat,
} from "@/lib/barcode";
import {
  CameraError,
  decodeBarcodeFromFile,
  openCameraStream,
  startLiveDecoding,
  stopStream,
  type LiveScanHandle,
} from "@/lib/barcodeDecode";
import { AlertCircle, Barcode, Camera, CheckCircle2, Loader2, Upload, Volume2, VolumeX, X } from "lucide-react";
import { playScanBeep, isAudioMuted, setAudioMuted, subscribeAudioMute } from "@/lib/scannerAudio";
import { useCallback, useEffect, useRef, useState } from "react";

export type ScannedBarcode = {
  /** Digits as scanned or typed. */
  code: string;
  /** Code to send to Open Food Facts (UPC-A and UPC-E padded to 13 digits). */
  lookupCode: string;
  format?: BarcodeFormat;
  source: "camera" | "photo" | "manual";
  /** False when the user explicitly chose to look up a code whose check digit is wrong. */
  checksumValid: boolean;
};

type Props = {
  /** Called once per confirmed code (repeats of the same scanned code within a few seconds are dropped). */
  onDetected: (b: ScannedBarcode) => void;
  disabled?: boolean;
  initialValue?: string;
  className?: string;
  /** Prefix for element ids so several scanners can live on one page. */
  idPrefix?: string;
  /** Hide the typed-entry form when the host page already has its own barcode field. */
  hideManual?: boolean;
};

type CameraState = "idle" | "starting" | "scanning";
type Pending = { code: string; lookupCode: string; format?: BarcodeFormat; source: "camera" | "photo"; message: string };

const DEBOUNCE_MS = 3000;

function lookupFor(code: string): string {
  return code.length === 12 ? "0" + code : code;
}

export function BarcodeScanner({ onDetected, disabled = false, initialValue = "", className = "", idPrefix = "barcode", hideManual = false }: Props) {
  const [manual, setManual] = useState(initialValue);

  useEffect(() => {
    setManual(initialValue);
  }, [initialValue]);

  const [muted, setMuted] = useState(() => isAudioMuted());
  useEffect(() => subscribeAudioMute(setMuted), []);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [liveHint, setLiveHint] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoProgress, setPhotoProgress] = useState<string | null>(null);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handleRef = useRef<LiveScanHandle | null>(null);
  const sessionRef = useRef(0); // bumped on every start/stop so stale async work can detect it was cancelled
  const abortRef = useRef<AbortController | null>(null);
  const lastEmitRef = useRef<{ key: string; at: number } | null>(null);
  const invalidSeenRef = useRef<Map<string, number>>(new Map());
  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const unmountedRef = useRef(false);

  const emit = useCallback((b: ScannedBarcode) => {
    if (b.source !== "manual") {
      const key = b.lookupCode;
      const last = lastEmitRef.current;
      const now = Date.now();
      if (last && last.key === key && now - last.at < DEBOUNCE_MS) return; // same code re-read on the next frame
      lastEmitRef.current = { key, at: now };
    }
    onDetectedRef.current(b);
  }, []);

  const stopCamera = useCallback(() => {
    sessionRef.current++;
    handleRef.current?.stop();
    handleRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    const v = videoRef.current;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      v.srcObject = null;
    }
    invalidSeenRef.current.clear();
    if (!unmountedRef.current) {
      setCameraState("idle");
      setLiveHint(null);
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    const onVisibility = () => {
      if (document.hidden) stopCamera(); // release the camera when the tab is backgrounded
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unmountedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current?.abort();
      stopCamera();
    };
  }, [stopCamera]);

  const startCamera = async () => {
    if (disabled || cameraState !== "idle") return;
    setCameraError(null);
    setPending(null);
    setPhotoMessage(null);
    const session = ++sessionRef.current;
    setCameraState("starting");
    let stream: MediaStream | null = null;
    try {
      stream = await openCameraStream();
      if (session !== sessionRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new CameraError("other", "The camera preview could not be shown.");
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (session !== sessionRef.current) return;
      const handle = await startLiveDecoding(video, (candidates) => {
        if (session !== sessionRef.current) return;
            const best = pickBestCandidate(candidates);
        if (!best) return;
        if (best.check.ok) {
          const c = best.check;
          stopCamera();
          setManual(c.code);
          emit({ code: c.code, lookupCode: c.lookupCode, format: c.format, source: "camera", checksumValid: true });
          return;
        }
        // An unreadable-checksum read is often a one-frame misread: only warn after seeing the same code twice.
        const seen = (invalidSeenRef.current.get(best.check.code) ?? 0) + 1;
        invalidSeenRef.current.set(best.check.code, seen);
        if (seen >= 2) {
          setLiveHint(`Read ${best.check.code} but its check digit does not match. Hold steady, closer, and avoid glare.`);
        }
      });
      if (session !== sessionRef.current) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
      setCameraState("scanning");
    } catch (err: any) {
      stopStream(stream);
      if (session !== sessionRef.current) return;
      streamRef.current = null;
      sessionRef.current++;
      setCameraState("idle");
      setCameraError(
        err instanceof CameraError
          ? err.message
          : "Could not start the barcode reader. Use \"Scan from photo\" or type the number instead.",
      );
    }
  };

  const handlePhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    input.value = ""; // allow selecting the same photo again
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoMessage("Please choose an image file (JPG or PNG).");
      return;
    }
    stopCamera();
    setPending(null);
    setPhotoMessage(null);
    setCameraError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setPhotoBusy(true);
    setPhotoProgress("Reading photo...");
    try {
      const result = await decodeBarcodeFromFile(file, {
        signal: ac.signal,
        onProgress: (variant, i, total) => {
          if (!unmountedRef.current) setPhotoProgress(i === 0 ? "Reading photo..." : `Trying enhanced decoding (${i + 1}/${total})...`);
        },
      });
      if (ac.signal.aborted || unmountedRef.current) return;
      if (result.status === "found" && result.best.check.ok) {
        const c = result.best.check;
        setManual(c.code);
        emit({ code: c.code, lookupCode: c.lookupCode, format: c.format, source: "photo", checksumValid: true });
      } else if (result.status === "invalid" && !result.best.check.ok) {
        const c = result.best.check;
        setManual(c.code);
        setPending({
          code: c.code,
          lookupCode: lookupFor(c.code),
          format: c.format,
          source: "photo",
          message: `We read ${c.code}, but its check digit does not match, so it may have been misread.`,
        });
      } else if (result.status === "error") {
        setPhotoMessage(result.message);
      } else {
        setPhotoMessage(
          "No barcode found in this photo. Try again with the barcode filling most of the frame, in good light, without glare or blur, and keep the phone steady. You can also type the number below.",
        );
      }
    } finally {
      if (!unmountedRef.current) {
        setPhotoBusy(false);
        setPhotoProgress(null);
      }
    }
  };

  const feedback = liveBarcodeFeedback(manual);
  const manualCheck = checkBarcode(manual);

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    stopCamera();
    setPending(null);
    if (manualCheck.ok) {
      emit({ code: manualCheck.code, lookupCode: manualCheck.lookupCode, format: manualCheck.format, source: "manual", checksumValid: true });
    } else if (manualCheck.reason === "bad_checksum") {
      // Explicit confirmation: the button reads "Look up anyway" while this warning is visible.
      emit({ code: manualCheck.code, lookupCode: lookupFor(manualCheck.code), format: manualCheck.format, source: "manual", checksumValid: false });
    }
  };

  const canSubmit = !disabled && (manualCheck.ok || (!manualCheck.ok && manualCheck.reason === "bad_checksum"));
  const cameraBusy = cameraState !== "idle";
  const id = (s: string) => `${idPrefix}-${s}`;

  return (
    <div className={`space-y-5 ${className}`} data-testid="barcode-scanner">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {cameraBusy ? (
          <Button type="button" variant="dark" onClick={stopCamera} className="w-full sm:w-auto" data-testid="barcode-camera-stop">
            <X className="h-4 w-4" />
            Stop camera
          </Button>
        ) : (
          <Button type="button" onClick={startCamera} disabled={disabled || photoBusy} className="w-full sm:w-auto" data-testid="barcode-camera-start">
            <Camera className="h-4 w-4" />
            Scan with camera
          </Button>
        )}
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <label htmlFor={id("photo")} className={disabled || photoBusy ? "pointer-events-none opacity-50" : "cursor-pointer"}>
            <Upload className="h-4 w-4" />
            Scan from photo
          </label>
        </Button>
        <Button asChild variant="outline" className="w-full sm:hidden">
          <label htmlFor={id("photo-capture")} className={disabled || photoBusy ? "pointer-events-none opacity-50" : "cursor-pointer"}>
            <Camera className="h-4 w-4" />
            Take a photo
          </label>
        </Button>
        <input id={id("photo")} data-testid="barcode-photo-input" type="file" accept="image/*" className="sr-only" onChange={handlePhoto} disabled={disabled || photoBusy} />
        <input id={id("photo-capture")} type="file" accept="image/*" capture="environment" className="sr-only" onChange={handlePhoto} disabled={disabled || photoBusy} />
      </div>

      {/* Live preview (always mounted so the ref exists when the stream starts) */}
      <div className={cameraBusy ? "space-y-2" : "hidden"}>
        <div className="relative mx-auto aspect-[4/3] w-full max-w-xl overflow-hidden rounded-3xl bg-graphite">
          <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-cover" aria-label="Camera preview" data-testid="barcode-video" />
          <div className="absolute top-3 right-3 z-10">
            <button
              type="button"
              onClick={() => {
                const next = !muted;
                setMuted(next);
                setAudioMuted(next);
              }}
              className="flex items-center gap-1.5 rounded-full bg-graphite/80 backdrop-blur-md px-3 py-1.5 text-xs font-bold text-white shadow-md hover:bg-graphite transition-all"
              title={muted ? "Sound muted: Click to enable chimes" : "Sound ON: Click to mute"}
            >
              {muted ? <VolumeX className="h-3.5 w-3.5 text-signal-red-orange" /> : <Volume2 className="h-3.5 w-3.5 text-verdant-green" />}
              <span>{muted ? "Muted" : "Chimes ON"}</span>
            </button>
          </div>
          <div className="pointer-events-none absolute inset-x-[10%] top-1/2 h-0.5 -translate-y-1/2 bg-ember-orange" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-[12%] rounded-3xl border-2 border-white/80" aria-hidden="true" />
          {cameraState === "starting" && (
            <div className="absolute inset-0 grid place-items-center bg-graphite/70 text-white">
              <span className="inline-flex items-center gap-2 text-sm font-bold">
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting camera...
              </span>
            </div>
          )}
        </div>
        <p className="text-center text-sm font-medium text-muted-foreground" role="status" data-testid="barcode-live-status">
          {liveHint ?? (cameraState === "scanning" ? "Point the camera at the barcode and hold steady." : "Allow camera access if your browser asks.")}
        </p>
      </div>

      {cameraError && (
        <div role="alert" className="flex items-start gap-3 rounded-3xl bg-fog p-4" data-testid="barcode-camera-error">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-signal-red-orange" />
          <p className="text-sm font-medium text-graphite">{cameraError}</p>
        </div>
      )}

      {photoBusy && (
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground" role="status" data-testid="barcode-photo-progress">
          <Loader2 className="h-4 w-4 animate-spin text-ember-orange" />
          {photoProgress}
        </p>
      )}

      {photoMessage && (
        <div role="alert" className="flex items-start gap-3 rounded-3xl bg-fog p-4" data-testid="barcode-photo-message">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-signal-red-orange" />
          <p className="text-sm font-medium text-graphite">{photoMessage}</p>
        </div>
      )}

      {pending && (
        <div role="alert" className="space-y-3 rounded-3xl bg-fog p-4" data-testid="barcode-pending-invalid">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-signal-red-orange" />
            <p className="text-sm font-medium text-graphite">{pending.message} Check the number below, or look it up anyway.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                const p = pending;
                setPending(null);
                emit({ code: p.code, lookupCode: p.lookupCode, format: p.format, source: p.source, checksumValid: false });
              }}
            >
              Look up anyway
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {!hideManual && (
      <form onSubmit={submitManual} className="space-y-2">
        <label htmlFor={id("manual")} className="block text-sm font-bold text-graphite">
          Or type the barcode number
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Barcode className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={id("manual")}
              data-testid="barcode-manual-input"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="e.g., 3017620422003"
              inputMode="numeric"
              autoComplete="off"
              className="pl-12 font-mono text-base"
              disabled={disabled}
              aria-describedby={id("manual-feedback")}
              aria-invalid={feedback.state === "invalid"}
            />
          </div>
          <Button
            type="submit"
            variant={!manualCheck.ok && manualCheck.reason === "bad_checksum" ? "outline" : "default"}
            disabled={!canSubmit}
            data-testid="barcode-manual-submit"
          >
            {!manualCheck.ok && manualCheck.reason === "bad_checksum" ? "Look up anyway" : "Look up product"}
          </Button>
        </div>
        <p id={id("manual-feedback")} role="status" className="flex min-h-5 items-start gap-2 text-sm font-medium" data-testid="barcode-manual-feedback">
          {feedback.state === "valid" && (
            <>
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-verdant-green" />
              <span className="text-graphite">Valid {formatLabel(feedback.check.format)} barcode.</span>
            </>
          )}
          {feedback.state === "invalid" && (
            <>
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-signal-red-orange" />
              <span className="text-graphite">
                {feedback.check.message}
                {feedback.check.reason === "bad_checksum" && " Some products on Open Food Facts do have invalid codes, so you can still look it up."}
              </span>
            </>
          )}
          {feedback.state === "incomplete" && <span className="text-muted-foreground">{feedback.message}</span>}
        </p>
      </form>
      )}
    </div>
  );
}

function formatLabel(f: BarcodeFormat): string {
  return { ean_13: "EAN-13", ean_8: "EAN-8", upc_a: "UPC-A", upc_e: "UPC-E" }[f];
}

export default BarcodeScanner;
