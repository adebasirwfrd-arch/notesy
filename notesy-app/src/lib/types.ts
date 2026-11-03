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
  /** Start of this part within the meeting, for audio re-shared after the screen share ended. */
  offsetMs?: number;
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
  /** Meeting-time spans (seconds) per channel already transcribed, so interrupted work resumes instead of restarting. */
  transcriptCoverage?: Partial<Record<Channel | "mix", [number, number][]>>;
  /** False while transcription is partial; undefined on notes from before coverage existed. */
  transcriptComplete?: boolean;
  speakerNames: Record<string, string>;
  audio: AudioTrack[];
  chat: ChatMessage[];
  agentId?: string;
  language?: string;
  source?: "screen" | "mic" | "import";
  status: NoteStatus;
  /** What happened to capture during recording (share ended, re-shared, stopped by user). */
  events?: { atMs: number; text: string }[];
  mom?: Mom;
}

/** A signature as a trimmed transparent PNG data URL, either drawn on screen or uploaded. */
export interface Signature {
  kind: "drawn" | "image";
  dataUrl: string;
  width: number;
  height: number;
  signedAt: number;
}

export interface MomAttendee {
  id: string;
  name: string;
  company: string;
  empNo: string;
  title: string;
  signature?: Signature;
  /** Id of the online attendance entry this row came from. */
  source?: string;
}

export interface MomAttendance {
  /** Public id printed in the QR code. */
  id: string;
  /** Organizer secret that reads the submissions; stays on this device. */
  key: string;
  createdAt: number;
}

export interface MomItem {
  id: string;
  description: string;
  pic: string;
  status: string;
}

/** Minutes of meeting in the company "Meeting Roster" format. */
export interface Mom {
  date: string;
  time: string;
  location: string;
  facilitator: string;
  attendees: MomAttendee[];
  items: MomItem[];
  /** Set once the user edits the key points, so the AI never overwrites them. */
  itemsEdited?: boolean;
  itemsGeneratedAt?: number;
  preparedBy: { name: string; position: string; signature?: Signature };
  /** Slides shown as evidence; undefined means pick automatically. */
  evidenceSlideIds?: string[];
  /** Attendees must sign on the attendance form; undefined means yes. */
  needSignature?: boolean;
  attendance?: MomAttendance;
  /** Online sign-ins the user removed from the roster, so syncing does not bring them back. */
  dismissedEntries?: string[];
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
  /** Transcribe on the device while recording, instead of only after the meeting. */
  liveTranscribe: boolean;
  /** Groq Whisper through the Notesy server: never, when the device falls behind or after the meeting, or always. */
  sttCloud: "off" | "auto" | "always";
  /** Passcode for the Notesy server; empty reuses the AI passcode. */
  cloudPasscode: string;
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
