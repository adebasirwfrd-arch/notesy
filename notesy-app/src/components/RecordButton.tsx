import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Mic, MonitorUp, Upload } from "lucide-react";
import { startRecording, importAudioFile } from "../lib/session";
import { TARGET, canCaptureScreen } from "../lib/platform";
import { toast, toastError } from "../lib/toast";
import type { CaptureMode } from "../lib/recorder";
import type { Mom } from "../lib/types";
import { getNote, updateNote } from "../lib/db";
import { saveLastForm } from "../lib/mom";
import { MomStartDialog } from "./mom/MomStartDialog";

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

  const [form, setForm] = useState<{ mode: CaptureMode; initial?: Mom; title: string } | null>(null);

  const askInfo = async (mode: CaptureMode) => {
    setOpen(false);
    const note = noteId ? await getNote(noteId) : undefined;
    setForm({ mode, initial: note?.mom, title: note && !note.titleIsAuto ? note.title : "" });
  };

  const start = async (mode: CaptureMode, mom?: Mom, title?: string) => {
    setForm(null);
    setBusy(true);
    try {
      const id = await startRecording(mode, noteId);
      if (mom || title) {
        await updateNote(id, (n) => {
          if (mom) n.mom = { ...(n.mom ?? {}), ...mom };
          if (title) {
            n.title = title;
            n.titleIsAuto = false;
          }
        });
        if (mom) void saveLastForm(mom);
      }
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
      <button className="btn btn-record" disabled={busy} onClick={() => askInfo(primaryMode)}>
        <span className="rec-dot" />
        {label ?? (canCaptureScreen ? "Rekam rapat" : "Mulai rekam")}
      </button>
      <button className="btn btn-record split-caret" disabled={busy} onClick={() => setOpen((v) => !v)} aria-label="Pilihan rekam">
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {canCaptureScreen && (
            <button role="menuitem" onClick={() => askInfo("screen")}>
              <MonitorUp size={16} />
              <div>
                {TARGET === "android" ? (
                  <>
                    <b>Layar + mikrofon</b>
                    <small>Slide dari Meet/Teams/presentasi di HP tertangkap otomatis. Suara lewat mikrofon: nyalakan speaker, jangan pakai earphone.</small>
                  </>
                ) : (
                  <>
                    <b>Layar + audio rapat</b>
                    <small>Untuk Teams/Zoom desktop atau tab. Centang “bagikan audio sistem”.</small>
                  </>
                )}
              </div>
            </button>
          )}
          <button role="menuitem" onClick={() => askInfo("mic")}>
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
      {form &&
        createPortal(
          <MomStartDialog
            initial={form.initial}
            title={form.title}
            onClose={() => setForm(null)}
            onSkip={() => start(form.mode)}
            onStart={(mom, title) => start(form.mode, mom, title)}
          />,
          document.body,
        )}
    </div>
  );
}
