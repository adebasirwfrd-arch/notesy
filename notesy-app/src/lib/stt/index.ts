import { getBlob } from "../db";
import { ensureHostPermission, assetUrl, hasWebGPU } from "../platform";
import type { AudioTrack, Channel, DictionaryEntry, Segment, Settings } from "../types";
import { uid } from "../util";
import { decodeToMono16k, SAMPLE_RATE, speechWindows } from "./audio";
import { repairHeaderlessWebm } from "./webm";

export const WHISPER_MODELS = [
  { id: "onnx-community/whisper-base", name: "Whisper Base", size: "~80 MB", note: "Cepat, akurasi cukup" },
  { id: "onnx-community/whisper-small", name: "Whisper Small", size: "~250 MB", note: "Seimbang (disarankan)" },
  { id: "onnx-community/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", size: "~800 MB", note: "Paling akurat, butuh WebGPU" },
];

export const STT_LANGUAGES = [
  { id: "auto", name: "Deteksi otomatis (campur ID/EN)" },
  { id: "id", name: "Bahasa Indonesia" },
  { id: "en", name: "English" },
  { id: "ms", name: "Bahasa Melayu" },
  { id: "jv", name: "Basa Jawa" },
];

export type Progress = (fraction: number, detail: string) => void;

interface Chunk {
  start: number;
  end: number;
  text: string;
}

class WhisperClient {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private loading: Promise<string> | null = null;
  private loadedKey = "";
  private onDownload: ((loaded: number, total: number) => void) | null = null;

  private ensureWorker() {
    if (this.worker) return this.worker;
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === "download") this.onDownload?.(m.loaded, m.total);
      else if (m.type === "result" || m.type === "detected") {
        this.waiting.get(m.id)?.resolve((m.type === "result" ? m.chunks : m.scores) as never);
        this.waiting.delete(m.id);
      } else if (m.type === "error" && m.id !== undefined) {
        this.waiting.get(m.id)?.reject(new Error(m.message));
        this.waiting.delete(m.id);
      }
    };
    this.worker = w;
    return w;
  }

  async resolveDevice(pref: Settings["whisperDevice"]): Promise<"webgpu" | "wasm"> {
    if (pref === "wasm") return "wasm";
    if (!hasWebGPU) return "wasm";
    try {
      const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
      return adapter ? "webgpu" : "wasm";
    } catch {
      return "wasm";
    }
  }

  load(model: string, device: "webgpu" | "wasm", onDownload?: (loaded: number, total: number) => void): Promise<string> {
    const key = `${model}|${device}`;
    if (this.loadedKey === key) return Promise.resolve(device);
    if (this.loading) return this.loading;
    const w = this.ensureWorker();
    this.onDownload = onDownload ?? null;
    this.loading = new Promise<string>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data.type === "ready") {
          w.removeEventListener("message", handler);
          this.loadedKey = key;
          resolve(e.data.device);
        } else if (e.data.type === "error" && e.data.id === undefined) {
          w.removeEventListener("message", handler);
          reject(new Error(e.data.message));
        }
      };
      w.addEventListener("message", handler);
      w.postMessage({ type: "load", model, device, ortBase: assetUrl("ort/") });
    }).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private call<T>(msg: Record<string, unknown>, audio: Float32Array): Promise<T> {
    const id = ++this.seq;
    const w = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      w.postMessage({ ...msg, id, audio }, [audio.buffer]);
    });
  }

  run(audio: Float32Array, language: string): Promise<Chunk[]> {
    return this.call({ type: "run", language }, audio);
  }

  detect(audio: Float32Array, candidates: string[]): Promise<Record<string, number>> {
    return this.call({ type: "detect", candidates }, audio);
  }

  reset() {
    this.worker?.terminate();
    this.worker = null;
    this.loadedKey = "";
    this.waiting.forEach((p) => p.reject(new Error("dibatalkan")));
    this.waiting.clear();
  }
}

export const whisper = new WhisperClient();

