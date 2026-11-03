import { BlobPreconditionFailedError, get, put } from "@vercel/blob";

/**
 * Online attendance for a meeting, keyed by two secrets:
 * - `key` (organizer only, never leaves the Notesy device that created it) reads the submissions and edits the meeting info;
 * - `id` = hash of `key`, printed in the QR code, lets attendees read the meeting info and sign in.
 * Each session is two private blobs: `att/<id>/meta.json` and `att/<id>/list.json`.
 */

const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{22,64}$/;
const OPEN_FOR_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const MAX_SIGNATURE = 400_000;

interface Meta {
  title: string;
  date: string;
  location: string;
  facilitator: string;
  needSignature: boolean;
  updatedAt: number;
  expiresAt: number;
}

interface Entry {
  id: string;
  name: string;
  empNo: string;
  title: string;
  company: string;
  signature?: { dataUrl: string; width: number; height: number; kind: "drawn" | "image" };
  at: number;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, if-none-match",
  "Access-Control-Expose-Headers": "etag",
};

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers },
  });
const fail = (status: number, message: string) => reply(status, { message });

async function idFor(key: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`notesy-attendance:${key}`)));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

async function readJson<T>(pathname: string, ifNoneMatch?: string) {
  const res = await get(pathname, { access: "private", useCache: false, ifNoneMatch });
  if (!res) return null;
  if (res.statusCode === 304) return { etag: res.blob.etag, value: null as T | null, notModified: true };
  return { etag: res.blob.etag, value: (await new Response(res.stream).json()) as T, notModified: false };
}

const write = (pathname: string, value: unknown, ifMatch?: string) =>
  put(pathname, JSON.stringify(value), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    ...(ifMatch ? { ifMatch } : {}),
  });

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    if (!KEY.test(key)) return fail(400, "Kunci absensi tidak valid.");
    const id = await idFor(key);
    const list = await readJson<{ entries: Entry[] }>(`att/${id}/list.json`, req.headers.get("if-none-match") ?? undefined);
    if (!list) return reply(200, { entries: [] });
    if (list.notModified) return reply(304, null, { etag: list.etag });
    return reply(200, { entries: list.value?.entries ?? [] }, { etag: list.etag });
  }
  const id = url.searchParams.get("id") ?? "";
  if (!ID.test(id)) return fail(400, "Link absensi tidak valid.");
  const meta = await readJson<Meta>(`att/${id}/meta.json`);
  if (!meta?.value) return fail(404, "Absensi tidak ditemukan. Minta link/QR terbaru ke penyelenggara rapat.");
  const { title, date, location, facilitator, needSignature, expiresAt } = meta.value;
  return reply(200, { title, date, location, facilitator, needSignature, closed: Date.now() > expiresAt });
}

export async function PUT(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!KEY.test(key)) return fail(400, "Kunci absensi tidak valid.");
  const body = (await req.json().catch(() => null)) as Partial<Meta> | null;
  if (!body) return fail(400, "Data rapat kosong.");
  const now = Date.now();
  const meta: Meta = {
    title: text(body.title, 200),
    date: text(body.date, 80),
    location: text(body.location, 160),
    facilitator: text(body.facilitator, 120),
    needSignature: body.needSignature === true,
    updatedAt: now,
    expiresAt: now + OPEN_FOR_MS,
  };
  const id = await idFor(key);
  await write(`att/${id}/meta.json`, meta);
  return reply(200, { id });
}

export async function POST(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID.test(id)) return fail(400, "Link absensi tidak valid.");
  const meta = (await readJson<Meta>(`att/${id}/meta.json`))?.value;
  if (!meta) return fail(404, "Absensi tidak ditemukan.");
  if (Date.now() > meta.expiresAt) return fail(410, "Absensi rapat ini sudah ditutup.");

  const body = (await req.json().catch(() => null)) as Partial<Entry> | null;
  const entry: Entry = {
    id: `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 8)}`,
    name: text(body?.name, 120),
    empNo: text(body?.empNo, 40),
    title: text(body?.title, 120),
    company: text(body?.company, 120),
    at: Date.now(),
  };
  if (!entry.name) return fail(400, "Nama lengkap wajib diisi.");
  const sig = body?.signature;
  if (sig && typeof sig.dataUrl === "string") {
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(sig.dataUrl) || sig.dataUrl.length > MAX_SIGNATURE) return fail(400, "Gambar tanda tangan tidak valid atau terlalu besar.");
    entry.signature = { dataUrl: sig.dataUrl, width: Math.max(1, Math.round(+sig.width || 1)), height: Math.max(1, Math.round(+sig.height || 1)), kind: sig.kind === "image" ? "image" : "drawn" };
  }
  if (meta.needSignature && !entry.signature) return fail(400, "Tanda tangan wajib diisi.");

  // Optimistic concurrency: attendees often submit at the same moment right after the QR is shown.
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await readJson<{ entries: Entry[] }>(`att/${id}/list.json`);
    const entries = cur?.value?.entries ?? [];
    if (entries.length >= MAX_ENTRIES) return fail(429, "Daftar hadir sudah penuh.");
    try {
      if (cur) await write(`att/${id}/list.json`, { entries: [...entries, entry] }, cur.etag);
      else
        await put(`att/${id}/list.json`, JSON.stringify({ entries: [entry] }), {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60,
        });
      return reply(200, { ok: true, id: entry.id });
    } catch (e) {
      const conflict = e instanceof BlobPreconditionFailedError || /already exists|precondition/i.test(String((e as Error)?.message));
      if (!conflict) throw e;
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 220 * (attempt + 1)));
    }
  }
  return fail(503, "Server sedang sibuk. Coba kirim lagi.");
}
