import type { Segment } from "./types";

/** A pause this long between sentences usually means a new thought or a new speaker. */
const PAUSE_SEC = 1.5;
/** Past this length a paragraph breaks at the next sentence end. */
const SOFT_MAX_SEC = 40;
/** And past this length it breaks regardless, so one mic recording a whole room never becomes one wall of text. */
const HARD_MAX_SEC = 90;

const endsSentence = (t: string) => /[.!?…]["')\]]?\s*$/.test(t);

/** Groups transcript segments into readable paragraphs: by speaker, at pauses, and at sentence ends once long. */
export function paragraphs<T extends Segment>(segments: T[], speakerOf: (s: T) => string): { speaker: string; items: T[] }[] {
  const out: { speaker: string; items: T[] }[] = [];
  for (const s of segments) {
    const last = out.at(-1);
    const prev = last?.items.at(-1);
    const speaker = speakerOf(s);
    if (last && prev && last.speaker === speaker) {
      const length = s.start - last.items[0].start;
      const pause = s.start - prev.end;
      const split = pause >= PAUSE_SEC || length >= HARD_MAX_SEC || (length >= SOFT_MAX_SEC && endsSentence(prev.text));
      if (!split) {
        last.items.push(s);
        continue;
      }
    }
    out.push({ speaker, items: [s] });
  }
  return out;
}
