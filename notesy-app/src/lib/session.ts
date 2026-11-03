import { useSyncExternalStore } from "react";
import { deleteNote, getNote, listNotes, orphanChunkSessions, putBlob, putNote, updateNote } from "./db";
import { MeetingRecorder, finalizeTracks, parseSessionKey, pickMime, type CaptureMode, type Levels } from "./recorder";
import { SlideWatcher, encodeFrame, saveSlide } from "./slides";
import { dictionaryStore, getSettings } from "./settings";
import { dropEcho, transcribeTracks } from "./stt";
import { LiveTranscriber } from "./stt/live";
import { TranscriptWriter } from "./stt/writer";
import { aiConfigured, describeSlides, generateMomItems, generateSummary } from "./ai";
import type { Channel, Note, NoteStatus } from "./types";
import { errorMessage, formatDate, formatTime, uid } from "./util";

export interface LiveSession {
  noteId: string;
  mode: CaptureMode;
  state: "starting" | "recording" | "paused" | "stopping";
  warnings: string[];
  slideCount: number;
  hasSystemAudio: boolean;
  hasMic: boolean;
  micMuted: boolean;
  autoSlides: boolean;
  /** The browser ended the screen share while audio kept recording. */
  screenLost: boolean;
}

let live: LiveSession | null = null;
let recorder: MeetingRecorder | null = null;
let watcher: SlideWatcher | null = null;
let liveStt: LiveTranscriber | null = null;
/** Live transcribers still finishing queued speech after their recording stopped. */
const liveDrains = new Map<string, { stt: LiveTranscriber; done: Promise<void> }>();
const subs = new Set<() => void>();
const set = (next: LiveSession | null) => {
  live = next;
  subs.forEach((f) => f());
};
const patch = (p: Partial<LiveSession>) => live && set({ ...live, ...p });

/**
 * Held by the tab that is recording, for as long as it records. Other Notesy tabs (a second window, or an idle tab
 * that reloaded for an update) see it and leave the live chunk journal alone instead of "recovering" it.
 */
const LOCK_PREFIX = "notesy-recording:";
let releaseRecordingLock: (() => void) | null = null;

function holdRecordingLock(noteId: string) {
  if (!navigator.locks) return;
  void navigator.locks.request(LOCK_PREFIX + noteId, () => new Promise<void>((resolve) => (releaseRecordingLock = resolve)));
}

function dropRecordingLock() {
  releaseRecordingLock?.();
  releaseRecordingLock = null;
}

async function notesRecordingElsewhere() {
  if (!navigator.locks) return new Set<string>();
  const { held = [] } = await navigator.locks.query();
  return new Set(held.map((l) => l.name ?? "").filter((n) => n.startsWith(LOCK_PREFIX)).map((n) => n.slice(LOCK_PREFIX.length)));
}

export const useLiveSession = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => live,
  );

export const getElapsed = () => recorder?.elapsed() ?? 0;
export const getLevels = (): Levels => recorder?.levels() ?? { mic: 0, system: 0 };
export const getDisplayStream = () => recorder?.display ?? null;

export function newNote(partial: Partial<Note> = {}): Note {
  const now = Date.now();
  return {
    id: uid("n_"),
    title: `Rapat ${formatDate(now)} ${formatTime(now)}`,
    titleIsAuto: true,
    createdAt: now,
    updatedAt: now,
    durationMs: 0,
    memo: "",
    summaries: [],
    transcript: [],
    speakerNames: {},
    audio: [],
    chat: [],
    status: { kind: "idle" },
    ...partial,
  };
}

export async function createEmptyNote() {
  const note = newNote();
  await putNote(note);
  return note;
}

