export const config = { runtime: "edge" };

const UPSTREAM = "https://api.cursor.com";

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const json = (status: number, message: string) =>
  new Response(JSON.stringify({ code: "notesy_proxy", message }), { status, headers: { "Content-Type": "application/json" } });

/** Injects the server-held Cursor key for callers that present the Notesy passcode. */
export default async function handler(req: Request) {
  const key = process.env.CURSOR_API_KEY ?? "";
  const pass = process.env.NOTESY_PASSCODE ?? "";
  if (!key || !pass) return json(503, "Server Notesy belum diisi CURSOR_API_KEY dan NOTESY_PASSCODE.");
  if (!sameSecret(req.headers.get("x-notesy-pass") ?? "", pass)) return json(401, "Kode akses Notesy salah.");

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "";
  if (!/^v1\/[\w\-/]*$/.test(path)) return json(400, "Path tidak diizinkan.");
  url.searchParams.delete("path");
  const qs = url.searchParams.toString();

  const headers = new Headers();
  for (const h of ["content-type", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("authorization", `Basic ${btoa(`${key}:`)}`);

  const upstream = await fetch(`${UPSTREAM}/${path}${qs ? `?${qs}` : ""}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
  });
  const out = new Headers();
  for (const h of ["content-type", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
