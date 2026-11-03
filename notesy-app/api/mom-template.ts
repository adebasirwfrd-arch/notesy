import { get, put } from "@vercel/blob";

/**
 * The company MoM template, shared across the user's devices. It is confidential (contains a real signature),
 * so it lives in private Blob storage, never in the public repo, and is only served for the Notesy passcode.
 */

const PATH = "mom/template.docx";
const NAME_PATH = "mom/template-name.txt";
const MAX_BYTES = 4_000_000;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-notesy-pass, x-file-name",
  "Access-Control-Expose-Headers": "x-file-name",
};

const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ message }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function denied(req: Request) {
  const pass = process.env.NOTESY_PASSCODE ?? "";
  if (!pass) return fail(503, "Server Notesy belum diisi NOTESY_PASSCODE.");
  if (!sameSecret(req.headers.get("x-notesy-pass") ?? "", pass)) return fail(401, "Kode akses Notesy salah.");
  return null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request) {
  const no = denied(req);
  if (no) return no;
  const res = await get(PATH, { access: "private", useCache: false });
  if (!res?.stream) return fail(404, "Belum ada template MoM di server.");
  const nameRes = await get(NAME_PATH, { access: "private", useCache: false });
  const name = nameRes?.stream ? await new Response(nameRes.stream).text() : "MoM Roster Meeting.docx";
  return new Response(res.stream, {
    headers: { "Content-Type": DOCX, "Cache-Control": "no-store", "x-file-name": encodeURIComponent(name), ...CORS },
  });
}

export async function PUT(req: Request) {
  const no = denied(req);
  if (no) return no;
  const body = await req.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_BYTES) return fail(413, "File template harus .docx di bawah 4 MB.");
  // A .docx is a zip archive.
  if (new Uint8Array(body, 0, 2).join() !== "80,75") return fail(400, "File bukan .docx.");
  const name = decodeURIComponent(req.headers.get("x-file-name") ?? "") || "MoM Roster Meeting.docx";
  const opts = { access: "private" as const, addRandomSuffix: false, allowOverwrite: true };
  await put(PATH, body, { ...opts, contentType: DOCX });
  await put(NAME_PATH, name.slice(0, 200), { ...opts, contentType: "text/plain" });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", ...CORS } });
}
