import { updateNote } from "./db";
import { isExtension } from "./platform";
import type { Segment, SpeakerSpan } from "./types";

/** How Meet and Teams caption the local user. */
const SELF = /^(you|anda|kamu)$/i;
const STALE_MS = 3000;
const SAVE_EVERY_MS = 10000;

type Listener = (names: string[], lagMs: number) => void;

let extensionSeen = false;
export const extensionConnected = () => extensionSeen || isExtension;

function subscribe(f: Listener) {
  const onWindow = (e: MessageEvent) => {
    if (e.source !== window || e.data?.from !== "notesy-extension") return;
    extensionSeen = true;
    if (e.data.notesy === "speaking") f(e.data.names ?? [], e.data.lagMs ?? 0);
  };
  window.addEventListener("message", onWindow);
  window.postMessage({ notesy: "ping" }, location.origin);
  const onExt = (m: { type?: string; names?: string[]; lagMs?: number }) => {
    if (m?.type === "notesy-speaking") f(m.names ?? [], m.lagMs ?? 0);
  };
  if (isExtension && typeof chrome !== "undefined") chrome.runtime?.onMessage?.addListener(onExt);
  return () => {
    window.removeEventListener("message", onWindow);
    if (isExtension && typeof chrome !== "undefined") chrome.runtime?.onMessage?.removeListener(onExt);
  };
}

/** Records who Meet/Teams says is speaking, in meeting time, while Notesy records. */
export class SpeakerTracker {
  private readonly open = new Map<string, number>();
  private readonly spans: SpeakerSpan[] = [];
  private lastMessage = 0;
  private lastSave = 0;
  private savedCount = 0;
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly noteId: string,
    private readonly clock: () => number,
  ) {
    this.unsubscribe = subscribe((names, lag) => this.update(names, lag));
    this.timer = setInterval(() => {
      if (this.open.size && Date.now() - this.lastMessage > STALE_MS) this.update([], 0);
      if (Date.now() - this.lastSave > SAVE_EVERY_MS) void this.save();
    }, 1000);
  }

  private update(names: string[], lagMs: number) {
    this.lastMessage = Date.now();
    const now = Math.max(0, this.clock() - lagMs);
    for (const [name, start] of this.open) {
      if (names.includes(name)) continue;
      if (now - start >= 300) this.spans.push({ startMs: start, endMs: now, name });
      this.open.delete(name);
    }
    for (const name of names) if (!this.open.has(name)) this.open.set(name, now);
  }

  private async save() {
    this.lastSave = Date.now();
    if (this.spans.length === this.savedCount) return;
    this.savedCount = this.spans.length;
    const spans = [...this.spans];
    await updateNote(this.noteId, (n) => {
      n.speakerTimeline = spans;
    });
  }

  async finish() {
    this.update([], 0);
    clearInterval(this.timer);
    this.unsubscribe();
    await this.save();
  }
}

/** Gives segments the Meet/Teams name of whoever spoke most during them. Mic lines stay with the local user. */
export function assignSpeakers(segments: Segment[], timeline: SpeakerSpan[] | undefined, meLabel: string): Segment[] {
  if (!timeline?.length) return segments;
  const spans = [...timeline].sort((a, b) => a.startMs - b.startMs);
  const maxLen = Math.max(...spans.map((s) => s.endMs - s.startMs));
  return segments.map((seg) => {
    if (seg.channel === "mic") return seg;
    const a = seg.start * 1000;
    const b = seg.end * 1000;
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid].startMs < b) lo = mid + 1;
      else hi = mid;
    }
    const score = new Map<string, number>();
    for (let i = lo - 1; i >= 0 && spans[i].startMs > a - maxLen; i--) {
      const t = spans[i];
      const overlap = Math.min(b, t.endMs) - Math.max(a, t.startMs);
      if (overlap > 0) score.set(t.name, (score.get(t.name) ?? 0) + overlap);
    }
    let best = "";
    let bestOverlap = 0;
    for (const [name, overlap] of score) {
      // The meeting tab's audio never contains the local user's own voice.
      if (seg.channel === "system" && SELF.test(name)) continue;
      if (overlap > bestOverlap) [best, bestOverlap] = [name, overlap];
    }
    if (!best || bestOverlap < Math.min(400, (b - a) * 0.2)) return seg;
    return { ...seg, speaker: SELF.test(best) ? meLabel : best };
  });
}
