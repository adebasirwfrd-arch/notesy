import { get, list, put } from "@vercel/blob";

/**
 * Online attendance for a meeting, keyed by two secrets:
 * - `key` (organizer only, never leaves the Notesy device that created it) reads the submissions and edits the meeting info;
 * - `id` = hash of `key`, printed in the QR code, lets attendees read the meeting info and sign in.
 * Blobs (all private): `att/<id>/meta.json`, one `att/<id>/sub/<entry>.json` per sign-in (so simultaneous sign-ins never
 * conflict), and `att/<id>/stamp.json`, rewritten on every sign-in so the organizer can poll with a cheap conditional read.
 */

const ID = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{22,64}$/;
const ENTRY = /^[a-z0-9]{8,24}$/;
const OPEN_FOR_MS = 3 * 24 * 60 * 60 * 1000;
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
  const res = await get(pathname, { access: "private", useCache: false, ...(ifNoneMatch ? { ifNoneMatch } : {}) });
  if (!res) return null;
  const etag = res.blob.etag.replace(/^W\//, "");
  if (res.statusCode === 304) return { etag, value: null as T | null, notModified: true };
  return { etag, value: (await new Response(res.stream).json()) as T, notModified: false };
}

const write = (pathname: string, value: unknown, overwrite: boolean) =>
  put(pathname, JSON.stringify(value), { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: overwrite, cacheControlMaxAge: 60 });

async function entriesAfter(id: string, after: string) {
  const prefix = `att/${id}/sub/`;
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    paths.push(...page.blobs.map((b) => b.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const fresh = paths.filter((p) => !after || p > `${prefix}${after}.json`).sort();
  const out: Entry[] = [];
  for (let i = 0; i < fresh.length; i += 8) {
    const batch = await Promise.all(fresh.slice(i, i + 8).map((p) => readJson<Entry>(p).catch(() => null)));
    for (const b of batch) if (b?.value) out.push(b.value);
  }
  return { entries: out, ids: new Set(paths.map((p) => p.slice(prefix.length, -5))) };
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    if (!KEY.test(key)) return fail(400, "Kunci absensi tidak valid.");
    const after = url.searchParams.get("after") ?? "";
    if (after && !ENTRY.test(after)) return fail(400, "Parameter tidak valid.");
    const id = await idFor(key);
    const stamp = await readJson<{ last: string }>(`att/${id}/stamp.json`, req.headers.get("if-none-match") ?? undefined);
    if (!stamp) return reply(200, { entries: [] });
    if (stamp.notModified) return reply(304, null);
    const { entries, ids } = await entriesAfter(id, after);
    // Listing can lag a fresh upload by a moment; without an ETag the client asks again in full next time.
    const complete = !stamp.value?.last || ids.has(stamp.value.last);
    return reply(200, { entries }, complete ? { etag: stamp.etag } : {});
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
  await write(`att/${id}/meta.json`, meta, true);
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
    id: `${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
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

  await write(`att/${id}/sub/${entry.id}.json`, entry, false);
  // The sign-in is already stored; a lost stamp only delays the organizer's next refresh.
  await write(`att/${id}/stamp.json`, { last: entry.id }, true).catch(() => undefined);
  return reply(200, { ok: true, id: entry.id });
}
