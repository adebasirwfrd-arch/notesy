import { emit, getBlob, kvGet, kvSet, listSlides, subscribe, updateNote } from "../db";
import type { Mom, MomAttendee, Note, Slide } from "../types";
import { formatClock, uid } from "../util";
import { getSettings } from "../settings";
import { TARGET } from "../platform";
import { NOTESY_SERVER } from "../ai/cursor";
import { cloudPass } from "../stt/cloud";

const TEMPLATE_KEY = "mom-template";
const LAST_FORM_KEY = "mom-last-form";
export const EVIDENCE_SLOTS = 4;

const longDate = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const clock = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" });

export const newAttendee = (p: Partial<MomAttendee> = {}): MomAttendee => ({ id: uid("a_"), name: "", company: "", empNo: "", title: "", ...p });

export function meetingDate(note: Note) {
  return longDate.format(note.startedAt ?? note.createdAt);
}

export function meetingTime(note: Note) {
  const start = note.startedAt ?? note.createdAt;
  return note.durationMs > 0 ? `${clock.format(start)} – ${clock.format(start + note.durationMs)}` : clock.format(start);
}

export function emptyMom(): Mom {
  return { date: "", time: "", location: "", facilitator: "", attendees: [], items: [], preparedBy: { name: "", position: "" } };
}

/** The MoM with date and time falling back to the recording itself. */
export function resolveMom(note: Note): Mom {
  const mom = note.mom ?? emptyMom();
  return { ...mom, date: mom.date || meetingDate(note), time: mom.time || meetingTime(note) };
}

export function updateMom(noteId: string, fn: (m: Mom) => void) {
  return updateNote(noteId, (n) => {
    const mom = n.mom ? structuredClone(n.mom) : emptyMom();
    fn(mom);
    n.mom = mom;
  });
}

export function evidenceSlides(mom: Mom, slides: Slide[]) {
  if (mom.evidenceSlideIds) return mom.evidenceSlideIds.map((id) => slides.find((s) => s.id === id)).filter(Boolean) as Slide[];
  const usable = slides.filter((s) => !s.excluded);
  const described = usable.filter((s) => s.caption || s.description);
  return (described.length ? described : usable).slice(0, EVIDENCE_SLOTS);
}

export const evidenceName = (s: Slide) => s.caption?.trim() || `Tangkapan layar menit ${formatClock(s.t)}`;

export async function loadEvidence(mom: Mom, noteId: string) {
  const slides = evidenceSlides(mom, await listSlides(noteId));
  const out: { name: string; blob: Blob }[] = [];
  for (const s of slides) {
    const blob = await getBlob(s.blobKey);
    if (blob) out.push({ name: evidenceName(s), blob });
  }
  return out;
}

/** The company template is confidential and must not ship in the public repo: it is cached on the device and
 * shared between devices through the passcode-protected Notesy server. */
export async function getMomTemplate(): Promise<Blob | undefined> {
  return (await kvGet<Blob>(TEMPLATE_KEY)) ?? (await pullMomTemplate().catch(() => undefined));
}

const templateUrl = () => (TARGET === "web" ? "/api/mom-template" : `${NOTESY_SERVER}/api/mom-template`);

/** Downloads the shared template when this device has none yet; resolves undefined without a passcode or server copy. */
export async function pullMomTemplate(): Promise<Blob | undefined> {
  const pass = cloudPass(getSettings());
  if (!pass) return undefined;
  const res = await fetch(templateUrl(), { headers: { "x-notesy-pass": pass } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `Server Notesy menolak (${res.status}).`);
  const blob = new Blob([await res.arrayBuffer()], { type: res.headers.get("content-type") ?? "" });
  await kvSet(TEMPLATE_KEY, blob);
  await kvSet(`${TEMPLATE_KEY}-name`, decodeURIComponent(res.headers.get("x-file-name") ?? "") || "MoM Roster Meeting.docx");
  emit("mom-template");
  return blob;
}

/** Saves the template on this device and, with a passcode, on the server for the user's other devices. Returns whether it was shared. */
export async function setMomTemplate(file: File): Promise<boolean> {
  if (!/\.docx$/i.test(file.name)) throw new Error("Template harus file Word .docx.");
  const { readTemplate } = await import("./docx");
  await readTemplate(file);
  const data = await file.arrayBuffer();
  await kvSet(TEMPLATE_KEY, new Blob([data], { type: file.type }));
  await kvSet(`${TEMPLATE_KEY}-name`, file.name);
  emit("mom-template");
  const pass = cloudPass(getSettings());
  if (!pass) return false;
  const res = await fetch(templateUrl(), {
    method: "PUT",
    headers: { "x-notesy-pass": pass, "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
    body: data,
  }).catch(() => null);
  return !!res?.ok;
}

export const momTemplateName = () => kvGet<string>(`${TEMPLATE_KEY}-name`);
export const onMomTemplateChange = (f: () => void) => subscribe("mom-template", f);

export interface LastForm {
  location: string;
  facilitator: string;
  attendees: MomAttendee[];
  preparedBy: { name: string; position: string };
  needSignature?: boolean;
}

export const getLastForm = () => kvGet<LastForm>(LAST_FORM_KEY);

export function saveLastForm(mom: Mom) {
  return kvSet(LAST_FORM_KEY, {
    location: mom.location,
    facilitator: mom.facilitator,
    attendees: mom.attendees.map(({ signature: _s, ...a }) => a),
    preparedBy: { name: mom.preparedBy.name, position: mom.preparedBy.position },
    needSignature: mom.needSignature !== false,
  } satisfies LastForm);
}

export function dataUrlToBytes(dataUrl: string) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Re-encodes any image as JPEG (photos) or PNG (signatures) so both Word and pdf-lib accept it. */
export async function normalizeImage(blob: Blob, type: "image/jpeg" | "image/png", maxSide = 1600) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type, quality: 0.88 });
  return { bytes: new Uint8Array(await out.arrayBuffer()), width: w, height: h };
}

export function fitBox(w: number, h: number, maxW: number, maxH: number) {
  const s = Math.min(maxW / w, maxH / h);
  return { w: w * s, h: h * s };
}

export function summaryMarkdown(note: Note) {
  const doc = note.summaries.find((s) => s.id === note.activeSummaryId) ?? note.summaries.at(-1);
  return doc?.markdown.replace(/!\[[^\]]*\]\(slide:[\w-]+\)\n?/g, "").trim() ?? "";
}
