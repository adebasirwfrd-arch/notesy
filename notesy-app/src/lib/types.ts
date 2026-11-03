export type Channel = "mic" | "system";

export interface Segment {
  id: string;
  channel: Channel;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface SummaryDoc {
  id: string;
  templateId: string;
  title: string;
  markdown: string;
  createdAt: number;
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  error?: boolean;
}

export interface AudioTrack {
  channel: Channel | "mix";
  blobKey: string;
  mime: string;
  bytes: number;
}

export type NoteStatus =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "transcribing"; progress: number; detail?: string }
  | { kind: "describing"; progress: number; detail?: string }
  | { kind: "summarizing"; detail?: string }
  | { kind: "error"; message: string };

export interface Note {
  id: string;
  title: string;
  titleIsAuto: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  durationMs: number;
  memo: string;
  summaries: SummaryDoc[];
  activeSummaryId?: string;
  transcript: Segment[];
  speakerNames: Record<string, string>;
  audio: AudioTrack[];
  chat: ChatMessage[];
  agentId?: string;
  language?: string;
  source?: "screen" | "mic" | "import";
  status: NoteStatus;
}

export interface Slide {
  id: string;
  noteId: string;
  t: number;
  blobKey: string;
  width: number;
  height: number;
  auto: boolean;
  caption?: string;
  description?: string;
  excluded?: boolean;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  sections: { title: string; hint: string }[];
  builtin?: boolean;
}

export interface DictionaryEntry {
  id: string;
  term: string;
  aliases: string[];
}

export type SttEngine = "browser" | "api";
export type AiProvider = "cursor" | "openai";

export interface Settings {
  displayName: string;
  uiLanguage: "id" | "en";
  summaryLanguage: string;
  meLabel: string;
  othersLabel: string;

  autoSummarize: boolean;
  autoTitle: boolean;
  defaultTemplateId: string;

  micDeviceId: string;
  echoCancellation: boolean;
  captureSlides: boolean;
  slideIntervalMs: number;
  slideSensitivity: number;
  maxSlidesInSummary: number;

  sttEngine: SttEngine;
  sttLanguage: string;
  whisperModel: string;
  whisperDevice: "auto" | "webgpu" | "wasm";
  sttApiBase: string;
  sttApiKey: string;
  sttApiModel: string;

  aiProvider: AiProvider;
  cursorApiKey: string;
  cursorModel: string;
  describeSlides: boolean;
  openaiBase: string;
  openaiKey: string;
  openaiModel: string;
  extraInstructions: string;
}
