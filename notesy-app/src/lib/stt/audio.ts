import { hasWebmHeader, indexWebm, repairHeaderlessWebm } from "./webm";

export const SAMPLE_RATE = 16000;

async function decode(buf: ArrayBuffer): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const audio = await ctx.decodeAudioData(buf);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0).slice();
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i] / audio.numberOfChannels;
    }
    return out;
  } finally {
    ctx.close().catch(() => {});
  }
}

/**
 * Decodes to 16 kHz mono. `startSec` is non-zero when the recording lost its first chunk and was rebuilt from a later
 * cluster: the audio then begins that far into the track.
 */
export async function decodeToMono16k(blob: Blob): Promise<{ pcm: Float32Array; startSec: number }> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!hasWebmHeader(bytes)) {
    const repaired = repairHeaderlessWebm(bytes);
    if (repaired) return { pcm: await decode(repaired.bytes.buffer as ArrayBuffer), startSec: repaired.startSec };
  }
  return { pcm: await decode(buf), startSec: 0 };
}

export interface Piece {
  pcm: Float32Array;
  /** Position of the first sample within the track. */
  startSec: number;
  /** Where the next piece starts, so callers can account for the whole span even when decoding drops a few samples. */
  endSec: number;
  /** Overall track progress (0–1) at a sample position within this piece. */
  fraction: (at: number, from?: number, to?: number) => number;
}

/**
 * Decodes a track a few minutes at a time, cut at WebM clusters, so day-long recordings never sit in memory as one
 * multi-gigabyte buffer. `skip` drops pieces (by track seconds) that need no work. Other containers decode in one go.
 */
export async function* decodePieces(blob: Blob, pieceSec = 300, skip?: (startSec: number, endSec: number) => boolean): AsyncGenerator<Piece> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const index = blob.type.includes("mp4") ? null : indexWebm(bytes);
  if (!index) {
    const pcm = await decode(bytes.buffer as ArrayBuffer);
    yield { pcm, startSec: 0, endSec: pcm.length / SAMPLE_RATE, fraction: (at, from = 0, to = pcm.length) => (from + at * (to - from)) / pcm.length };
    return;
  }
  const { header, clusters } = index;
  let i = 0;
  while (i < clusters.length) {
    let j = i + 1;
    while (j < clusters.length && clusters[j].sec - clusters[i].sec < pieceSec) j++;
    const startSec = clusters[i].sec;
    const to = j < clusters.length ? clusters[j].pos : bytes.length;
    const from = clusters[i].pos;
    i = j;
    const nextSec = j < clusters.length ? clusters[j].sec : Infinity;
    if (skip?.(startSec, Number.isFinite(nextSec) ? nextSec : startSec + pieceSec * 2)) continue;
    const buf = new Uint8Array(header.length + to - from);
    buf.set(header, 0);
    buf.set(bytes.subarray(from, to), header.length);
    const pcm = await decode(buf.buffer);
    const p0 = from / bytes.length;
    const p1 = to / bytes.length;
    yield {
      pcm,
      startSec,
      endSec: Number.isFinite(nextSec) ? nextSec : startSec + pcm.length / SAMPLE_RATE,
      fraction: (at, s0 = 0, s1 = pcm.length) => p0 + ((p1 - p0) * (s0 + at * (s1 - s0))) / Math.max(1, pcm.length),
    };
  }
}

export interface Window {
  start: number;
  end: number;
}

const FRAME = 480;

function frameRms(a: Float32Array, from: number) {
  let s = 0;
  const to = Math.min(a.length, from + FRAME);
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peakRms(audio: Float32Array) {
  let peak = 0;
  for (let i = 0; i < audio.length; i += FRAME * 4) peak = Math.max(peak, frameRms(audio, i));
  return peak;
}

/** The quietest point in the last 4 s before `end`, where cutting is least likely to split a word. */
export function quietCut(audio: Float32Array, end: number) {
  const search = 4 * SAMPLE_RATE;
  let best = end;
  let bestRms = Infinity;
  for (let i = Math.max(0, end - search); i < end; i += FRAME) {
    const r = frameRms(audio, i);
    if (r < bestRms) {
      bestRms = r;
      best = i + FRAME / 2;
    }
  }
  return Math.floor(best);
}

/** Whether enough of the range carries speech energy, relative to the loudest speech heard so far. */
export function hasSpeech(audio: Float32Array, start: number, end: number, peak: number) {
  const voiced = Math.max(0.006, peak * 0.08);
  let active = 0;
  let frames = 0;
  for (let i = start; i < end; i += FRAME) {
    frames++;
    if (frameRms(audio, i) > voiced) active++;
  }
  return frames > 0 && active / frames > 0.04;
}

/** Splits audio into ≤maxSec windows cut at the quietest point, dropping windows with no speech energy. */
export function speechWindows(audio: Float32Array, maxSec = 28): Window[] {
  const max = maxSec * SAMPLE_RATE;
  const windows: Window[] = [];
  const peak = peakRms(audio);
  let pos = 0;
  while (pos < audio.length) {
    let end = Math.min(audio.length, pos + max);
    if (end < audio.length) end = Math.max(pos + FRAME, quietCut(audio, end));
    if (hasSpeech(audio, pos, end, peak)) windows.push({ start: pos, end });
    pos = end;
  }
  return windows;
}
