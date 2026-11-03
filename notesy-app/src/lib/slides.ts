import { putSlide } from "./db";
import { workerInterval } from "./ticker";
import type { Slide } from "./types";
import { uid } from "./util";

const SIG_W = 96;
const SIG_H = 54;
const MAX_W = 1600;
const MIN_GAP_MS = 6000;

interface FrameSource {
  grab(): Promise<CanvasImageSource & { width: number; height: number } | null>;
  close(): void;
}

function frameSource(track: MediaStreamTrack): FrameSource {
  const IC = (globalThis as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture;
  if (IC) {
    const ic = new IC(track);
    let last: ImageBitmap | null = null;
    return {
      async grab() {
        if (track.readyState !== "live") return null;
        try {
          last?.close();
          last = await ic.grabFrame();
          return last;
        } catch {
          return null;
        }
      },
      close: () => last?.close(),
    };
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  video.play().catch(() => {});
  return {
    async grab() {
      if (!video.videoWidth) return null;
      return Object.assign(video, { width: video.videoWidth, height: video.videoHeight });
    },
    close: () => {
      video.srcObject = null;
    },
  };
}

function signature(ctx: CanvasRenderingContext2D, img: CanvasImageSource) {
  ctx.drawImage(img, 0, 0, SIG_W, SIG_H);
  const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);
  const sig = new Float32Array(SIG_W * SIG_H);
  let sum = 0;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    sig[j] = v;
    sum += v;
  }
  const mean = sum / sig.length;
  let varSum = 0;
  for (let j = 0; j < sig.length; j++) varSum += (sig[j] - mean) ** 2;
  return { sig, mean, std: Math.sqrt(varSum / sig.length) };
}

function diff(a: Float32Array, b: Float32Array) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - b[i];
    d += x < 0 ? -x : x;
  }
  return d / a.length;
}

export async function encodeFrame(img: CanvasImageSource & { width: number; height: number }) {
  const scale = Math.min(1, MAX_W / img.width);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return { blob, width: w, height: h };
}

export async function saveSlide(noteId: string, t: number, blob: Blob, width: number, height: number, auto: boolean) {
  const id = uid("s_");
  const slide: Slide = { id, noteId, t, blobKey: `slide:${id}`, width, height, auto };
  await putSlide(slide, blob);
  return slide;
}

export interface WatcherOptions {
  noteId: string;
  track: MediaStreamTrack;
  clock: () => number;
  intervalMs: number;
  sensitivity: number;
  auto: boolean;
  onSlide?: (s: Slide) => void;
}

/**
 * Samples the shared screen, waits for the picture to settle after a change,
 * and keeps one frame per distinct slide (revisited slides are skipped).
 */
export class SlideWatcher {
  private src: FrameSource;
  private ctx: CanvasRenderingContext2D;
  private prev: Float32Array | null = null;
  private saved: Float32Array[] = [];
  private lastSaveAt = -Infinity;
  private busy = false;
  private stopTick: (() => void) | null = null;
  paused = false;
  count = 0;

  constructor(private opts: WatcherOptions) {
    this.src = frameSource(opts.track);
    const canvas = document.createElement("canvas");
    canvas.width = SIG_W;
    canvas.height = SIG_H;
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  }

  private get threshold() {
    const s = Math.min(1, Math.max(0, this.opts.sensitivity));
    return 0.12 - s * 0.09;
  }

  start() {
    if (this.opts.auto) this.stopTick = workerInterval(() => void this.tick(), this.opts.intervalMs);
  }

  setAuto(auto: boolean) {
    this.opts.auto = auto;
    this.stopTick?.();
    this.stopTick = null;
    this.start();
  }

  private async tick() {
    if (this.busy || this.paused) return;
    this.busy = true;
    try {
      const img = await this.src.grab();
      if (!img || !img.width) return;
      const { sig, mean, std } = signature(this.ctx, img);
      const prev = this.prev;
      this.prev = sig;
      if (!prev) return;
      const settled = diff(sig, prev) < this.threshold / 3;
      if (!settled || mean < 0.03 || std < 0.015) return;
      const t = this.opts.clock();
      if (t - this.lastSaveAt < MIN_GAP_MS) return;
      const novel = this.saved.slice(-30).every((s) => diff(sig, s) > this.threshold);
      if (!novel) return;
      await this.store(img, sig, true);
    } finally {
      this.busy = false;
    }
  }

  private async store(img: CanvasImageSource & { width: number; height: number }, sig: Float32Array, auto: boolean) {
    const t = this.opts.clock();
    const { blob, width, height } = await encodeFrame(img);
    this.saved.push(sig);
    this.lastSaveAt = t;
    this.count++;
    const slide = await saveSlide(this.opts.noteId, t, blob, width, height, auto);
    this.opts.onSlide?.(slide);
    return slide;
  }

  async captureNow() {
    const img = await this.src.grab();
    if (!img || !img.width) throw new Error("Layar belum siap untuk diambil.");
    const { sig } = signature(this.ctx, img);
    return this.store(img, sig, false);
  }

  stop() {
    this.stopTick?.();
    this.src.close();
  }
}