export async function startRecording(mode: CaptureMode, existingNoteId?: string): Promise<string> {
  if (live) throw new Error("Rekaman lain masih berjalan.");
  const s = getSettings();
  let note = existingNoteId ? await getNote(existingNoteId) : undefined;
  if (note && note.audio.length) note = undefined;
  if (!note) {
    note = newNote({ source: mode });
    await putNote(note);
  }
  const noteId = note.id;
  holdRecordingLock(noteId);
  set({
    noteId,
    mode,
    state: "starting",
    warnings: [],
    slideCount: 0,
    hasMic: false,
    hasSystemAudio: false,
    micMuted: false,
    autoSlides: s.captureSlides,
    screenLost: false,
  });
  const rec = new MeetingRecorder({ noteId, mode, micDeviceId: s.micDeviceId, echoCancellation: s.echoCancellation });
  try {
    await rec.start();
  } catch (e) {
    set(null);
    dropRecordingLock();
    if (!existingNoteId) {
      const n = await getNote(noteId);
      if (n && !n.memo && !n.audio.length) await deleteNote(noteId);
    }
    if (e instanceof DOMException && e.name === "NotAllowedError") throw new Error("Izin ditolak. Pilih layar/izinkan mikrofon untuk mulai merekam.");
    throw e;
  }
  recorder = rec;
  rec.onScreenEnded = (surface) => void onScreenEnded(surface);
  rec.onSystemAudioLost = () => {
    logEvent("Audio peserta terputus (perangkat audio berganti)");
    raiseAlert(AUDIO_LOST);
    patch({ hasSystemAudio: false });
  };
  rec.onMicLost = () => {
    logEvent("Mikrofon terputus, menyambung ulang otomatis");
    patch({ hasMic: false, warnings: addWarning(MIC_LOST) });
  };
  rec.onMicRestored = () => {
    logEvent("Mikrofon tersambung lagi");
    patch({ hasMic: true, micMuted: false, warnings: (live?.warnings ?? []).filter((w) => w !== MIC_LOST) });
  };
  if (mode === "screen" && "Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {});
  const startedAt = Date.now();
  await updateNote(noteId, (n) => {
    n.status = { kind: "recording" };
    n.startedAt = startedAt;
    n.source = mode;
    n.audio = [];
    n.events = [];
    n.transcript = [];
    n.transcriptCoverage = {};
    n.transcriptComplete = false;
  });
  startLiveTranscription(noteId, rec);
  startWatcher();
  set({
    ...live!,
    state: "recording",
    warnings: rec.warnings,
    hasMic: rec.hasMic,
    hasSystemAudio: rec.hasSystemAudio,
  });
  window.addEventListener("beforeunload", warnUnload);
  if (mode === "mic") wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
  return noteId;
}

function startLiveTranscription(noteId: string, rec: MeetingRecorder) {
  const s = getSettings();
  if (s.sttEngine !== "browser" || !s.liveTranscribe) return;
  const stt = new LiveTranscriber(noteId, s, () => rec.elapsed(), (ch) => (ch === "mic" ? s.meLabel : s.othersLabel), dictionaryStore.get());
  liveStt = stt;
  rec.onAudioAttached = (ch, stream) => void stt.attach(ch, stream);
  rec.onAudioDetached = (ch) => stt.detach(ch);
  for (const { channel, stream } of rec.audioStreams()) void stt.attach(channel, stream);
}

function startWatcher() {
  const rec = recorder;
  if (!rec?.videoTrack || !live) return;
  const s = getSettings();
  watcher = new SlideWatcher({
    noteId: live.noteId,
    track: rec.videoTrack,
    clock: () => rec.elapsed(),
    intervalMs: s.slideIntervalMs,
    sensitivity: s.slideSensitivity,
    auto: live.autoSlides,
    onSlide: () => patch({ slideCount: (live?.slideCount ?? 0) + 1 }),
  });
  if (live.state === "paused") watcher.paused = true;
  watcher.start();
}

function logEvent(text: string) {
  if (!live || !recorder) return;
  const atMs = recorder.elapsed();
  void updateNote(live.noteId, (n) => {
    n.events = [...(n.events ?? []), { atMs, text }];
  });
}

const SURFACE_NAME: Record<string, string> = { browser: "tab", window: "jendela", monitor: "layar" };
export const SCREEN_LOST =
  "Berbagi layar berhenti, tetapi rekaman tetap berjalan. Klik “Bagikan ulang” agar audio peserta dan slide terekam lagi.";
export const AUDIO_LOST =
  "Audio peserta terputus (perangkat audio berganti, misalnya karena panggilan masuk). Rekaman tetap berjalan. Klik “Bagikan ulang” untuk menyambungkannya lagi.";
const MIC_LOST = "Mikrofon terputus. Notesy menyambungkannya lagi secara otomatis.";
const ALERTS = [SCREEN_LOST, AUDIO_LOST];

const addWarning = (w: string) => [...(live?.warnings ?? []).filter((x) => x !== w), w];

function raiseAlert(text: string) {
  if (!live) return;
  patch({ screenLost: true, warnings: [...live.warnings.filter((w) => !ALERTS.includes(w)), text] });
  notifyScreenLost();
}

/** Chrome ends the share when the shared tab/window closes or reloads, Zoom swaps windows, or “Stop sharing” is clicked. */
async function onScreenEnded(surface: string | undefined) {
  watcher?.stop();
  watcher = null;
  if (!live || !recorder) return;
  logEvent(`Berbagi ${SURFACE_NAME[surface ?? ""] ?? "layar"} diakhiri oleh browser`);
  raiseAlert(SCREEN_LOST);
  patch({ hasSystemAudio: false });
}

function notifyScreenLost() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio cue is best effort */
  }
  if (document.visibilityState === "hidden" && "Notification" in window && Notification.permission === "granted") {
    new Notification("Notesy: berbagi layar berhenti", { body: "Audio tetap direkam. Buka Notesy dan klik Bagikan ulang.", tag: "notesy-screen" });
  }
}

