import { useSyncExternalStore } from "react";
import { kvGet, kvSet, subscribe } from "./db";
import type { DictionaryEntry, Settings, Template } from "./types";
import { BUILTIN_TEMPLATES } from "./templates";

export const DEFAULT_SETTINGS: Settings = {
  displayName: "",
  uiLanguage: "id",
  summaryLanguage: "Bahasa Indonesia",
  meLabel: "Saya",
  othersLabel: "Peserta",

  autoSummarize: true,
  autoTitle: true,
  defaultTemplateId: "auto",

  micDeviceId: "",
  echoCancellation: true,
  captureSlides: true,
  slideIntervalMs: 1500,
  slideSensitivity: 0.5,
  maxSlidesInSummary: 12,

  sttEngine: "browser",
  sttLanguage: "auto",
  whisperModel: "onnx-community/whisper-small",
  whisperDevice: "auto",
  liveTranscribe: true,
  sttCloud: "auto",
  cloudPasscode: "",
  sttApiBase: "https://api.groq.com/openai/v1",
  sttApiKey: "",
  sttApiModel: "whisper-large-v3",

  aiProvider: "cursor",
  cursorApiKey: "",
  cursorModel: "",
  describeSlides: true,
  openaiBase: "https://api.openai.com/v1",
  openaiKey: "",
  openaiModel: "gpt-4o-mini",
  extraInstructions: "",
};

function createKvStore<T>(key: string, fallback: T, normalize: (v: T | undefined) => T = (v) => v ?? fallback) {
  let value = fallback;
  let loaded = false;
  const ready = kvGet<T>(key).then((v) => {
    value = normalize(v);
    loaded = true;
    notify();
  });
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((f) => f());
  subscribe(`kv:${key}`, () => {
    kvGet<T>(key).then((v) => {
      value = normalize(v);
      notify();
    });
  });
  return {
    ready,
    get: () => value,
    isLoaded: () => loaded,
    async set(next: T) {
      value = next;
      notify();
      await kvSet(key, next);
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Local dev only: `VITE_DEV_CURSOR_KEY` fills an empty Cursor key so a fresh localhost profile can summarize right away. */
const devCursorKey = import.meta.env.DEV ? ((import.meta.env.VITE_DEV_CURSOR_KEY as string | undefined) ?? "") : "";

export const settingsStore = createKvStore<Settings>("settings", DEFAULT_SETTINGS, (v) => {
  const s = { ...DEFAULT_SETTINGS, ...(v ?? {}) };
  return devCursorKey && !s.cursorApiKey ? { ...s, aiProvider: "cursor", cursorApiKey: devCursorKey } : s;
});
export const templatesStore = createKvStore<Template[]>("templates", []);
export const dictionaryStore = createKvStore<DictionaryEntry[]>("dictionary", []);

export const getSettings = () => settingsStore.get();

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const s = useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
  return [s, (patch) => void settingsStore.set({ ...settingsStore.get(), ...patch })];
}

export function allTemplates(custom = templatesStore.get()): Template[] {
  return [...BUILTIN_TEMPLATES, ...custom];
}

export function useTemplates() {
  const custom = useSyncExternalStore(templatesStore.subscribe, templatesStore.get);
  return { custom, all: allTemplates(custom), save: (t: Template[]) => templatesStore.set(t) };
}

export function useDictionary(): [DictionaryEntry[], (d: DictionaryEntry[]) => void] {
  const d = useSyncExternalStore(dictionaryStore.subscribe, dictionaryStore.get);
  return [d, (next) => void dictionaryStore.set(next)];
}

export const storesReady = Promise.all([settingsStore.ready, templatesStore.ready, dictionaryStore.ready]);
