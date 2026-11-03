import { useEffect, useRef, useState } from "react";
import { ChevronDown, Mic, MonitorUp, Upload } from "lucide-react";
import { startRecording, importAudioFile } from "../lib/session";
import { canCaptureScreen } from "../lib/platform";
import { toast, toastError } from "../lib/toast";
import type { CaptureMode } from "../lib/recorder";

interface Props {
  noteId?: string;
  onStarted?: (noteId: string) => void;
  variant?: "primary" | "hero";
  label?: string;
}

export function RecordButton({ noteId, onStarted, variant = "primary", label }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const start = async (mode: CaptureMode) => {
    setOpen(false);
    setBusy(true);
    try {
      const id = await startRecording(mode, noteId);
      onStarted?.(id);
      if (mode === "screen") toast("Merekam. Notesy menangkap slide otomatis setiap kali layar berganti.", "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const id = await importAudioFile(f);
      onStarted?.(id);
      toast("Audio diimpor, transkripsi berjalan.", "success");
    } catch (e) {
      toastError(e);
    }
  };

  const primaryMode: CaptureMode = canCaptureScreen ? "screen" : "mic";

  return (
    <div className={`record-split ${variant}`} ref={ref}>
      <button className="btn btn-record" disabled={busy} onClick={() => start(primaryMode)}>
        <span className="rec-dot" />
        {label ?? (canCaptureScreen ? "Rekam rapat" : "Mulai rekam")}
      </button>
      <button className="btn btn-record split-caret" disabled={busy} onClick={() => setOpen((v) => !v)} aria-label="Pilihan rekam">
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {canCaptureScreen && (
            <button role="menuitem" onClick={() => start("screen")}>
              <MonitorUp size={16} />
              <div>
                <b>Layar + audio rapat</b>
                <small>Untuk Teams/Zoom desktop atau tab. Centang “bagikan audio sistem”.</small>
              </div>
            </button>
          )}
          <button role="menuitem" onClick={() => start("mic")}>
            <Mic size={16} />
            <div>
              <b>Mikrofon saja</b>
              <small>Rapat tatap muka, atau perangkat yang tidak bisa berbagi layar.</small>
            </div>
          </button>
          <button role="menuitem" onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
            <div>
              <b>Impor file audio/video</b>
              <small>mp3, m4a, wav, webm, mp4</small>
            </div>
          </button>
        </div>
      )}
      <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
    </div>
  );
}