export async function reshareScreen() {
  if (!recorder || !live) throw new Error("Tidak ada rekaman yang berjalan.");
  await recorder.reshare();
  watcher?.stop();
  startWatcher();
  logEvent("Layar dibagikan ulang");
  patch({
    screenLost: false,
    hasSystemAudio: recorder.hasSystemAudio,
    warnings: live.warnings.filter((w) => !ALERTS.includes(w)),
  });
}

/** Phones suspend the WebView (and its microphone) when the screen turns off. */
let wakeLock: WakeLockSentinel | null | undefined = null;

function warnUnload(e: BeforeUnloadEvent) {
  e.preventDefault();
}

export function pauseRecording() {
  recorder?.pause();
  liveStt?.pause();
  if (watcher) watcher.paused = true;
  patch({ state: "paused" });
}

export function resumeRecording() {
  recorder?.resume();
  liveStt?.resume();
  if (watcher) watcher.paused = false;
  patch({ state: "recording" });
}

export function toggleMic() {
  if (!recorder) return;
  recorder.setMicMuted(!recorder.micMuted);
  patch({ micMuted: recorder.micMuted });
}

export function setAutoSlides(on: boolean) {
  watcher?.setAuto(on);
  patch({ autoSlides: on });
}

export async function captureSlideNow() {
  if (!watcher) throw new Error("Tangkapan layar hanya tersedia saat merekam layar.");
  await watcher.captureNow();
}

export async function stopRecording() {
  if (!live || !recorder || live.state === "stopping") return;
  const { noteId } = live;
  logEvent("Rekaman dihentikan oleh pengguna");
  patch({ state: "stopping" });
  watcher?.stop();
  watcher = null;
  const rec = recorder;
  const { tracks, durationMs } = await rec.stop();
  recorder = null;
  if (liveStt) {
    const stt = liveStt;
    liveStt = null;
    const done = stt.finish().finally(() => liveDrains.delete(noteId));
    liveDrains.set(noteId, { stt, done });
  }
  window.removeEventListener("beforeunload", warnUnload);
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  await updateNote(noteId, (n) => {
    n.audio = [...n.audio.filter((a) => !tracks.some((t) => t.blobKey === a.blobKey)), ...tracks];
    n.durationMs = durationMs;
    n.status = { kind: "idle" };
  });
  dropRecordingLock();
  void processNote(noteId);
  set(null);
}

