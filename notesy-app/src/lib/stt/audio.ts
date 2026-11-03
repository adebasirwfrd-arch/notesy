export const SAMPLE_RATE = 16000;

export async function decodeToMono16k(blob: Blob): Promise<Float32Array> {
  const buf = await blob.arrayBuffer();
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

/** Splits audio into ≤28 s windows cut at the quietest point, dropping windows with no speech energy. */
export function speechWindows(audio: Float32Array, maxSec = 28): Window[] {
  const max = maxSec * SAMPLE_RATE;
  const search = 4 * SAMPLE_RATE;
  const windows: Window[] = [];
  let peak = 0;
  for (let i = 0; i < audio.length; i += FRAME * 4) peak = Math.max(peak, frameRms(audio, i));
  const voiced = Math.max(0.006, peak * 0.08);

  let pos = 0;
  while (pos < audio.length) {
    let end = Math.min(audio.length, pos + max);
    if (end < audio.length) {
      let best = end;
      let bestRms = Infinity;
      for (let i = end - search; i < end; i += FRAME) {
        const r = frameRms(audio, i);
        if (r < bestRms) {
          bestRms = r;
          best = i + FRAME / 2;
        }
      }
      end = Math.floor(best);
    }
    let active = 0;
    let frames = 0;
    for (let i = pos; i < end; i += FRAME) {
      frames++;
      if (frameRms(audio, i) > voiced) active++;
    }
    if (frames && active / frames > 0.04) windows.push({ start: pos, end });
    pos = end;
  }
  return windows;
}