const HALLUCINATIONS = [
  /terima kasih (telah|sudah) menonton/i,
  /jangan lupa (like|subscribe)/i,
  /sampai jumpa (di|pada) video/i,
  /thanks? (you )?for watching/i,
  /please subscribe/i,
  /subtitles? (by|oleh)/i,
  /amara\.org/i,
  /^\W*(music|musik|applause|tepuk tangan)\W*$/i,
  /^[\s♪.…-]*$/,
];

export function cleanText(text: string) {
  let t = text.replace(/\s+/g, " ").trim();
  t = t.replace(/\b(\w+(?:\s+\w+){0,3}?)(?:[\s,.]+\1\b){3,}/giu, "$1");
  if (HALLUCINATIONS.some((r) => r.test(t))) return "";
  return t;
}

export function applyDictionary(text: string, dict: DictionaryEntry[]) {
  let out = text;
  for (const e of dict) {
    for (const alias of e.aliases) {
      if (!alias.trim()) continue;
      const esc = alias.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu"), e.term);
    }
  }
  return out;
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter((w) => w.length > 2));

/** Mic picks up the speakers when no headset is used; drop mic lines that repeat what the system channel heard. */
export function dropEcho(segments: Segment[]) {
  const sys = segments.filter((s) => s.channel === "system");
  if (!sys.length) return segments;
  return segments.filter((m) => {
    if (m.channel !== "mic") return true;
    const near = sys.filter((s) => s.end >= m.start - 2 && s.start <= m.end + 2);
    if (!near.length) return true;
    const a = tokens(m.text);
    if (a.size < 2) return true;
    const b = tokens(near.map((s) => s.text).join(" "));
    let hit = 0;
    a.forEach((w) => b.has(w) && hit++);
    return hit / a.size < 0.6;
  });
}

const DETECT_CANDIDATES = ["id", "en", "ms", "jv"];

/** Logit margin a window needs over the recording's main language before it is transcribed in another language. */
const SWITCH_MARGIN = 1;

function pickLanguage(scores: Record<string, number>, fallback?: string) {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let best = ranked[0]?.[0] ?? fallback ?? "id";
  if (best === "ms" && (scores.id ?? -Infinity) > scores.ms - SWITCH_MARGIN) best = "id";
  if (fallback && best !== fallback && scores[best] - (scores[fallback] ?? -Infinity) < SWITCH_MARGIN) best = fallback;
  return best;
}

/**
 * Whisper translates whatever it hears into the language it is told, so mixed ID/EN meetings are
 * transcribed window by window in the language actually spoken, biased towards the main language.
 */
async function transcribeBrowser(audio: Float32Array, settings: Settings, onProgress: (f: number) => void, onLanguage: (l: string) => void): Promise<Chunk[]> {
  const auto = settings.sttLanguage === "auto";
  // Shorter windows cut at pauses usually hold a single speaker turn, so each gets its own language.
  const windows = speechWindows(audio, auto ? 12 : 28);
  const perWindow: Record<string, number>[] = [];
  let main = settings.sttLanguage;
  if (auto) {
    const total: Record<string, number> = {};
    for (const w of windows) {
      const scores = await whisper.detect(audio.slice(w.start, w.end), DETECT_CANDIDATES);
      perWindow.push(scores);
      const weight = (w.end - w.start) / SAMPLE_RATE;
      for (const [code, s] of Object.entries(scores)) total[code] = (total[code] ?? 0) + s * weight;
    }
    main = windows.length ? pickLanguage(total) : "id";
  }
  onLanguage(main);
  const out: Chunk[] = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const slice = audio.slice(w.start, w.end);
    const chunks = await whisper.run(slice, auto ? pickLanguage(perWindow[i], main) : main);
    const offset = w.start / SAMPLE_RATE;
    for (const c of chunks) out.push({ start: c.start + offset, end: c.end + offset, text: c.text });
    onProgress((i + 1) / windows.length);
  }
  return out;
}

