import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Loader2, MessageSquare, Trash2 } from "lucide-react";
import { chat, aiConfigured } from "../lib/ai";
import { updateNote } from "../lib/db";
import { useSettings } from "../lib/settings";
import { MarkdownEditor } from "./Editor";
import type { Note } from "../lib/types";

const SUGGESTIONS = ["Apa saja keputusan rapat ini?", "Daftar tugas saya", "Apa yang belum disepakati?", "Buat draf email tindak lanjut"];

export function AskBar({ note, onNavigate }: { note: Note; onNavigate: (p: string) => void }) {
  const [settings] = useSettings();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [note.chat.length, pending, open]);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || pending !== null) return;
    if (!aiConfigured(settings)) return onNavigate("settings/intelligence");
    setQ("");
    setOpen(true);
    setPending("");
    ctrl.current = new AbortController();
    try {
      await chat(note.id, question, (t) => setPending(t), ctrl.current.signal);
    } catch {
      /* error is stored in the chat thread */
    } finally {
      setPending(null);
    }
  };

  const disabled = !note.transcript.length && !note.memo.trim() && !note.summaries.length;

  return (
    <div className={`ask${open ? " open" : ""}`}>
      {open && (
        <div className="ask-panel">
          <div className="ask-head">
            <MessageSquare size={14} /> Tanya tentang rapat ini
            <div className="spacer" />
            {note.chat.length > 0 && (
              <button className="icon-btn" title="Hapus percakapan" onClick={() => updateNote(note.id, (n) => void (n.chat = []))}>
                <Trash2 size={14} />
              </button>
            )}
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Tutup">
              <ChevronDown size={16} />
            </button>
          </div>
          <div className="ask-list" ref={listRef}>
            {note.chat.length === 0 && pending === null && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            {note.chat.map((m, i) => {
              const isLastAssistant = m.role === "assistant" && i === note.chat.length - 1 && pending !== null;
              const text = isLastAssistant ? pending || m.text : m.text;
              return (
                <div key={m.id} className={`msg msg-${m.role}${m.error ? " msg-error" : ""}`}>
                  {m.role === "assistant" ? (
                    text ? (
                      <MarkdownEditor markdown={text} editable={false} />
                    ) : (
                      <span className="muted">
                        <Loader2 size={14} className="spin" /> Berpikir…
                      </span>
                    )
                  ) : (
                    text
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(q);
        }}
      >
        <input
          value={q}
          disabled={disabled}
          onFocus={() => note.chat.length && setOpen(true)}
          onChange={(e) => setQ(e.target.value)}
          placeholder={disabled ? "Rekam atau tulis memo dulu untuk bertanya" : "Tanya apa saja tentang rapat ini…"}
        />
        {pending !== null ? (
          <button type="button" className="icon-btn" onClick={() => ctrl.current?.abort()} title="Hentikan">
            <Loader2 size={16} className="spin" />
          </button>
        ) : (
          <button type="submit" className="send" disabled={!q.trim()} aria-label="Kirim">
            <ArrowUp size={16} />
          </button>
        )}
      </form>
    </div>
  );
}
