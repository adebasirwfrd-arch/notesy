import { getBlob, getNote, listSlides, putSlide, updateNote } from "../db";
import { allTemplates, dictionaryStore, getSettings } from "../settings";
import type { ChatMessage, Note, Settings, Slide, SummaryDoc } from "../types";
import { blobToBase64, uid } from "../util";
import { CursorApiError, CursorClient, type PromptImage } from "./cursor";
import { openaiChat, type ChatTurn } from "./openai";
import {
  AGENT_PREAMBLE,
  CHAT_RULES,
  chatContext,
  describePrompt,
  parseSlideJson,
  parseSummary,
  summaryPrompt,
} from "./prompts";

export function aiConfigured(s: Settings = getSettings()) {
  return s.aiProvider === "cursor" ? !!s.cursorApiKey.trim() : !!s.openaiBase.trim() && !!s.openaiModel.trim();
}

export function aiLabel(s: Settings = getSettings()) {
  return s.aiProvider === "cursor" ? `Cursor${s.cursorModel ? ` · ${s.cursorModel}` : ""}` : `${s.openaiModel}`;
}

interface AskOptions {
  images?: PromptImage[];
  onDelta?: (full: string) => void;
  signal?: AbortSignal;
  /** Prepended only when a fresh conversation has to be started. */
  primer?: string;
  history?: ChatTurn[];
  fresh?: boolean;
}

/** One conversation per note: a Cursor cloud agent that is reused for slides, summary and chat. */
async function ask(noteId: string, text: string, opts: AskOptions = {}): Promise<string> {
  const s = getSettings();
  if (!aiConfigured(s)) throw new Error("Intelligence belum diatur. Buka Pengaturan → Intelligence dan masukkan API key Cursor.");

  if (s.aiProvider === "openai") {
    const turns: ChatTurn[] = [{ role: "system", text: AGENT_PREAMBLE }];
    if (opts.primer) turns.push({ role: "user", text: opts.primer }, { role: "assistant", text: "Siap." });
    turns.push(...(opts.history ?? []), { role: "user", text, images: opts.images });
    return openaiChat(s.openaiBase, s.openaiKey, s.openaiModel, turns, opts.onDelta, opts.signal);
  }

  const client = new CursorClient(s.cursorApiKey.trim());
  const note = await getNote(noteId);
  if (note?.agentId && !opts.fresh) {
    try {
      const { runId } = await client.followUp(note.agentId, text, { images: opts.images, signal: opts.signal });
      return (await client.wait(note.agentId, runId, opts.onDelta, opts.signal)).text;
    } catch (e) {
      const stale = e instanceof CursorApiError && [400, 404, 410].includes(e.status);
      if (!stale) throw e;
    }
  }
  const first = [AGENT_PREAMBLE, opts.primer, text].filter(Boolean).join("\n\n");
  const { agentId, runId } = await client.createAgent(first, {
    images: opts.images,
    model: s.cursorModel || undefined,
    name: `Notesy · ${note?.title ?? "Rapat"}`,
    signal: opts.signal,
  });
  await updateNote(noteId, (n) => {
    n.agentId = agentId;
  });
  return (await client.wait(agentId, runId, opts.onDelta, opts.signal)).text;
}

async function slideImage(slide: Slide): Promise<PromptImage | null> {
  const blob = await getBlob(slide.blobKey);
  if (!blob) return null;
  return { data: await blobToBase64(blob), mimeType: blob.type || "image/jpeg" };
}

/** Thins out near-duplicate captures so we never send more than `limit` images. */
export function pickSlides(slides: Slide[], limit: number) {
  const usable = slides.filter((s) => !s.excluded);
  if (usable.length <= limit) return usable;
  const manual = usable.filter((s) => !s.auto);
  const auto = usable.filter((s) => s.auto);
  const room = Math.max(0, limit - manual.length);
  const step = auto.length / Math.max(1, room);
  const picked = Array.from({ length: room }, (_, i) => auto[Math.floor(i * step)]);
  return [...manual, ...picked].sort((a, b) => a.t - b.t).slice(0, limit);
}

export async function describeSlides(noteId: string, onProgress?: (f: number) => void, signal?: AbortSignal) {
  const s = getSettings();
  const note = await getNote(noteId);
  if (!note) return;
  const all = await listSlides(noteId);
  const todo = pickSlides(all.filter((x) => !x.description), Math.max(s.maxSlidesInSummary * 2, 10));
  for (let i = 0; i < todo.length; i += 5) {
    const batch = todo.slice(i, i + 5);
    const images = (await Promise.all(batch.map(slideImage))).filter(Boolean) as PromptImage[];
    if (!images.length) continue;
    const raw = await ask(noteId, describePrompt(note, batch), { images, signal });
    const parsed = parseSlideJson(raw);
    for (const slide of batch) {
      const p = parsed.find((x) => x.id === slide.id) ?? parsed[batch.indexOf(slide)];
      if (!p) continue;
      await putSlide({
        ...slide,
        caption: p.caption?.trim() || slide.caption,
        description: p.description?.trim() || slide.description,
        excluded: slide.auto && p.keep === false ? true : slide.excluded,
      });
    }
    onProgress?.(Math.min(1, (i + batch.length) / todo.length));
  }
}

