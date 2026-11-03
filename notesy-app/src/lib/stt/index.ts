import { getBlob } from "../db";
import { ensureHostPermission, assetUrl, hasWebGPU } from "../platform";
import type { AudioTrack, Channel, DictionaryEntry, Segment, Settings } from "../types";
import { uid } from "../util";
import { decodePieces, SAMPLE_RATE, speechWindows } from "./audio";
import { CloudBusyError, cloudEnabled, cloudTranscribe } from "./cloud";
import { isCovered, uncovered, type Ranges } from "./coverage";
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

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

type Device = "webgpu" | "wasm";

/** ORT's WebGPU backend degrades after a few hundred runs (then fails or hangs); a fresh worker before that keeps it healthy. */
const RECYCLE_AFTER = 120;

class WhisperClient {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private loading: Promise<string> | null = null;
  private loadedKey = "";
  private onDownload: ((loaded: number, total: number) => void) | null = null;
  private model = "";
  private preferred: Device = "wasm";
  private calls = 0;
  private queue: Promise<unknown> = Promise.resolve();

  /** Loads the model on the device the user prefers; later recoveries return to that device when they can. */
  async prepare(model: string, pref: Settings["whisperDevice"], onDownload?: (loaded: number, total: number) => void): Promise<string> {
    const preferred = await this.resolveDevice(pref);
    if (this.model === model && this.preferred === preferred && this.loadedKey.startsWith(`${model}|`)) return this.loadedKey.split("|")[1];
    const next = this.queue.then(() => {
      this.model = model;
      this.preferred = preferred;
      return this.load(model, preferred, onDownload);
    });
    this.queue = next.catch(() => {});
    return next;
  }

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

  private gpu: Promise<boolean> | null = null;

