import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Note, Slide } from "./types";

interface NotesyDB extends DBSchema {
  notes: { key: string; value: Note; indexes: { byCreated: number } };
  slides: { key: string; value: Slide; indexes: { byNote: string } };
  blobs: { key: string; value: Blob };
  chunks: { key: [string, number]; value: { session: string; seq: number; blob: Blob }; indexes: { bySession: string } };
  kv: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<NotesyDB>> | null = null;

export function db() {
  if (!dbp) {
    dbp = openDB<NotesyDB>("notesy", 1, {
      upgrade(d) {
        const notes = d.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("byCreated", "createdAt");
        const slides = d.createObjectStore("slides", { keyPath: "id" });
        slides.createIndex("byNote", "noteId");
        d.createObjectStore("blobs");
        const chunks = d.createObjectStore("chunks", { keyPath: ["session", "seq"] });
        chunks.createIndex("bySession", "session");
        d.createObjectStore("kv");
      },
    });
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  }
  return dbp;
}

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(topic: string, fn: Listener) {
  let set = listeners.get(topic);
  if (!set) listeners.set(topic, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function emit(topic: string) {
  listeners.get(topic)?.forEach((fn) => fn());
  if (topic !== "*") listeners.get("*")?.forEach((fn) => fn());
}

export async function listNotes(): Promise<Note[]> {
  const all = await (await db()).getAllFromIndex("notes", "byCreated");
  return all.reverse();
}

export async function getNote(id: string) {
  return (await db()).get("notes", id);
}

export async function putNote(note: Note) {
  await (await db()).put("notes", note);
  emit("notes");
  emit(`note:${note.id}`);
}

const writeQueues = new Map<string, Promise<unknown>>();

/** Serialized read-modify-write so concurrent pipeline steps never clobber each other. */
export function updateNote(id: string, fn: (n: Note) => void | Note): Promise<Note | undefined> {
  const prev = writeQueues.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const n = await getNote(id);
    if (!n) return undefined;
    const out = fn(n) ?? n;
    out.updatedAt = Date.now();
    await putNote(out);
    return out;
  });
  writeQueues.set(id, next.catch(() => {}));
  return next;
}

export async function deleteNote(id: string) {
  const d = await db();
  const note = await d.get("notes", id);
  const slides = await d.getAllFromIndex("slides", "byNote", id);
  const tx = d.transaction(["notes", "slides", "blobs"], "readwrite");
  for (const s of slides) {
    tx.objectStore("slides").delete(s.id);
    tx.objectStore("blobs").delete(s.blobKey);
  }
  for (const a of note?.audio ?? []) tx.objectStore("blobs").delete(a.blobKey);
  tx.objectStore("notes").delete(id);
  await tx.done;
  emit("notes");
  emit(`note:${id}`);
  emit(`slides:${id}`);
}

export async function putBlob(key: string, blob: Blob) {
  await (await db()).put("blobs", blob, key);
}

export async function getBlob(key: string) {
  return (await db()).get("blobs", key);
}

export async function listSlides(noteId: string) {
  const all = await (await db()).getAllFromIndex("slides", "byNote", noteId);
  return all.sort((a, b) => a.t - b.t);
}

export async function getSlide(id: string) {
  return (await db()).get("slides", id);
}

export async function putSlide(slide: Slide, blob?: Blob) {
  const d = await db();
  if (blob) await d.put("blobs", blob, slide.blobKey);
  await d.put("slides", slide);
  emit(`slides:${slide.noteId}`);
}

export async function deleteSlide(slide: Slide) {
  const d = await db();
  await d.delete("slides", slide.id);
  await d.delete("blobs", slide.blobKey);
  emit(`slides:${slide.noteId}`);
}

export async function appendChunk(session: string, seq: number, blob: Blob) {
  await (await db()).put("chunks", { session, seq, blob });
}

export async function takeChunks(session: string, mime: string): Promise<Blob | null> {
  const d = await db();
  const rows = await d.getAllFromIndex("chunks", "bySession", session);
  if (!rows.length) return null;
  rows.sort((a, b) => a.seq - b.seq);
  const blob = new Blob(rows.map((r) => r.blob), { type: mime });
  const tx = d.transaction("chunks", "readwrite");
  for (const r of rows) tx.store.delete([r.session, r.seq]);
  await tx.done;
  return blob;
}

export async function orphanChunkSessions(): Promise<string[]> {
  const keys = await (await db()).getAllKeys("chunks");
  return [...new Set(keys.map((k) => k[0]))];
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown) {
  await (await db()).put("kv", value, key);
  emit(`kv:${key}`);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}
