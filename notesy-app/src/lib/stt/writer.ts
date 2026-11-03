import { updateNote } from "../db";
import type { Segment } from "../types";
import { addRange } from "./coverage";
import type { CoverageKey } from "./index";

/**
 * Batches transcript windows into note writes every few seconds, so a crash or closed tab loses at most that much
 * work and long meetings don't rewrite the whole note for every window.
 */
export class TranscriptWriter {
  private segments: Segment[] = [];
  private covered: [CoverageKey, number, number][] = [];
  private language: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly noteId: string,
    private readonly intervalMs = 4000,
  ) {}

  add(key: CoverageKey, segments: Segment[], range: [number, number]) {
    this.segments.push(...segments);
    this.covered.push([key, range[0], range[1]]);
    this.schedule();
  }

  setLanguage(language: string) {
    if (language === this.language) return;
    this.language = language;
    this.schedule();
  }

  private schedule() {
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.intervalMs);
  }

  flush(): Promise<unknown> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const segments = this.segments;
    const covered = this.covered;
    const language = this.language;
    this.segments = [];
    this.covered = [];
    if (!segments.length && !covered.length && !language) return this.writing;
    this.writing = this.writing.then(() =>
      updateNote(this.noteId, (n) => {
        if (segments.length) n.transcript = [...n.transcript, ...segments].sort((a, b) => a.start - b.start);
        const cov = { ...(n.transcriptCoverage ?? {}) };
        for (const [key, a, b] of covered) cov[key] = addRange(cov[key], a, b);
        n.transcriptCoverage = cov;
        if (language) n.language = language;
      }).catch((e) => console.warn("saving transcript failed", e)),
    );
    return this.writing;
  }
}
