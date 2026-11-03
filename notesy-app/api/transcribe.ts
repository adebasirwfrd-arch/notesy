export const config = { runtime: "edge" };

const UPSTREAM = "https://api.groq.com/openai/v1/audio/transcriptions";
/** A 30 s window as 16 kHz 16-bit WAV is ~1 MB; anything far larger is not a Notesy window. */
const MAX_BYTES = 4_000_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-notesy-pass",
  "Access-Control-Expose-Headers": "retry-after",
};

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } });

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface GroqSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
  avg_logprob?: number;
  compression_ratio?: number;
}

/** Whisper invents text over silence and noise; these are its usual tells. */
const hallucinated = (s: GroqSegment) =>
  ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -1) || (s.compression_ratio ?? 0) > 2.6;

/** Transcribes one speech window with the server-held Groq key, for callers that present the Notesy passcode. */
export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const key = process.env.GROQ_API_KEY ?? "";
  const pass = process.env.NOTESY_PASSCODE ?? "";
  if (!key || !pass) return reply(503, { message: "Server Notesy belum diisi GROQ_API_KEY dan NOTESY_PASSCODE." });
  if (!sameSecret(req.headers.get("x-notesy-pass") ?? "", pass)) return reply(401, { message: "Kode akses Notesy salah." });
  if (req.method === "GET") return reply(200, { ok: true, model: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo" });
  if (req.method !== "POST") return reply(405, { message: "Metode tidak didukung." });

  const audio = await req.arrayBuffer();
  if (!audio.byteLength) return reply(400, { message: "Audio kosong." });
  if (audio.byteLength > MAX_BYTES) return reply(413, { message: "Potongan audio terlalu besar." });

  const url = new URL(req.url);
  const form = new FormData();
  form.append("file", new Blob([audio], { type: req.headers.get("content-type") || "audio/wav" }), "window.wav");
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const language = url.searchParams.get("language") ?? "";
  if (/^[a-z]{2,3}$/.test(language)) form.append("language", language);
  const prompt = (url.searchParams.get("prompt") ?? "").slice(0, 800);
  if (prompt) form.append("prompt", prompt);

  const upstream = await fetch(UPSTREAM, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!upstream.ok) {
    const retry = upstream.headers.get("retry-after");
    const detail = (await upstream.text()).slice(0, 300);
    return reply(upstream.status, { message: `Groq ${upstream.status}: ${detail}` }, retry ? { "retry-after": retry } : {});
  }
  const json = (await upstream.json()) as { language?: string; text?: string; duration?: number; segments?: GroqSegment[] };
  const segments = (json.segments ?? [{ start: 0, end: json.duration ?? 0, text: json.text ?? "" }])
    .filter((s) => !hallucinated(s))
    .map((s) => ({ start: s.start, end: s.end, text: s.text }));
  return reply(200, { language: json.language ?? null, segments });
}
