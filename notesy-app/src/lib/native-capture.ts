import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { saveSlide } from "./slides";
import type { Slide } from "./types";

interface NativeSlide {
  t: number;
  data: string;
  width: number;
  height: number;
  auto: boolean;
}

interface NotesyCapture {
  start(o: { screen: boolean; intervalMs: number; sensitivity: number }): Promise<{ screen: boolean }>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  captureNow(): Promise<void>;
  takeSlides(): Promise<{ slides: NativeSlide[] }>;
  addListener(event: "screenEnded", f: () => void): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<NotesyCapture>("NotesyCapture");

/** Android app only: a foreground service keeps the mic alive in the background and can sample the screen for slides. */
export const hasNativeCapture = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

const COLLECT_MS = 4000;

/** Runs the Android capture service for one recording and moves the slides it detects into the note. */
export class NativeCapture {
  screen = false;
  /** Meeting time when the service started; its slide times count from there. */
  private offsetMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ended: PluginListenerHandle | null = null;
  private collecting: Promise<void> = Promise.resolve();

  private constructor(
    private readonly noteId: string,
    private readonly onSlide: (s: Slide) => void,
  ) {}

  /** Asks Android for screen capture when `screen` is set; the user may refuse, leaving a mic-only recording. */
  static async start(opts: {
    noteId: string;
    screen: boolean;
    intervalMs: number;
    sensitivity: number;
    clock: () => number;
    onSlide: (s: Slide) => void;
    onScreenEnded: () => void;
  }) {
    const c = new NativeCapture(opts.noteId, opts.onSlide);
    const r = await plugin.start({ screen: opts.screen, intervalMs: opts.intervalMs, sensitivity: opts.sensitivity });
    c.screen = r.screen;
    c.offsetMs = opts.clock();
    if (c.screen) {
      c.ended = await plugin.addListener("screenEnded", () => {
        c.screen = false;
        opts.onScreenEnded();
      });
      c.timer = setInterval(() => void c.collect(), COLLECT_MS);
    }
    return c;
  }

  collect() {
    this.collecting = this.collecting.then(async () => {
      const { slides } = await plugin.takeSlides().catch(() => ({ slides: [] as NativeSlide[] }));
      for (const s of slides) {
        const bytes = Uint8Array.from(atob(s.data), (ch) => ch.charCodeAt(0));
        const slide = await saveSlide(this.noteId, this.offsetMs + s.t, new Blob([bytes], { type: "image/jpeg" }), s.width, s.height, s.auto);
        this.onSlide(slide);
      }
    });
    return this.collecting;
  }

  pause = () => plugin.pause().catch(() => {});
  resume = () => plugin.resume().catch(() => {});

  async captureNow() {
    await plugin.captureNow();
    await new Promise((r) => setTimeout(r, 700));
    await this.collect();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.collect();
    await this.ended?.remove();
    await plugin.stop().catch(() => {});
  }
}
