import QRCode from "qrcode";
import { getNote } from "./db";
import { emptyMom, meetingDate, newAttendee, updateMom } from "./mom";
import { TARGET } from "./platform";
import type { Mom, MomAttendance, Note } from "./types";

/** Attendees always reach the public web deploy, whichever Notesy build (web, extension, Android) created the QR. */
const PUBLIC_ORIGIN = "https://notesy-three.vercel.app";
const OPEN_FOR_MS = 3 * 24 * 60 * 60 * 1000;

export function attendanceOrigin() {
  const override = typeof localStorage !== "undefined" ? localStorage.getItem("notesy-attendance-origin") : null;
  if (override) return override;
  if (TARGET === "web" && !/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) return location.origin;
  return PUBLIC_ORIGIN;
}

export interface AttendanceInfo {
  title: string;
  date: string;
  location: string;
  facilitator: string;
  needSignature: boolean;
}

export interface AttendanceEntry {
  id: string;
  name: string;
  empNo: string;
  title: string;
  company: string;
  signature?: { dataUrl: string; width: number; height: number; kind: "drawn" | "image" };
  at: number;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Must match `idFor` in api/attendance.ts. */
async function idFor(key: string) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`notesy-attendance:${key}`)));
  return b64url(hash).slice(0, 22);
}

export async function newAttendance(): Promise<MomAttendance> {
  const key = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { id: await idFor(key), key, createdAt: Date.now() };
}

export const attendanceUrl = (id: string) => `${attendanceOrigin()}/absen?i=${id}`;
export const attendanceOpen = (a: MomAttendance) => Date.now() - a.createdAt < OPEN_FOR_MS;

async function api(query: string, init?: RequestInit) {
  let res: Response;
  try {
    res = await fetch(`${attendanceOrigin()}/api/attendance?${query}`, { ...init, cache: "no-store" });
  } catch {
    throw new Error("Tidak bisa terhubung ke server absensi. Periksa koneksi internet.");
  }
  if (res.status === 304) return res;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Server absensi menolak permintaan (${res.status}).`);
  }
  return res;
}

export function attendanceInfo(mom: Mom, title: string, note?: Note): AttendanceInfo {
  const fallbackDate = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(Date.now());
  return {
    title: title.trim() || (note && !note.titleIsAuto ? note.title : "") || "Rapat",
    date: mom.date || (note ? meetingDate(note) : fallbackDate),
    location: mom.location,
    facilitator: mom.facilitator,
    needSignature: mom.needSignature !== false,
  };
}

/** Creates or updates the meeting info attendees see; also reopens the form for another 3 days. */
export async function publishAttendance(a: MomAttendance, info: AttendanceInfo) {
  await api(`key=${a.key}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(info) });
}

const cache = new Map<string, { etag: string; entries: AttendanceEntry[] }>();

