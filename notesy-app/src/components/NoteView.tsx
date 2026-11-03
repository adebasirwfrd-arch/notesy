import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileText, Loader2, Menu, MoreHorizontal, RefreshCw, Trash2, X } from "lucide-react";
import { useNote, useSlides } from "../lib/hooks";
import { cancelProcessing, processNote, useLiveSession } from "../lib/session";
import { deleteNote, updateNote } from "../lib/db";
import { formatClock, formatDate, formatTime, download, safeFileName } from "../lib/util";
import { noteHtml, noteMarkdown } from "../lib/export";
import { toast, toastError } from "../lib/toast";
import { LiveBar } from "./LiveBar";
import { RecordButton } from "./RecordButton";
import { SummaryTab } from "./tabs/SummaryTab";
import { MemoTab } from "./tabs/MemoTab";
import { TranscriptTab } from "./tabs/TranscriptTab";
import { SlidesTab } from "./tabs/SlidesTab";
import { MomTab } from "./tabs/MomTab";
import { downloadMom } from "../lib/mom/export";
import { attendanceOpen, watchAttendance } from "../lib/attendance";
import { AskBar } from "./AskBar";
import type { Note } from "../lib/types";

type Tab = "summary" | "mom" | "memo" | "transcript" | "slides";

interface Props {
  noteId: string;
  onNavigate: (path: string) => void;
  onToggleSidebar: () => void;
}