  async resolveDevice(pref: Settings["whisperDevice"]): Promise<"webgpu" | "wasm"> {
    if (pref === "wasm" || !hasWebGPU) return "wasm";
    this.gpu ??= (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu
      .requestAdapter()
      .then((a) => !!a)
      .catch(() => false);
    return (await this.gpu) ? "webgpu" : "wasm";
  }

  /** The device the model runs on now, or null when it is not loaded. */
  get device(): Device | null {
    return this.loadedKey ? (this.loadedKey.split("|")[1] as Device) : null;
  }

  load(model: string, device: Device, onDownload?: (loaded: number, total: number) => void): Promise<string> {
    const key = `${model}|${device}`;
    if (this.loadedKey === key) return Promise.resolve(device);
    if (this.loading) return this.loading;
    if (this.loadedKey) this.reset();
    this.model = model;
    const w = this.ensureWorker();
    this.onDownload = onDownload ?? null;
    const loading: Promise<string> = new Promise<string>((resolve, reject) => {
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
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  }

  private post<T>(msg: Record<string, unknown>, audio: Float32Array): Promise<T> {
    const id = ++this.seq;
    const w = this.ensureWorker();
    const copy = audio.slice();
    const p = new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: never) => void, reject });
      w.postMessage({ ...msg, id, audio: copy }, [copy.buffer]);
    });
    // After a GPU process crash, WebGPU calls can hang forever instead of failing.
    if (!this.loadedKey.endsWith("|webgpu")) return p;
    return withTimeout(p, Math.max(120, (audio.length / SAMPLE_RATE) * 8) * 1000, "WebGPU timeout");
  }

  /**
   * ORT's WebGPU session can break for good mid-recording (buffer download failures, device loss),
   * after which every call fails. A fresh worker gets a new GPU device; wasm is the last resort.
   */
  private call<T>(msg: Record<string, unknown>, audio: Float32Array): Promise<T> {
    const next = this.queue.then(() => this.callNow<T>(msg, audio));
    this.queue = next.catch(() => {});
    return next;
  }

  private async reload(device: Device) {
    this.reset();
    if (device === "webgpu") await withTimeout(this.load(this.model, device), 300_000, "WebGPU timeout (memuat ulang model)");
    else await this.load(this.model, device);
  }

  private async callNow<T>(msg: Record<string, unknown>, audio: Float32Array): Promise<T> {
    if (!this.model || !this.loadedKey) throw new Error("model not loaded");
    if (this.calls >= RECYCLE_AFTER && (this.loadedKey.endsWith("|webgpu") || this.preferred === "webgpu")) {
      this.calls = 0;
      await this.reload(this.preferred).catch(() => this.reload("wasm"));
    }
    try {
      const out = await this.post<T>(msg, audio);
      this.calls++;
      return out;
    } catch (first) {
      const device = this.loadedKey.split("|")[1] as Device;
      if (!/OrtRun|gpu|device|buffer|memory|abort/i.test(String((first as Error)?.message))) throw first;
      console.warn("whisper call failed, restarting worker", first);
      this.calls = 0;
      try {
        await this.reload(device);
        return await this.post<T>(msg, audio);
      } catch (second) {
        if (device !== "webgpu") throw second;
        console.warn("whisper still failing on WebGPU, switching to wasm", second);
        await this.reload("wasm");
        return await this.post<T>(msg, audio);
      }
    }
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
    this.loading = null;
    this.calls = 0;
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

export const resolveModel = (settings: Settings) =>
  WHISPER_MODELS.some((m) => m.id === settings.whisperModel) ? settings.whisperModel : WHISPER_MODELS[1].id;

export function prepareWhisper(settings: Settings, onDownload?: (loaded: number, total: number) => void) {
  return whisper.prepare(resolveModel(settings), settings.whisperDevice, onDownload);
}

/** Shorter windows cut at pauses usually hold a single speaker turn, so each gets its own language. */
export const windowSec = (settings: Settings) => (settings.sttLanguage === "auto" ? 12 : 28);

/**
 * Whisper translates whatever it hears into the language it is told, so mixed ID/EN meetings are transcribed window
 * by window in the language actually spoken, biased towards the meeting's main language as it emerges.
 */
export class LanguageTracker {
  private totals: Record<string, number> = {};
  constructor(
    private readonly fixed: string | undefined,
    public main: string | undefined,
  ) {}

  static for(settings: Settings, known?: string) {
    return settings.sttLanguage === "auto" ? new LanguageTracker(undefined, known) : new LanguageTracker(settings.sttLanguage, settings.sttLanguage);
  }

  async transcribe(slice: Float32Array): Promise<Chunk[]> {
    let language = this.fixed;
    if (!language) {
      const scores = await whisper.detect(slice, DETECT_CANDIDATES);
      const weight = slice.length / SAMPLE_RATE;
      for (const [code, s] of Object.entries(scores)) this.totals[code] = (this.totals[code] ?? 0) + s * weight;
      this.main = pickLanguage(this.totals, this.main);
      language = pickLanguage(scores, this.main);
    }
    return whisper.run(slice, language);
  }

  /** Counts a language the cloud detected, for the meeting's main language when no local scores exist. */
  noteCloud(language: string | undefined, seconds: number) {
    if (this.fixed || !language) return;
    this.votes[language] = (this.votes[language] ?? 0) + seconds;
    if (!Object.keys(this.totals).length) this.main = Object.entries(this.votes).sort((a, b) => b[1] - a[1])[0][0];
  }
  private votes: Record<string, number> = {};
}

export type Route = "local" | "cloud";

/** Post-meeting work is what people wait on, so it goes to the cloud whenever the cloud is enabled. */
export const batchRoute = (settings: Settings): Route => (settings.sttEngine === "browser" && cloudEnabled(settings) ? "cloud" : "local");

/** Live windows stay on the device unless it has no GPU or has fallen more than a minute behind. */
export function liveRoute(settings: Settings, backlogSec: number): Route {
  if (!cloudEnabled(settings)) return "local";
  if (settings.sttCloud === "always") return "cloud";
  return whisper.device === "wasm" || backlogSec > 60 ? "cloud" : "local";
}

/** Transcribes one window on the chosen engine; the local model takes over whenever the cloud cannot. */
export async function transcribeWindow(pcm: Float32Array, lang: LanguageTracker, settings: Settings, dict: DictionaryEntry[], route: Route): Promise<{ chunks: Chunk[]; route: Route }> {
  if (route === "cloud") {
    try {
      const r = await cloudTranscribe(pcm, settings, dict);
      lang.noteCloud(r.language, pcm.length / SAMPLE_RATE);
      return { chunks: r.chunks, route };
    } catch (e) {
      if (!(e instanceof CloudBusyError)) console.warn("cloud transcription failed, using the local model", e);
    }
  }
  await prepareWhisper(settings);
  return { chunks: await lang.transcribe(pcm), route: "local" };
}

export function toSegments(chunks: Chunk[], offsetSec: number, channel: Channel, speaker: string, dict: DictionaryEntry[]): Segment[] {
  const out: Segment[] = [];
  for (const c of chunks) {
    const text = applyDictionary(cleanText(c.text), dict);
    if (text) out.push({ id: uid("g_"), channel, speaker, start: c.start + offsetSec, end: Math.max(c.end, c.start) + offsetSec, text });
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

export type CoverageKey = Channel | "mix";
export type Coverage = Partial<Record<CoverageKey, Ranges>>;

export interface TranscribeInput {
  audio: AudioTrack[];
  settings: Settings;
  dictionary: DictionaryEntry[];
  speakerFor: (ch: Channel) => string;
  onProgress: Progress;
  /** Main language already known for this meeting (from live transcription or an earlier, interrupted run). */
  language?: string;
  onLanguage?: (language: string) => void;
  /** Spans already transcribed; only the rest is processed. */
  coverage?: Coverage;
  /** Called after every window, so progress survives a crash or closed tab. */
  onWindow: (key: CoverageKey, segments: Segment[], covered: [number, number]) => Promise<void> | void;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export async function transcribeTracks({ audio, settings, dictionary, speakerFor, onProgress, language, onLanguage, coverage = {}, onWindow }: TranscribeInput) {
  let sources = audio.filter((a) => a.channel === "mic" || a.channel === "system");
  if (!sources.length) sources = audio.filter((a) => a.channel === "mix");
  if (!sources.length) throw new Error("Tidak ada audio untuk ditranskrip.");

  const route = batchRoute(settings);
  if (settings.sttEngine === "browser" && route === "local") {
    await prepareWhisper(settings, (loaded, total) =>
      onProgress(0, total ? `Mengunduh model ${Math.round((loaded / total) * 100)}% (sekali saja)` : "Mengunduh model…"),
    );
  }
  // The cloud detects the language of every request itself, so it takes longer windows (fewer requests).
  const maxSec = route === "cloud" ? 28 : windowSec(settings);
  const lang = LanguageTracker.for(settings, language);
  const failures: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const track = sources[i];
    const key: CoverageKey = track.channel;
    const channel: Channel = track.channel === "system" ? "system" : "mic";
    const label = sources.length === 1 && track.channel === "mix" ? "" : speakerFor(channel);
    const offset = (track.offsetMs ?? 0) / 1000;
    const blob = await getBlob(track.blobKey);
    if (!blob) continue;
    const base = i / sources.length;
    const span = 1 / sources.length;
    const name = channel === "system" ? "audio peserta" : "mikrofon";
    onProgress(base, `Menyiapkan ${name}…`);
    let stage = "transkripsi gagal";
    try {
      if (settings.sttEngine === "api") {
        if (!uncovered(coverage[key], offset, offset + 1e7).length) continue;
        onProgress(base, `Mengirim ${name} ke layanan transkripsi…`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const repaired = repairHeaderlessWebm(bytes);
        const start = offset + (repaired?.startSec ?? 0);
        const chunks = await transcribeApi(repaired ? new Blob([repaired.bytes as BlobPart], { type: "audio/webm" }) : blob, settings, dictionary);
        const fresh = toSegments(chunks, start, channel, label, dictionary).filter((s) => !isCovered(coverage[key], (s.start + s.end) / 2));
        await onWindow(key, fresh, [offset, offset + 1e7]);
        continue;
      }
      stage = "audio tidak dapat dibaca";
      const pieces = decodePieces(blob, 300, (a, b) => !uncovered(coverage[key], offset + a, offset + b).length);
      for (let next = await pieces.next(); !next.done; next = await pieces.next()) {
        stage = "transkripsi gagal";
        const piece = next.value;
        const pStart = offset + piece.startSec;
        for (const [a, b] of uncovered(coverage[key], pStart, offset + piece.endSec)) {
          const s0 = Math.max(0, Math.round((a - pStart) * SAMPLE_RATE));
          const s1 = Math.min(piece.pcm.length, Math.round((b - pStart) * SAMPLE_RATE));
          if (s1 <= s0) {
            await onWindow(key, [], [a, b]);
            continue;
          }
          const sub = piece.pcm.subarray(s0, s1);
          const windows = speechWindows(sub, maxSec);
          let done = a;
          for (const w of windows) {
            const at = a + w.start / SAMPLE_RATE;
            const end = a + w.end / SAMPLE_RATE;
            const r = await transcribeWindow(sub.slice(w.start, w.end), lang, settings, dictionary, route);
            if (lang.main) onLanguage?.(lang.main);
            await onWindow(key, toSegments(r.chunks, at, channel, label, dictionary), [done, end]);
            done = end;
            const where = r.route === "cloud" ? " (cloud)" : "";
            onProgress(base + span * piece.fraction(w.end / sub.length, s0, s1), `Mentranskrip ${name}${where} · menit ke-${formatSpan(end)}`);
          }
          await onWindow(key, [], [done, b]);
        }
        stage = "audio tidak dapat dibaca";
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      console.warn("transcribe track failed", track.blobKey, e);
      failures.push(`${name} ${stage}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length === sources.length) throw new Error(`Transkrip tidak berhasil (${failures.join("; ")}).`);
  if (failures.length) console.warn("some tracks failed", failures);
  return { failures };
}

function formatSpan(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`;
}