/** Notes from before resumable transcription have no flag: a transcript there means it finished. */
export const isTranscriptComplete = (n: Note) => n.transcriptComplete ?? n.transcript.length > 0;

const jobs = new Map<string, AbortController>();
export const isProcessing = (noteId: string) => jobs.has(noteId);
const jobDone = new Set<() => void>();
export const hasActiveWork = () => !!live || jobs.size > 0;
export function onActiveWorkChange(f: () => void) {
  subs.add(f);
  jobDone.add(f);
}

export function cancelProcessing(noteId: string) {
  jobs.get(noteId)?.abort();
}

const setStatus = (noteId: string, status: NoteStatus) =>
  updateNote(noteId, (n) => {
    n.status = status;
  });

export interface ProcessOptions {
  transcribe?: boolean;
  /** Throw away the current transcript and start over; by default a partial transcript is resumed. */
  fresh?: boolean;
  summarize?: boolean;
  templateId?: string;
}

export async function processNote(noteId: string, opts: ProcessOptions = {}) {
  if (jobs.has(noteId)) return;
  const s = getSettings();
  const ctrl = new AbortController();
  jobs.set(noteId, ctrl);
  try {
    let note = await getNote(noteId);
    if (!note) return;
    const complete = isTranscriptComplete(note);
    const doTranscribe = opts.transcribe ?? (note.audio.length > 0 && !complete);
    if (doTranscribe && note.audio.length) {
      await setStatus(noteId, { kind: "transcribing", progress: 0, detail: "Menyiapkan transkripsi…" });
      const drain = liveDrains.get(noteId);
      if (drain) {
        const tick = setInterval(() => {
          const left = Math.round(drain.stt.backlogSec);
          void setStatus(noteId, { kind: "transcribing", progress: 0, detail: left ? `Menyelesaikan transkrip live (sisa ${left} detik ucapan)…` : "Menyimpan transkrip live…" });
        }, 1000);
        await Promise.race([
          drain.done,
          new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
        ]).finally(() => clearInterval(tick));
      }
      if (opts.fresh ?? complete) {
        await updateNote(noteId, (n) => {
          n.transcript = [];
          n.transcriptCoverage = {};
          n.transcriptComplete = false;
        });
      }
      note = (await getNote(noteId))!;
      const writer = new TranscriptWriter(noteId);
      let last = 0;
      try {
        await transcribeTracks({
          audio: note.audio,
          settings: s,
          dictionary: dictionaryStore.get(),
          speakerFor: (ch: Channel) => (ch === "mic" ? s.meLabel : s.othersLabel),
          language: note.language,
          coverage: note.transcriptCoverage ?? {},
          onLanguage: (l) => writer.setLanguage(l),
          onWindow: (key, segments, range) => writer.add(key, segments, range),
          onProgress: (progress, detail) => {
            if (ctrl.signal.aborted) throw new DOMException("aborted", "AbortError");
            if (Date.now() - last < 400 && progress < 1) return;
            last = Date.now();
            void setStatus(noteId, { kind: "transcribing", progress, detail });
          },
        });
      } finally {
        await writer.flush();
      }
      await updateNote(noteId, (n) => {
        n.transcript = dropEcho([...n.transcript].sort((x, y) => x.start - y.start));
        n.transcriptComplete = true;
      });
    }
    note = (await getNote(noteId))!;
    const wantSummary = opts.summarize ?? (s.autoSummarize && note.summaries.length === 0);
    if (wantSummary && aiConfigured(s) && (note.transcript.length || note.memo.trim())) {
      if (s.describeSlides) {
        await setStatus(noteId, { kind: "describing", progress: 0, detail: "AI membaca tangkapan layar…" });
        await describeSlides(noteId, (p) => void setStatus(noteId, { kind: "describing", progress: p, detail: "AI membaca tangkapan layar…" }), ctrl.signal).catch(
          (e) => {
            if (ctrl.signal.aborted) throw e;
            console.warn("describe slides failed", e);
          },
        );
      }
      await setStatus(noteId, { kind: "summarizing", detail: "AI menyusun ringkasan…" });
      await generateSummary(noteId, opts.templateId ?? s.defaultTemplateId, undefined, ctrl.signal);
    }
    note = (await getNote(noteId))!;
    if (opts.summarize !== false && aiConfigured(s) && !note.mom?.itemsEdited && (doTranscribe || !note.mom?.items.length) && (note.transcript.length || note.memo.trim())) {
      await setStatus(noteId, { kind: "summarizing", detail: "AI menyusun poin pembahasan MoM…" });
      await generateMomItems(noteId, ctrl.signal).catch((e) => {
        if (ctrl.signal.aborted) throw e;
        console.warn("MoM key points failed", e);
      });
    }
    await setStatus(noteId, { kind: "idle" });
  } catch (e) {
    const aborted = ctrl.signal.aborted || (e instanceof DOMException && e.name === "AbortError");
    await setStatus(noteId, aborted ? { kind: "idle" } : { kind: "error", message: errorMessage(e) });
  } finally {
    jobs.delete(noteId);
    jobDone.forEach((f) => f());
  }
}