export async function generateSummary(
  noteId: string,
  templateId: string,
  onDelta?: (markdown: string) => void,
  signal?: AbortSignal,
): Promise<SummaryDoc> {
  const s = getSettings();
  const note = await getNote(noteId);
  if (!note) throw new Error("Catatan tidak ditemukan");
  if (!note.transcript.length && !note.memo.trim()) throw new Error("Belum ada transkrip atau memo untuk diringkas.");
  const template = allTemplates().find((t) => t.id === templateId);
  const slides = pickSlides(await listSlides(noteId), s.maxSlidesInSummary);
  const prompt = summaryPrompt({
    note,
    slides,
    template,
    language: s.summaryLanguage,
    maxImages: s.maxSlidesInSummary,
    extraInstructions: s.extraInstructions,
    userName: s.displayName,
    meLabel: note.transcript.some((x) => x.channel === "mic" && x.speaker) ? s.meLabel : undefined,
  });
  const dict = dictionaryStore.get();
  const glossary = dict.length ? `\n\nKamus istilah (ejaan yang benar): ${dict.map((d) => d.term).join(", ")}` : "";
  const valid = new Set(slides.map((x) => x.id));
  const sanitize = (md: string) => md.replace(/!\[([^\]]*)\]\(slide:([\w-]+)\)/g, (m, _c, id) => (valid.has(id) ? m : ""));
  const raw = await ask(noteId, prompt + glossary, {
    signal,
    onDelta: (full) => onDelta?.(sanitize(parseSummary(full).markdown)),
  });
  const { title, markdown } = parseSummary(raw);
  const doc: SummaryDoc = {
    id: uid("m_"),
    templateId,
    title: template?.name ?? "Ringkasan",
    markdown: sanitize(markdown),
    createdAt: Date.now(),
    model: aiLabel(s),
  };
  await updateNote(noteId, (n) => {
    n.summaries = [...n.summaries.filter((x) => x.templateId !== templateId), doc];
    n.activeSummaryId = doc.id;
    if (title && (n.titleIsAuto || !n.title.trim()) && s.autoTitle) {
      n.title = title;
      n.titleIsAuto = true;
    }
  });
  return doc;
}

export async function chat(noteId: string, question: string, onDelta: (t: string) => void, signal?: AbortSignal) {
  const note = (await getNote(noteId)) as Note;
  const summary = note.summaries.find((x) => x.id === note.activeSummaryId)?.markdown;
  const userMsg: ChatMessage = { id: uid("c_"), role: "user", text: question, createdAt: Date.now() };
  const reply: ChatMessage = { id: uid("c_"), role: "assistant", text: "", createdAt: Date.now() };
  await updateNote(noteId, (n) => {
    n.chat = [...n.chat, userMsg, reply];
  });
  const history: ChatTurn[] = note.chat.slice(-12).map((m) => ({ role: m.role, text: m.text }));
  let last = 0;
  try {
    const text = await ask(noteId, `${CHAT_RULES}\n\nPertanyaan: ${question}`, {
      primer: chatContext(note, summary),
      history,
      signal,
      onDelta: (full) => {
        onDelta(full);
        if (Date.now() - last > 800) {
          last = Date.now();
          void updateNote(noteId, (n) => {
            n.chat = n.chat.map((m) => (m.id === reply.id ? { ...m, text: full } : m));
          });
        }
      },
    });
    await updateNote(noteId, (n) => {
      n.chat = n.chat.map((m) => (m.id === reply.id ? { ...m, text } : m));
    });
    return text;
  } catch (e) {
    await updateNote(noteId, (n) => {
      n.chat = n.chat.map((m) => (m.id === reply.id ? { ...m, text: e instanceof Error ? e.message : String(e), error: true } : m));
    });
    throw e;
  }
}

export async function testConnection(s: Settings) {
  if (s.aiProvider === "cursor") {
    const client = new CursorClient(s.cursorApiKey.trim());
    const me = await client.me();
    const models = await client.models().catch(() => []);
    return { who: me.userEmail ?? me.apiKeyName, models };
  }
  const text = await openaiChat(s.openaiBase, s.openaiKey, s.openaiModel, [{ role: "user", text: "Balas dengan satu kata: OK" }]);
  return { who: text.trim().slice(0, 40), models: [] };
}