/** Returns every sign-in so far; `force` skips the "nothing changed" shortcut (manual refresh, export). */
export async function fetchAttendance(a: MomAttendance, force = false) {
  const prev = cache.get(a.key) ?? { etag: "", entries: [] };
  const after = prev.entries.reduce((m, e) => (e.id > m ? e.id : m), "");
  const res = await api(`key=${a.key}${after ? `&after=${after}` : ""}`, { headers: prev.etag && !force ? { "If-None-Match": prev.etag } : {} });
  if (res.status === 304) return prev.entries;
  const { entries } = (await res.json()) as { entries: AttendanceEntry[] };
  const known = new Set(prev.entries.map((e) => e.id));
  const next = { etag: res.headers.get("etag") ?? "", entries: [...prev.entries, ...entries.filter((e) => !known.has(e.id))] };
  cache.set(a.key, next);
  return next.entries;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Adds new sign-ins to the roster; a typed-in row with the same name is completed instead of duplicated. */
export function mergeEntries(mom: Mom, entries: AttendanceEntry[]) {
  const dismissed = new Set(mom.dismissedEntries ?? []);
  let added = 0;
  for (const e of [...entries].sort((x, y) => x.at - y.at)) {
    if (dismissed.has(e.id) || mom.attendees.some((a) => a.source === e.id)) continue;
    const signature = e.signature ? { ...e.signature, signedAt: e.at } : undefined;
    const match = mom.attendees.find((a) => !a.source && norm(a.name) === norm(e.name));
    if (match) {
      match.source = e.id;
      match.name = e.name;
      if (e.company) match.company = e.company;
      if (e.empNo) match.empNo = e.empNo;
      if (e.title) match.title = e.title;
      if (signature) match.signature = signature;
    } else {
      mom.attendees.push(newAttendee({ name: e.name, company: e.company, empNo: e.empNo, title: e.title, signature, source: e.id }));
    }
    added++;
  }
  return added;
}

/** Pulls the latest sign-ins into the note's MoM. Returns how many rows were added or completed. */
export async function syncAttendance(noteId: string, force = false) {
  const note = await getNote(noteId);
  const a = note?.mom?.attendance;
  if (!a) return 0;
  const entries = await fetchAttendance(a, force);
  if (!entries.length) return 0;
  const probe = structuredClone(note.mom ?? emptyMom());
  if (!mergeEntries(probe, entries)) return 0;
  let added = 0;
  await updateMom(noteId, (m) => void (added = mergeEntries(m, entries)));
  return added;
}

/**
 * Polls for sign-ins while a note with an open attendance form is on screen. Each poll is one conditional read
 * (304 when nothing changed); it slows down once sign-ins stop arriving.
 */
export function watchAttendance(noteId: string, onAdded: (n: number) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastChange = Date.now();
  const tick = async () => {
    if (stopped) return;
    if (document.visibilityState === "visible") {
      try {
        const n = await syncAttendance(noteId);
        if (n) {
          lastChange = Date.now();
          onAdded(n);
        }
      } catch {
        /* offline or server busy: try again on the next tick */
      }
    }
    if (!stopped) timer = setTimeout(tick, Date.now() - lastChange > 20 * 60_000 ? 90_000 : 20_000);
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible" || stopped) return;
    clearTimeout(timer);
    void tick();
  };
  document.addEventListener("visibilitychange", onVisible);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export function qrDataUrl(url: string, size = 640) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: size, color: { dark: "#0f172a", light: "#ffffff" } });
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines;
}

/** A shareable/printable card: the attendance QR with the meeting name, in the attendance page's colours. */
export async function qrCard(info: AttendanceInfo, url: string): Promise<Blob> {
  const W = 1080;
  const H = 1440;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const font = (weight: number, size: number) => `${weight} ${size}px Inter, "Segoe UI", system-ui, -apple-system, sans-serif`;
  const round = (x: number, y: number, w: number, h: number, r: number, fill: string) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);

  ctx.font = font(800, 30);
  const badge = "ATTENDANCE FORM";
  const bw = ctx.measureText(badge).width + 72;
  round((W - bw) / 2, 70, bw, 64, 32, "rgba(225, 29, 46, 0.16)");
  ctx.strokeStyle = "rgba(225, 29, 46, 0.45)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#ef233c";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(badge, W / 2, 103);

  ctx.font = font(900, 62);
  ctx.fillStyle = "#ffffff";
  const titleLines = wrapLines(ctx, info.title.toUpperCase(), W - 140, 3);
  let y = 200;
  for (const l of titleLines) {
    ctx.fillText(l, W / 2, y + 34);
    y += 76;
  }

  const chips = [info.date, info.location].filter(Boolean).join("   •   ");
  if (chips) {
    ctx.font = font(700, 30);
    ctx.fillStyle = "#94a3b8";
    for (const l of wrapLines(ctx, chips, W - 160, 2)) {
      ctx.fillText(l, W / 2, y + 30);
      y += 44;
    }
  }

  const box = 700;
  const top = Math.max(y + 50, 470);
  round((W - box - 60) / 2, top, box + 60, box + 60, 40, "#ffffff");
  const img = new Image();
  img.src = await qrDataUrl(url, box);
  await img.decode();
  ctx.drawImage(img, (W - box) / 2, top + 30, box, box);

  ctx.font = font(800, 40);
  ctx.fillStyle = "#ffffff";
  ctx.fillText("Scan untuk mengisi daftar hadir", W / 2, top + box + 130);
  ctx.font = font(600, 26);
  ctx.fillStyle = "#64748b";
  ctx.fillText(url.replace(/^https?:\/\//, ""), W / 2, top + box + 182);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Gagal membuat gambar QR."))), "image/png"));
}
