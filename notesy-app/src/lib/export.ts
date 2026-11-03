import { paragraphs } from "./paragraphs";
import { db, getBlob, listSlides, putBlob, putNote, putSlide, emit } from "./db";
import { speakerName } from "./ai/prompts";
import type { Note, Slide } from "./types";
import { blobToBase64, formatClock, formatDate, formatTime } from "./util";

async function slideDataUrls(noteId: string) {
  const map = new Map<string, string>();
  for (const s of await listSlides(noteId)) {
    const b = await getBlob(s.blobKey);
    if (b) map.set(s.id, `data:${b.type || "image/jpeg"};base64,${await blobToBase64(b)}`);
  }
  return map;
}

export function transcriptMarkdown(note: Note) {
  return paragraphs(note.transcript, (s) => speakerName(note, s))
    .map((p) => `**${p.speaker}** [${formatClock(p.items[0].start * 1000)}]\n${p.items.map((s) => s.text).join(" ")}`)
    .join("\n\n");
}

export async function noteMarkdown(note: Note, opts: { inlineImages: boolean }) {
  const summary = note.summaries.find((s) => s.id === note.activeSummaryId) ?? note.summaries.at(-1);
  const images = opts.inlineImages ? await slideDataUrls(note.id) : new Map<string, string>();
  const fix = (md: string) => md.replace(/\]\(slide:([\w-]+)\)/g, (m, id) => (images.has(id) ? `](${images.get(id)})` : m));
  const parts = [
    `# ${note.title}`,
    `${formatDate(note.createdAt)} · ${formatTime(note.startedAt ?? note.createdAt)} · ${formatClock(note.durationMs)}`,
  ];
  if (summary) parts.push("## Ringkasan", fix(summary.markdown));
  if (note.memo.trim()) parts.push("## Memo", fix(note.memo));
  if (note.transcript.length) parts.push("## Transkrip", transcriptMarkdown(note));
  return parts.join("\n\n");
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Self-contained HTML (images embedded) that prints cleanly to PDF. */
export async function noteHtml(note: Note, renderedSummary: string, renderedMemo: string) {
  const images = await slideDataUrls(note.id);
  const fix = (html: string) => html.replace(/src="slide:([\w-]+)"/g, (m, id) => (images.has(id) ? `src="${images.get(id)}"` : m));
  const transcript = note.transcript
    .map((s) => `<p><b>${escapeHtml(speakerName(note, s))}</b> <span class="t">${formatClock(s.start * 1000)}</span> ${escapeHtml(s.text)}</p>`)
    .join("");
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title>
<style>body{font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;max-width:820px;margin:40px auto;padding:0 24px;color:#1c1917}
h1{font-size:28px;margin:0 0 4px}h2{margin-top:32px;border-bottom:1px solid #e7e5e4;padding-bottom:4px}img{max-width:100%;border:1px solid #e7e5e4;border-radius:8px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e7e5e4;padding:6px 8px;text-align:left}.meta,.t{color:#78716c;font-size:13px}
figure{margin:16px 0}figcaption{color:#78716c;font-size:13px}@media print{body{margin:0}}</style></head><body>
<h1>${escapeHtml(note.title)}</h1><div class="meta">${formatDate(note.createdAt)} · ${formatTime(note.startedAt ?? note.createdAt)} · ${formatClock(note.durationMs)}</div>
${renderedSummary ? `<h2>Ringkasan</h2>${fix(renderedSummary)}` : ""}
${renderedMemo ? `<h2>Memo</h2>${fix(renderedMemo)}` : ""}
${transcript ? `<h2>Transkrip</h2>${transcript}` : ""}
</body></html>`;
}

interface Backup {
  app: "notesy";
  version: 1;
  exportedAt: number;
  notes: Note[];
  slides: (Slide & { data: string; mime: string })[];
  audio?: { key: string; data: string; mime: string }[];
}

export async function exportBackup(includeAudio: boolean) {
  const d = await db();
  const notes = await d.getAll("notes");
  const slides: Backup["slides"] = [];
  for (const s of await d.getAll("slides")) {
    const b = await getBlob(s.blobKey);
    if (b) slides.push({ ...s, data: await blobToBase64(b), mime: b.type });
  }
  const backup: Backup = { app: "notesy", version: 1, exportedAt: Date.now(), notes, slides };
  if (includeAudio) {
    backup.audio = [];
    for (const n of notes)
      for (const a of n.audio) {
        const b = await getBlob(a.blobKey);
        if (b) backup.audio.push({ key: a.blobKey, data: await blobToBase64(b), mime: b.type });
      }
  }
  return new Blob([JSON.stringify(backup)], { type: "application/json" });
}

const b64ToBlob = (data: string, mime: string) => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: mime });

export async function importBackup(file: File) {
  const backup = JSON.parse(await file.text()) as Backup;
  if (backup.app !== "notesy") throw new Error("Bukan file cadangan Notesy.");
  for (const a of backup.audio ?? []) await putBlob(a.key, b64ToBlob(a.data, a.mime));
  for (const s of backup.slides) {
    const { data, mime, ...slide } = s;
    await putSlide(slide, b64ToBlob(data, mime));
  }
  for (const n of backup.notes) {
    const hasAudio = n.audio.every((a) => backup.audio?.some((x) => x.key === a.blobKey));
    await putNote({ ...n, audio: hasAudio ? n.audio : [], status: { kind: "idle" } });
  }
  emit("notes");
  return backup.notes.length;
}
