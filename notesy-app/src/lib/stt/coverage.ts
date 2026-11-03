/** Sorted, non-overlapping [start, end] spans in meeting seconds. */
export type Ranges = [number, number][];

/** Gaps shorter than this are treated as covered: windows are cut at pauses, so they rarely line up to the sample. */
const SLACK = 1;

export function addRange(ranges: Ranges | undefined, start: number, end: number): Ranges {
  if (!(end > start)) return ranges ?? [];
  const out: Ranges = [];
  let cur: [number, number] = [start, end];
  for (const r of ranges ?? []) {
    if (r[1] + SLACK < cur[0]) out.push(r);
    else if (cur[1] + SLACK < r[0]) {
      out.push(cur);
      cur = r;
    } else cur = [Math.min(cur[0], r[0]), Math.max(cur[1], r[1])];
  }
  out.push(cur);
  return out;
}

/** The parts of [start, end] that no range covers. */
export function uncovered(ranges: Ranges | undefined, start: number, end: number): Ranges {
  const out: Ranges = [];
  let pos = start;
  for (const [a, b] of ranges ?? []) {
    if (b <= pos) continue;
    if (a >= end) break;
    if (a - pos > SLACK) out.push([pos, a]);
    pos = Math.max(pos, b);
  }
  if (end - pos > SLACK) out.push([pos, end]);
  return out;
}

export const isCovered = (ranges: Ranges | undefined, t: number) => (ranges ?? []).some(([a, b]) => t >= a && t <= b);