function StatusBanner({ note }: { note: Note }) {
  const s = note.status;
  if (s.kind === "idle" || s.kind === "recording") return null;
  if (s.kind === "error")
    return (
      <div className="banner banner-error">
        <AlertTriangle size={16} />
        <span>{s.message}</span>
        <button className="btn btn-small" onClick={() => processNote(note.id, { transcribe: note.audio.length > 0, summarize: true })}>
          <RefreshCw size={14} /> Proses ulang
        </button>
        <button className="icon-btn" onClick={() => updateNote(note.id, (n) => void (n.status = { kind: "idle" }))} aria-label="Tutup">
          <X size={14} />
        </button>
      </div>
    );
  const progress = "progress" in s ? s.progress : undefined;
  return (
    <div className="banner">
      <Loader2 size={16} className="spin" />
      <span>{s.detail ?? "Memproses…"}</span>
      {progress !== undefined && (
        <span className="progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      <button className="btn btn-small btn-ghost" onClick={() => cancelProcessing(note.id)}>
        Batal
      </button>
    </div>
  );
}

export function NoteView({ noteId, onNavigate, onToggleSidebar }: Props) {
  const note = useNote(noteId);
  const slides = useSlides(noteId);
  const live = useLiveSession();
  const isLive = live?.noteId === noteId;
  const [tab, setTab] = useState<Tab | null>(null);
  const [menu, setMenu] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const activeTab: Tab = tab ?? (isLive ? "memo" : note?.summaries.length ? "summary" : note?.transcript.length ? "transcript" : "memo");

  const attendance = note?.mom?.attendance;
  const watching = attendance && attendanceOpen(attendance) ? attendance.key : null;
  useEffect(() => {
    if (!watching) return;
    return watchAttendance(noteId, (n) => toast(`${n} peserta mengisi absensi lewat QR.`, "success"));
  }, [noteId, watching]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    setTimeout(() => document.addEventListener("click", close, { once: true }));
    return () => document.removeEventListener("click", close);
  }, [menu]);

  if (note === undefined) return <div className="page" />;
  if (note === null)
    return (
      <div className="page center">
        <p>Catatan tidak ditemukan.</p>
        <button className="btn" onClick={() => onNavigate("")}>
          Kembali
        </button>
      </div>
    );

  const exportAs = async (kind: "md" | "html") => {
    try {
      const name = safeFileName(note.title);
      if (kind === "md") {
        download(`${name}.md`, await noteMarkdown(note, { inlineImages: true }), "text/markdown");
      } else {
        const summaryEl = document.querySelector(".summary-tab .prose");
        const memoEl = document.querySelector(".memo-tab .prose");
        const html = await noteHtml(note, summaryEl?.innerHTML ?? "", memoEl?.innerHTML ?? "");
        download(`${name}.html`, html, "text/html");
      }
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    if (isLive) return toast("Hentikan rekaman dulu.", "error");
    if (!confirm(`Hapus "${note.title}" beserta audio dan tangkapan layarnya?`)) return;
    await deleteNote(note.id);
    onNavigate("");
  };

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "summary", label: "Ringkasan" },
    { id: "mom", label: "MoM" },
    { id: "memo", label: "Memo" },
    { id: "transcript", label: "Transkrip" },
    { id: "slides", label: "Slide", badge: slides.length || undefined },
  ];

  return (
    <div className="page note-view">
      <header className="note-header">
        <button className="icon-btn only-mobile" onClick={onToggleSidebar} aria-label="Menu">
          <Menu size={20} />
        </button>
        <div className="note-title-wrap">
          <input
            ref={titleRef}
            className="note-title"
            defaultValue={note.title}
            key={note.title}
            placeholder="Tanpa judul"
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== note.title) void updateNote(note.id, (n) => void ((n.title = v), (n.titleIsAuto = false)));
            }}
            onKeyDown={(e) => e.key === "Enter" && titleRef.current?.blur()}
          />
          <div className="note-meta">
            <span>{formatDate(note.createdAt)}</span>
            <span>{formatTime(note.startedAt ?? note.createdAt)}</span>
            {note.durationMs > 0 && <span>{formatClock(note.durationMs)}</span>}
            {note.transcript.length > 0 && <span>{new Set(note.transcript.map((s) => s.speaker)).size} pembicara</span>}
          </div>
        </div>
        <div className="note-actions">
          {!isLive && !note.audio.length && !live && <RecordButton noteId={note.id} label="Rekam" />}
          <div className="menu-anchor">
            <button className="icon-btn" onClick={() => setMenu((v) => !v)} aria-label="Lainnya">
              <MoreHorizontal size={18} />
            </button>
            {menu && (
              <div className="menu right" role="menu">
                <button onClick={() => exportAs("md")}>
                  <FileText size={16} /> Ekspor Markdown
                </button>
                <button onClick={() => exportAs("html")}>
                  <Download size={16} /> Ekspor HTML (siap cetak PDF)
                </button>
                <button onClick={() => downloadMom(note, "docx").catch(toastError)}>
                  <FileText size={16} /> Unduh MoM (Word)
                </button>
                <button onClick={() => downloadMom(note, "pdf").catch(toastError)}>
                  <Download size={16} /> Unduh MoM (PDF)
                </button>
                {note.audio.length > 0 && (
                  <button onClick={() => processNote(note.id, { transcribe: true, summarize: true })}>
                    <RefreshCw size={16} /> Transkrip & ringkas ulang
                  </button>
                )}
                <button className="danger" onClick={remove}>
                  <Trash2 size={16} /> Hapus rapat
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {isLive && <LiveBar live={live!} />}
      <StatusBanner note={note} />

      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={activeTab === t.id} className={activeTab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {t.badge !== undefined && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </nav>

      <section className="tab-body">
        {activeTab === "summary" && <SummaryTab note={note} slides={slides} isLive={isLive} onNavigate={onNavigate} />}
        {activeTab === "mom" && <MomTab note={note} slides={slides} />}
        {activeTab === "memo" && <MemoTab note={note} isLive={isLive} />}
        {activeTab === "transcript" && <TranscriptTab note={note} isLive={isLive} />}
        {activeTab === "slides" && <SlidesTab note={note} slides={slides} isLive={isLive} />}
      </section>

      {!isLive && <AskBar note={note} onNavigate={onNavigate} />}
    </div>
  );
}
