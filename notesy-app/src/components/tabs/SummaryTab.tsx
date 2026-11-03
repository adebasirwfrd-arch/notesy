import { useRef, useState } from "react";
import { Copy, Loader2, Sparkles, Square } from "lucide-react";
import { MarkdownEditor } from "../Editor";
import { aiConfigured, aiLabel, describeSlides, generateSummary } from "../../lib/ai";
import { useSettings, useTemplates } from "../../lib/settings";
import { updateNote } from "../../lib/db";
import { isProcessing } from "../../lib/session";
import { toast, toastError } from "../../lib/toast";
import type { Note, Slide } from "../../lib/types";

interface Props {
  note: Note;
  slides: Slide[];
  isLive: boolean;
  onNavigate: (path: string) => void;
}

export function SummaryTab({ note, slides, isLive, onNavigate }: Props) {
  const [settings] = useSettings();
  const { all: templates } = useTemplates();
  const [streaming, setStreaming] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("");
  const ctrl = useRef<AbortController | null>(null);

  const active = note.summaries.find((s) => s.id === note.activeSummaryId) ?? note.summaries.at(-1);
  const busy = streaming !== null || isProcessing(note.id) || ["describing", "summarizing"].includes(note.status.kind);
  const hasInput = note.transcript.length > 0 || note.memo.trim().length > 0;

  const run = async (templateId: string) => {
    if (!aiConfigured(settings)) return onNavigate("settings/intelligence");
    ctrl.current = new AbortController();
    setStreaming("");
    try {
      if (settings.describeSlides && slides.some((s) => !s.description && !s.excluded)) {
        setPhase("AI membaca tangkapan layar…");
        await describeSlides(note.id, undefined, ctrl.current.signal);
      }
      setPhase("AI menyusun ringkasan…");
      await generateSummary(note.id, templateId, (md) => setStreaming(md), ctrl.current.signal);
    } catch (e) {
      if (!ctrl.current?.signal.aborted) toastError(e);
    } finally {
      setStreaming(null);
      setPhase("");
      ctrl.current = null;
    }
  };

  if (isLive && !active)
    return (
      <div className="empty-state">
        <Sparkles size={22} />
        <p>Ringkasan dibuat otomatis setelah rekaman selesai. Sementara itu, tulis poin penting di tab Memo — AI akan memprioritaskannya.</p>
      </div>
    );

  return (
    <div className="summary-tab">
      <div className="summary-toolbar">
        <div className="template-chips">
          {templates.map((t) => {
            const exists = note.summaries.some((s) => s.templateId === t.id);
            const selected = active?.templateId === t.id;
            return (
              <button
                key={t.id}
                className={`chip${selected ? " selected" : ""}${exists ? " has" : ""}`}
                title={t.description}
                disabled={busy}
                onClick={() => {
                  const doc = note.summaries.find((s) => s.templateId === t.id);
                  if (doc) void updateNote(note.id, (n) => void (n.activeSummaryId = doc.id));
                  else void run(t.id);
                }}
              >
                {t.name}
              </button>
            );
          })}
        </div>
        <div className="toolbar-actions">
          {active && (
            <button
              className="icon-btn"
              title="Salin Markdown"
              onClick={() => navigator.clipboard.writeText(active.markdown).then(() => toast("Disalin", "success", 1200))}
            >
              <Copy size={16} />
            </button>
          )}
          {streaming !== null ? (
            <button className="btn btn-small" onClick={() => ctrl.current?.abort()}>
              <Square size={12} /> Hentikan
            </button>
          ) : (
            <button className="btn btn-small btn-primary" disabled={busy || !hasInput} onClick={() => run(active?.templateId ?? settings.defaultTemplateId)}>
              <Sparkles size={14} /> {active ? "Buat ulang" : "Buat ringkasan"}
            </button>
          )}
        </div>
      </div>

      {streaming !== null ? (
        <>
          <div className="streaming-note">
            <Loader2 size={14} className="spin" /> {phase} <span className="muted">· {aiLabel(settings)}</span>
          </div>
          {streaming ? <MarkdownEditor markdown={streaming} editable={false} /> : <div className="skeleton" />}
        </>
      ) : active ? (
        <>
          <MarkdownEditor
            markdown={active.markdown}
            onChange={(md) =>
              updateNote(note.id, (n) => {
                n.summaries = n.summaries.map((s) => (s.id === active.id ? { ...s, markdown: md } : s));
              })
            }
          />
          <p className="fineprint">
            Dibuat oleh {active.model ?? "AI"} · {new Date(active.createdAt).toLocaleString("id-ID")} · bisa diedit langsung
          </p>
        </>
      ) : (
        <div className="empty-state">
          <Sparkles size={22} />
          {!hasInput ? (
            <p>Belum ada transkrip atau memo. Rekam rapat atau tulis memo terlebih dulu.</p>
          ) : !aiConfigured(settings) ? (
            <>
              <p>Hubungkan Cursor sekali untuk membuat ringkasan otomatis.</p>
              <button className="btn btn-primary" onClick={() => onNavigate("settings/intelligence")}>
                Atur Intelligence
              </button>
            </>
          ) : busy ? (
            <p>Sedang diproses…</p>
          ) : (
            <>
              <p>Pilih template di atas atau klik Buat ringkasan.</p>
              <button className="btn btn-primary" onClick={() => run(settings.defaultTemplateId)}>
                <Sparkles size={14} /> Buat ringkasan
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
