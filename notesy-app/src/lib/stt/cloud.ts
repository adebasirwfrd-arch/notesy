import { NOTESY_SERVER, isCursorKey } from "../ai/cursor";
import { TARGET } from "../platform";
import type { DictionaryEntry, Settings } from "../types";
import { SAMPLE_RATE } from "./audio";

export interface CloudChunk {
  start: number;
  end: number;
  text: string;
}

/** Groq's free tier allows 20 requests a minute per organization; stay just under it. */
const MIN_GAP_MS = 3100;
/** Waiting out a short rate-limit pause beats falling back to the much slower local model. */
export const MAX_WAIT_MS = 20_000;
/** After an outage or a rejected passcode, stop trying the cloud for a while instead of failing every window. */
const FAILURE_PAUSE_MS = 120_000;

const LANGUAGE_CODES: Record<string, string> = { indonesian: "id", english: "en", malay: "ms", javanese: "jv", sundanese: "su" };

export class CloudBusyError extends Error {}

let nextAt = 0;
let pausedUntil = 0;

/** The passcode for the Notesy server: its own field, or the AI passcode when that is not a raw Cursor key. */
export function cloudPass(s: Settings) {
  const own = s.cloudPasscode.trim();
  if (own) return own;
  const ai = s.cursorApiKey.trim();
  return ai && !isCursorKey(ai) ? ai : "";
}

export const cloudEnabled = (s: Settings) => s.sttCloud !== "off" && !!cloudPass(s);

/** Milliseconds until the cloud accepts another request (rate-limit pause plus request spacing). */
export const cloudWaitMs = () => Math.max(0, pausedUntil - Date.now(), nextAt - Date.now());

const endpoint = () => (TARGET === "web" ? "/api/transcribe" : `${NOTESY_SERVER}/api/transcribe`);

function wav(pcm: Float32Array) {
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, SAMPLE_RATE, true);
  out.setUint32(28, SAMPLE_RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return out.buffer;
}

/** Transcribes one window on the Notesy server (Groq Whisper Large v3 Turbo). Throws CloudBusyError when rate-limited. */
export async function cloudTranscribe(pcm: Float32Array, s: Settings, dict: DictionaryEntry[]): Promise<{ chunks: CloudChunk[]; language?: string }> {
  const wait = cloudWaitMs();
  if (Date.now() < pausedUntil && wait > MAX_WAIT_MS) throw new CloudBusyError("Kuota cloud sedang penuh.");
  nextAt = Math.max(Date.now(), nextAt) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const params = new URLSearchParams();
  if (s.sttLanguage !== "auto") params.set("language", s.sttLanguage === "jv" ? "jw" : s.sttLanguage);
  const terms = dict.map((d) => d.term).slice(0, 60);
  if (terms.length) params.set("prompt", `Istilah: ${terms.join(", ")}.`);
  let res: Response;
  try {
    res = await fetch(`${endpoint()}?${params}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "X-Notesy-Pass": cloudPass(s) },
      body: wav(pcm),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    pausedUntil = Date.now() + FAILURE_PAUSE_MS;
    throw e;
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    pausedUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 30_000);
    throw new CloudBusyError("Kuota cloud sedang penuh.");
  }
  const json = (await res.json().catch(() => ({}))) as { message?: string; language?: string | null; segments?: CloudChunk[] };
  if (!res.ok) {
    pausedUntil = Date.now() + FAILURE_PAUSE_MS;
    throw new Error(json.message ?? `Server transkripsi ${res.status}`);
  }
  const lang = json.language?.toLowerCase();
  return { chunks: json.segments ?? [], language: lang ? (LANGUAGE_CODES[lang] ?? (lang.length <= 3 ? lang : undefined)) : undefined };
}

/** Checks the passcode and that the server has a Groq key. */
export async function testCloud(s: Settings): Promise<string> {
  const res = await fetch(endpoint(), { headers: { "X-Notesy-Pass": cloudPass(s) } });
  const json = (await res.json().catch(() => ({}))) as { message?: string; model?: string };
  if (!res.ok) throw new Error(json.message ?? `Server transkripsi ${res.status}`);
  return json.model ?? "ok";
}
