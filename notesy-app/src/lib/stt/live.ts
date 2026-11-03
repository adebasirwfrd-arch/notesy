import type { Channel, DictionaryEntry, Settings } from "../types";
import { SAMPLE_RATE, hasSpeech, peakRms, quietCut } from "./audio";
import { LanguageTracker, prepareWhisper, toSegments, windowSec } from "./index";
import { TranscriptWriter } from "./writer";
import { assetUrl } from "../platform";

/** Speech waiting for Whisper beyond this is left to the post-meeting pass instead of piling up in memory. */
const MAX_BACKLOG_SEC = 600;
/** Pieces shorter than this at a pause or stop carry no words worth a Whisper call. */
const MIN_WINDOW_SEC = 1;

interface Pending {
  channel: Channel;
  startSec: number;
  pcm: Float32Array;
}

class ChannelTap {
  private parts: Float32Array[] = [];
  private samples = 0;
  private startSec = 0;
  peak = 0;
  constructor(
    readonly channel: Channel,
    readonly nodes: AudioNode[],
  ) {}

  /** Appends a block captured just now; a jump in the clock (pause, re-share, stall) starts a new window. */
  push(block: Float32Array, nowSec: number, emit: (startSec: number, pcm: Float32Array) => void, maxSec: number) {
    const blockStart = nowSec - block.length / SAMPLE_RATE;
    if (this.samples && Math.abs(this.startSec + this.samples / SAMPLE_RATE - blockStart) > 1.5) this.flush(emit);
    if (!this.samples) this.startSec = Math.max(0, blockStart);
    this.parts.push(block);
    this.samples += block.length;
    if (this.samples < (maxSec + 1) * SAMPLE_RATE) return;
    const pcm = this.take();
    const cut = Math.max(SAMPLE_RATE, quietCut(pcm, maxSec * SAMPLE_RATE));
    emit(this.startSec, pcm.slice(0, cut));
    const rest = pcm.slice(cut);
    this.startSec += cut / SAMPLE_RATE;
    this.parts = [rest];
    this.samples = rest.length;
  }

  flush(emit: (startSec: number, pcm: Float32Array) => void) {
    if (this.samples >= MIN_WINDOW_SEC * SAMPLE_RATE) emit(this.startSec, this.take());
    this.parts = [];
    this.samples = 0;
  }

  private take() {
    const out = new Float32Array(this.samples);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/**
 * Transcribes mic and participant audio while the meeting runs, so a day-long meeting is transcribed by the time it
 * ends instead of leaving hours of work for afterwards. What it misses (backlog, crash, model still downloading) is
 * not marked covered and is picked up from the recording by the post-meeting pass.
 */
export class LiveTranscriber {
  private ctx: AudioContext | null = null;
  private module: Promise<void> | null = null;
  private taps = new Map<Channel, ChannelTap>();
  private queue: Pending[] = [];
  private queuedSec = 0;
  private busy: Promise<void> | null = null;
  private paused = false;
  private stopped = false;
  private broken = false;
  private readonly lang: LanguageTracker;
  private readonly writer: TranscriptWriter;
  private readonly model: Promise<unknown>;

  constructor(
    noteId: string,
    private readonly settings: Settings,
    private readonly clockMs: () => number,
    private readonly speakerFor: (ch: Channel) => string,
    private readonly dictionary: DictionaryEntry[],
  ) {
    this.lang = LanguageTracker.for(settings);
    this.writer = new TranscriptWriter(noteId);
    this.model = prepareWhisper(settings).catch((e) => {
      console.warn("live transcription unavailable", e);
      this.broken = true;
    });
  }

  private context() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.module = this.ctx.audioWorklet.addModule(assetUrl("tap-worklet.js"));
      this.ctx.onstatechange = () => {
        if (this.ctx && this.ctx.state === "suspended" && !this.stopped) void this.ctx.resume().catch(() => {});
      };
    }
    return this.ctx;
  }

  async attach(channel: Channel, stream: MediaStream) {
    if (this.stopped || !stream.getAudioTracks().length) return;
    this.detach(channel);
    try {
      const ctx = this.context();
      await this.module;
      if (this.stopped) return;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "notesy-tap");
      const mute = ctx.createGain();
      mute.gain.value = 0;
      src.connect(node).connect(mute).connect(ctx.destination);
      const tap = new ChannelTap(channel, [src, node, mute]);
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (this.paused || this.stopped || this.taps.get(channel) !== tap) return;
        tap.push(e.data, this.clockMs() / 1000, (start, pcm) => this.enqueue(tap, start, pcm), windowSec(this.settings));
      };
      this.taps.set(channel, tap);
    } catch (e) {
      console.warn("live transcription cannot tap audio", e);
    }
  }

  detach(channel: Channel) {
    const tap = this.taps.get(channel);
    if (!tap) return;
    this.taps.delete(channel);
    tap.flush((start, pcm) => this.enqueue(tap, start, pcm));
    tap.nodes.forEach((n) => n.disconnect());
  }

  pause() {
    this.paused = true;
    this.taps.forEach((tap) => tap.flush((start, pcm) => this.enqueue(tap, start, pcm)));
  }

  resume() {
    this.paused = false;
  }

  /** Seconds of speech still waiting for Whisper. */
  get backlogSec() {
    return this.queuedSec;
  }

  private enqueue(tap: ChannelTap, startSec: number, pcm: Float32Array) {
    const endSec = startSec + pcm.length / SAMPLE_RATE;
    tap.peak = Math.max(tap.peak, peakRms(pcm));
    if (!hasSpeech(pcm, 0, pcm.length, tap.peak)) {
      this.writer.add(tap.channel, [], [startSec, endSec]);
      return;
    }
    if (this.broken || this.queuedSec > MAX_BACKLOG_SEC) return;
    this.queue.push({ channel: tap.channel, startSec, pcm });
    this.queuedSec += pcm.length / SAMPLE_RATE;
    if (!this.busy) this.busy = this.work().finally(() => (this.busy = null));
  }

  private async work() {
    await this.model;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      this.queuedSec -= item.pcm.length / SAMPLE_RATE;
      if (this.broken) continue;
      try {
        const chunks = await this.lang.transcribe(item.pcm);
        if (this.lang.main) this.writer.setLanguage(this.lang.main);
        const segments = toSegments(chunks, item.startSec, item.channel, this.speakerFor(item.channel), this.dictionary);
        this.writer.add(item.channel, segments, [item.startSec, item.startSec + item.pcm.length / SAMPLE_RATE]);
      } catch (e) {
        console.warn("live transcription window failed", e);
      }
    }
    this.queuedSec = 0;
  }

  /** Stops listening, then waits until queued speech is transcribed and saved. */
  async finish(onProgress?: (backlogSec: number) => void) {
    if (!this.stopped) {
      for (const ch of [...this.taps.keys()]) this.detach(ch);
      this.stopped = true;
      void this.ctx?.close().catch(() => {});
    }
    const timer = onProgress ? setInterval(() => onProgress(this.queuedSec), 1000) : null;
    try {
      while (this.busy) await this.busy;
    } finally {
      if (timer) clearInterval(timer);
      await this.writer.flush();
    }
  }
}
