import { useMemo, useState } from "react";
import { FilePlus2, Loader2, Search, Settings, Sparkles, X, AlertTriangle } from "lucide-react";
import { useNotes } from "../lib/hooks";
import { createEmptyNote, useLiveSession } from "../lib/session";
import { useSettings } from "../lib/settings";
import { aiConfigured } from "../lib/ai";
import { dayBucket, formatTime } from "../lib/util";
import { RecordButton } from "./RecordButton";
import type { Note } from "../lib/types";

interface Props {
  activeId?: string;
  onNavigate: (path: string) => void;
  onClose: () => void;
}

function statusIcon(n: Note, liveId?: string) {
  if (n.id === liveId) return <span className="rec-dot small pulse" title="Merekam" />;
  if (["transcribing", "describing", "summarizing"].includes(n.status.kind)) return <Loader2 size={13} className="spin muted" />;
  if (n.status.kind === "error") return <AlertTriangle size={13} className="warn" />;
  return null;
}

export function Sidebar({ activeId, onNavigate, onClose }: Props) {
  const notes = useNotes();
  const live = useLiveSession();
  const [settings] = useSettings();
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = (notes ?? []).filter(
      (n) =>
        !term ||
        n.title.toLowerCase().includes(term) ||
        n.memo.toLowerCase().includes(term) ||
        n.summaries.some((s) => s.markdown.toLowerCase().includes(term)) ||
        n.transcript.some((s) => s.text.toLowerCase().includes(term)),
    );
    const map = new Map<string, Note[]>();
    for (const n of filtered) {
      const k = dayBucket(n.createdAt);
      map.set(k, [...(map.get(k) ?? []), n]);
    }
    return [...map.entries()];
  }, [notes, q]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <button className="brand" onClick={() => onNavigate("")}>
          <img src="./icons/icon-32.png" alt="" width={22} height={22} />
          <span>Notesy</span>
        </button>
        <button className="icon-btn only-mobile" onClick={onClose} aria-label="Tutup menu">
          <X size={18} />
        </button>
      </div>

      <div className="sidebar-actions">
        <RecordButton onStarted={(id) => onNavigate(`note/${id}`)} />
        <button
          className="btn btn-ghost"
          title="Catatan baru tanpa rekaman"
          onClick={async () => onNavigate(`note/${(await createEmptyNote()).id}`)}
        >
          <FilePlus2 size={16} />
        </button>
      </div>

      <label className="search">
        <Search size={14} />
        <input placeholder="Cari rapat, ringkasan, transkrip…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>

      <nav className="timeline">
        {notes && !notes.length && <p className="empty-hint">Belum ada rapat. Klik “Rekam rapat” saat meeting dimulai.</p>}
        {groups.map(([label, items]) => (
          <section key={label}>
            <h4>{label}</h4>
            {items.map((n) => (
              <button key={n.id} className={`timeline-item${n.id === activeId ? " active" : ""}`} onClick={() => onNavigate(`note/${n.id}`)}>
                <span className="ti-title">{n.title || "Tanpa judul"}</span>
                <span className="ti-meta">
                  {statusIcon(n, live?.noteId)}
                  {formatTime(n.startedAt ?? n.createdAt)}
                </span>
              </button>
            ))}
          </section>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <button className={`ai-badge${aiConfigured(settings) ? " ok" : ""}`} onClick={() => onNavigate("settings/intelligence")}>
          <Sparkles size={14} />
          {aiConfigured(settings) ? (settings.aiProvider === "cursor" ? "AI: Cursor" : `AI: ${settings.openaiModel}`) : "Hubungkan AI"}
        </button>
        <button className="icon-btn" onClick={() => onNavigate("settings")} aria-label="Pengaturan" title="Pengaturan">
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}
