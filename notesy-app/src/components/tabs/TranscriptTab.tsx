import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Download,
  FileAudio,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { usePlayableAudio } from "../../lib/hooks";
import { updateNote } from "../../lib/db";
import { isProcessing, processNote } from "../../lib/session";
import { speakerName } from "../../lib/ai/prompts";
import { aiConfigured, tidyTranscript } from "../../lib/ai";
import { errorMessage } from "../../lib/util";
import { transcriptMarkdown } from "../../lib/export";
import { download, formatClock, safeFileName } from "../../lib/util";
import { toast } from "../../lib/toast";
import { paragraphs } from "../../lib/paragraphs";
import { useSettings } from "../../lib/settings";
import type { Note } from "../../lib/types";

const COLORS = [
  "#2563eb",
  "#db2777",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
];

export function TranscriptTab({
  note,
  isLive,
}: {
  note: Note;
  isLive: boolean;
}) {
  const track = note.audio.find((a) => a.channel === "mix") ?? note.audio[0];
  const url = usePlayableAudio(track?.blobKey)?.url;
  const audio = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const [settings] = useSettings();
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"clean" | "raw">("clean");
  const [tidying, setTidying] = useState<string | null>(null);
  const clean = view === "clean" ? note.cleanTranscript : undefined;

  const cleanSections = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!clean) return [];
    if (!term) return clean.sections;
    return clean.sections
      .map((sec) => ({
        ...sec,
        paragraphs: sec.paragraphs.filter((p) =>
          p.text.toLowerCase().includes(term),
        ),
      }))
      .filter((sec) => sec.paragraphs.length);
  }, [clean, q]);

  const tidy = async () => {
    if (!aiConfigured(settings)) {
      toast("Atur Intelligence (API key Cursor) di Pengaturan dulu.", "error");
      return;
    }
    if (
      note.cleanTranscript &&
      !confirm("Rapikan ulang? Versi rapi saat ini akan diganti.")
    )
      return;
    setTidying("Menyiapkan…");
    setView("clean");
    try {
      await tidyTranscript(note.id, (done, total) =>
        setTidying(
          total > 1
            ? `Merapikan… ${done}/${total} bagian`
            : "Merapikan…",
        ),
      );
      toast("Transkrip dirapikan", "success", 1500);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setTidying(null);
    }
  };

  const speakers = useMemo(
    () => [...new Set(note.transcript.map((s) => s.speaker))],
    [note.transcript],
  );
  const color = (sp: string) =>
    COLORS[Math.max(0, speakers.indexOf(sp)) % COLORS.length];
  const cleanSpeakers = useMemo(
    () => [
      ...new Set(
        (note.cleanTranscript?.sections ?? []).flatMap((sec) =>
          sec.paragraphs.map((p) => p.speaker),
        ),
      ),
    ],
    [note.cleanTranscript],
  );

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const segs = term
      ? note.transcript.filter((s) => s.text.toLowerCase().includes(term))
      : note.transcript;
    if (term) return segs.map((s) => ({ speaker: s.speaker, items: [s] }));
    return paragraphs(segs, (s) => s.speaker);
  }, [note.transcript, q]);

  const activeId = useMemo(() => {
    const seg = note.transcript.find(
      (s) => time >= s.start && time < Math.max(s.end, s.start + 0.5),
    );
    return seg?.id;
  }, [time, note.transcript]);

  useEffect(() => {
    if (!follow || !activeId || audio.current?.paused) return;
    listRef.current
      ?.querySelector(`[data-seg="${activeId}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeId, follow]);

  const seek = (t: number) => {
    if (!audio.current) return;
    audio.current.currentTime = t;
    void audio.current.play();
  };

  const rename = (sp: string) => {
    const current = note.speakerNames[sp] || sp;
    const name = prompt(`Ganti nama "${current}" menjadi:`, current);
    if (!name?.trim()) return;
    void updateNote(note.id, (n) => {
      n.speakerNames = { ...n.speakerNames, [sp]: name.trim() };
    });
  };

  const editSegment = (id: string, text: string) =>
    updateNote(note.id, (n) => {
      n.transcript = n.transcript.map((s) =>
        s.id === id ? { ...s, text } : s,
      );
    });

  if (isLive && !note.transcript.length)
    return (
      <div className="empty-state">
        <FileAudio size={22} />
        <p>
          {settings.sttEngine === "browser" && settings.liveTranscribe
            ? "Transkrip muncul di sini selama rapat berlangsung, beberapa detik setelah orang berbicara."
            : "Transkrip dibuat setelah rekaman selesai."}
        </p>
      </div>
    );

  return (
    <div className="transcript-tab">
      {track && url && (
        <div className="player">
          <audio
            ref={audio}
            src={url}
            controls
            preload="metadata"
            onTimeUpdate={(e) =>
              setTime((e.target as HTMLAudioElement).currentTime)
            }
          />
          <button
            className="icon-btn"
            title="Unduh audio"
            onClick={async () => {
              const r = await fetch(url);
              download(
                `${safeFileName(note.title)}.${track.mime.includes("mp4") ? "m4a" : "webm"}`,
                await r.blob(),
              );
            }}
          >
            <Download size={16} />
          </button>
        </div>
      )}

      {note.transcript.length > 0 ? (
        <>
          <div className="transcript-toolbar">
            <label className="search small">
              <Search size={14} />
              <input
                placeholder="Cari di transkrip"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <div className="speaker-legend">
              {speakers.map((sp) => (
                <button
                  key={sp}
                  className="speaker-chip"
                  style={{ "--c": color(sp) } as React.CSSProperties}
                  onClick={() => rename(sp)}
                  title="Klik untuk ganti nama"
                >
                  {note.speakerNames[sp] || sp || "Pembicara"}
                </button>
              ))}
            </div>
            {note.cleanTranscript && (
              <div className="segmented small">
                <button
                  className={view === "clean" ? "active" : ""}
                  onClick={() => setView("clean")}
                >
                  Rapi
                </button>
                <button
                  className={view === "raw" ? "active" : ""}
                  onClick={() => setView("raw")}
                >
                  Asli
                </button>
              </div>
            )}
            <button
              className="btn btn-small"
              disabled={!!tidying || isLive}
              onClick={tidy}
              title="AI menambah judul topik, menebak pembicara, dan membetulkan kata salah dengar"
            >
              <Sparkles size={14} />{" "}
              {tidying ??
                (note.cleanTranscript ? "Rapikan ulang" : "Rapikan dengan AI")}
            </button>
            <label className="toggle small">
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />{" "}
              Ikuti audio
            </label>
            <button
              className="icon-btn"
              title="Salin transkrip"
              onClick={() =>
                navigator.clipboard
                  .writeText(transcriptMarkdown(note))
                  .then(() => toast("Disalin", "success", 1200))
              }
            >
              <Copy size={16} />
            </button>
            {note.audio.length > 0 && (
              <button
                className="icon-btn"
                title="Transkrip ulang"
                disabled={isProcessing(note.id)}
                onClick={() =>
                  confirm(
                    "Transkrip ulang akan mengganti transkrip saat ini. Lanjutkan?",
                  ) &&
                  processNote(note.id, {
                    transcribe: true,
                    fresh: true,
                    summarize: false,
                  })
                }
              >
                <RefreshCw size={16} />
              </button>
            )}
          </div>
          {clean ? (
            <div className="transcript" ref={listRef}>
              {cleanSections.map((sec, si) => (
                <section key={si}>
                  {sec.title && <h3 className="topic">{sec.title}</h3>}
                  {sec.paragraphs.map((p, pi) => (
                    <div className="turn" key={pi}>
                      <div className="turn-head">
                        <span
                          className="speaker"
                          style={{
                            color:
                              COLORS[
                                Math.max(0, cleanSpeakers.indexOf(p.speaker)) %
                                  COLORS.length
                              ],
                          }}
                        >
                          {p.speaker}
                        </span>
                        <button className="ts" onClick={() => seek(p.start)}>
                          {formatClock(p.start * 1000)}
                        </button>
                      </div>
                      <p>{p.text}</p>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <div className="transcript" ref={listRef}>
              {groups.map((g, i) => (
                <div className="turn" key={`${g.items[0].id}-${i}`}>
                  <div className="turn-head">
                    <button
                      className="speaker"
                      style={{ color: color(g.speaker) }}
                      onClick={() => rename(g.speaker)}
                    >
                      {speakerName(note, g.items[0])}
                    </button>
                    <button
                      className="ts"
                      onClick={() => seek(g.items[0].start)}
                    >
                      {formatClock(g.items[0].start * 1000)}
                    </button>
                  </div>
                  <p>
                    {g.items.map((s) => (
                      <span
                        key={s.id}
                        data-seg={s.id}
                        className={`seg${s.id === activeId ? " active" : ""}`}
                        onDoubleClick={() => seek(s.start)}
                        contentEditable
                        suppressContentEditableWarning
                        onBlur={(e) => {
                          const v = e.currentTarget.textContent?.trim() ?? "";
                          if (v !== s.text) void editSegment(s.id, v);
                        }}
                      >
                        {s.text}{" "}
                      </span>
                    ))}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="fineprint">
            {clean
              ? `Versi rapi oleh AI${clean.model ? ` (${clean.model})` : ""}. Klik waktu untuk memutar · pilih "Asli" untuk melihat dan mengedit transkrip mentah.`
              : "Klik waktu untuk memutar · klik dua kali kalimat untuk lompat · klik teks untuk mengedit · klik nama untuk mengganti."}
          </p>
          {!!note.events?.length && (
            <details className="fineprint">
              <summary>Catatan rekaman ({note.events.length})</summary>
              <ul>
                {note.events.map((ev, i) => (
                  <li key={i}>
                    {formatClock(ev.atMs)} · {ev.text}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <div className="empty-state">
          <FileAudio size={22} />
          {note.audio.length ? (
            <>
              <p>
                {["transcribing"].includes(note.status.kind)
                  ? "Sedang mentranskrip…"
                  : "Audio tersedia tetapi belum ditranskrip."}
              </p>
              {note.status.kind !== "transcribing" && (
                <button
                  className="btn btn-primary"
                  onClick={() => processNote(note.id, { transcribe: true })}
                >
                  Transkrip sekarang
                </button>
              )}
            </>
          ) : (
            <p>Belum ada rekaman untuk catatan ini.</p>
          )}
        </div>
      )}
    </div>
  );
}