export async function importAudioFile(file: File) {
  const note = newNote({ title: file.name.replace(/\.[^.]+$/, ""), titleIsAuto: true, source: "import" });
  const blobKey = `audio:${note.id}:mix`;
  await putBlob(blobKey, file);
  note.audio = [{ channel: "mix", blobKey, mime: file.type || "audio/webm", bytes: file.size }];
  note.durationMs = await mediaDuration(file);
  await putNote(note);
  void processNote(note.id);
  return note.id;
}

export async function importImages(noteId: string, files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!f.type.startsWith("image/")) continue;
    const bmp = await createImageBitmap(f);
    const { blob, width, height } = await encodeFrame(bmp);
    bmp.close();
    await saveSlide(noteId, getElapsed(), blob, width, height, false);
  }
}

function mediaDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement("audio");
    el.preload = "metadata";
    el.src = URL.createObjectURL(file);
    const done = (v: number) => {
      URL.revokeObjectURL(el.src);
      resolve(Number.isFinite(v) ? v * 1000 : 0);
    };
    el.onloadedmetadata = () => {
      if (el.duration === Infinity) {
        el.currentTime = 1e7;
        el.ontimeupdate = () => done(el.duration);
      } else done(el.duration);
    };
    el.onerror = () => done(0);
  });
}

/** Rebuilds audio for meetings whose tab closed mid-recording, from the chunk journal. */
export async function recoverInterrupted() {
  const sessions = await orphanChunkSessions();
  const notes = await listNotes();
  const mime = pickMime() || "audio/webm";
  const elsewhere = await notesRecordingElsewhere();
  for (const n of notes) {
    if (n.status.kind === "recording" || sessions.some((k) => k.startsWith(`${n.id}:`))) {
      if (live?.noteId === n.id || elsewhere.has(n.id)) continue;
      const parts = sessions.filter((k) => parseSessionKey(k)?.noteId === n.id).map((session) => ({ session, mime }));
      const tracks = await finalizeTracks(parts);
      await updateNote(n.id, (x) => {
        if (tracks.length) x.audio = [...x.audio.filter((a) => !tracks.some((t) => t.blobKey === a.blobKey)), ...tracks];
        x.status = tracks.length
          ? { kind: "error", message: "Rekaman terputus (tab ditutup). Audio yang sempat tersimpan sudah dipulihkan — klik Transkrip ulang." }
          : { kind: "idle" };
      });
    } else if (["transcribing", "describing", "summarizing"].includes(n.status.kind)) {
      await updateNote(n.id, (x) => {
        x.status = { kind: "error", message: "Proses terhenti karena aplikasi ditutup. Klik Proses ulang untuk melanjutkan dari bagian terakhir." };
      });
    }
  }
}