async function transcribeApi(blob: Blob, settings: Settings, dict: DictionaryEntry[]): Promise<Chunk[]> {
  const base = settings.sttApiBase.replace(/\/+$/, "");
  await ensureHostPermission(base);
  const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", settings.sttApiModel);
  form.append("response_format", "verbose_json");
  if (settings.sttLanguage !== "auto") form.append("language", settings.sttLanguage);
  const terms = dict.map((d) => d.term).slice(0, 60);
  if (terms.length) form.append("prompt", `Istilah: ${terms.join(", ")}.`);
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: settings.sttApiKey ? { Authorization: `Bearer ${settings.sttApiKey}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`STT API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { text?: string; segments?: { start: number; end: number; text: string }[] };
  return json.segments?.length ? json.segments : [{ start: 0, end: 0, text: json.text ?? "" }];
}

export interface TranscribeInput {
  audio: AudioTrack[];
  settings: Settings;
  dictionary: DictionaryEntry[];
  speakerFor: (ch: Channel) => string;
  onProgress: Progress;
  onLanguage?: (language: string) => void;
}

export async function transcribeTracks({ audio, settings, dictionary, speakerFor, onProgress, onLanguage }: TranscribeInput): Promise<Segment[]> {
  let sources = audio.filter((a) => a.channel === "mic" || a.channel === "system");
  if (!sources.length) sources = audio.filter((a) => a.channel === "mix");
  if (!sources.length) throw new Error("Tidak ada audio untuk ditranskrip.");

  if (settings.sttEngine === "browser") {
    const device = await whisper.resolveDevice(settings.whisperDevice);
    const model = WHISPER_MODELS.some((m) => m.id === settings.whisperModel) ? settings.whisperModel : WHISPER_MODELS[1].id;
    await whisper.load(model, device as "webgpu" | "wasm", (loaded, total) =>
      onProgress(0, total ? `Mengunduh model ${Math.round((loaded / total) * 100)}% (sekali saja)` : "Mengunduh model…"),
    );
  }

  const language = settings.sttLanguage;
  const segments: Segment[] = [];
  const failures: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const track = sources[i];
    const channel: Channel = track.channel === "system" ? "system" : "mic";
    const label = sources.length === 1 && track.channel === "mix" ? "" : speakerFor(channel);
    const blob = await getBlob(track.blobKey);
    if (!blob) continue;
    const base = i / sources.length;
    const span = 1 / sources.length;
    const name = channel === "system" ? "audio peserta" : "mikrofon";
    onProgress(base, `Menyiapkan ${name}…`);
    let chunks: Chunk[];
    let startSec = 0;
    try {
      if (settings.sttEngine === "api") {
        onProgress(base, `Mengirim ${name} ke layanan transkripsi…`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const repaired = repairHeaderlessWebm(bytes);
        startSec = repaired?.startSec ?? 0;
        chunks = await transcribeApi(repaired ? new Blob([repaired.bytes as BlobPart], { type: "audio/webm" }) : blob, settings, dictionary);
      } else {
        const decoded = await decodeToMono16k(blob);
        startSec = decoded.startSec;
        if (language === "auto") onProgress(base, "Mendeteksi bahasa…");
        chunks = await transcribeBrowser(
          decoded.pcm,
          { ...settings, sttLanguage: language },
          (f) => onProgress(base + span * f, `Mentranskrip ${name} ${Math.round(f * 100)}%`),
          (l) => onLanguage?.(l),
        );
      }
    } catch (e) {
      console.warn("transcribe track failed", track.blobKey, e);
      failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const offset = (track.offsetMs ?? 0) / 1000 + startSec;
    for (const c of chunks) {
      const text = applyDictionary(cleanText(c.text), dictionary);
      if (!text) continue;
      segments.push({ id: uid("g_"), channel, speaker: label, start: c.start + offset, end: Math.max(c.end, c.start) + offset, text });
    }
  }
  if (failures.length === sources.length) throw new Error(`Audio tidak dapat dibaca (${failures.join("; ")}).`);
  segments.sort((a, b) => a.start - b.start);
  return dropEcho(segments);
}
