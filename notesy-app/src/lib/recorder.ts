import { appendChunk, putBlob, takeChunks } from "./db";
import type { AudioTrack, Channel } from "./types";

export type CaptureMode = "screen" | "mic";

export interface RecorderOptions {
  noteId: string;
  mode: CaptureMode;
  micDeviceId?: string;
  echoCancellation?: boolean;
}

export interface Levels {
  mic: number;
  system: number;
}

const TIMESLICE = 4000;

export function pickMime() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

/** Re-shared system audio is journaled as its own part; the key carries its offset so recovery keeps the timing. */
export const sessionKey = (noteId: string, ch: Channel | "mix", offsetMs = 0) => `${noteId}:${ch}${offsetMs ? `~${Math.round(offsetMs)}` : ""}`;

export function parseSessionKey(key: string) {
  const m = key.match(/^(.+):(mic|system|mix)(?:~(\d+))?$/);
  return m ? { noteId: m[1], channel: m[2] as Channel | "mix", offsetMs: Number(m[3] ?? 0) } : null;
}

const DISPLAY_OPTIONS = {
  video: { frameRate: { ideal: 5, max: 10 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
  monitorTypeSurfaces: "include",
} as DisplayMediaStreamOptions;

class ChannelRecorder {
  private rec: MediaRecorder;
  private seq = 0;
  private pending: Promise<void>[] = [];
  readonly mime: string;

  constructor(readonly session: string, stream: MediaStream, mime: string, bitrate: number) {
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: bitrate } : { audioBitsPerSecond: bitrate });
    this.mime = this.rec.mimeType || mime || "audio/webm";
    this.rec.ondataavailable = (e) => {
      if (e.data && e.data.size) this.pending.push(appendChunk(this.session, this.seq++, e.data));
    };
  }

  start() {
    this.rec.start(TIMESLICE);
  }
  pause() {
    if (this.rec.state === "recording") this.rec.pause();
  }
  resume() {
    if (this.rec.state === "paused") this.rec.resume();
  }
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.rec.state === "inactive") return void Promise.all(this.pending).then(() => resolve());
      this.rec.onstop = () => Promise.all(this.pending).then(() => resolve());
      this.rec.stop();
    });
  }
}

export class MeetingRecorder {
  display: MediaStream | null = null;
  mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analysers: Partial<Record<Channel, AnalyserNode>> = {};
  private recorders: Partial<Record<Channel | "mix", ChannelRecorder>> = {};
  private systemParts: { rec: ChannelRecorder; offsetMs: number }[] = [];
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private micParts: { rec: ChannelRecorder; offsetMs: number }[] = [];
  private micSource: MediaStreamAudioSourceNode | null = null;
  private mix: MediaStreamAudioDestinationNode | null = null;
  private mime = "";
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private buf = new Float32Array(2048);
  state: "idle" | "recording" | "paused" | "stopped" = "idle";
  warnings: string[] = [];
  /** Fires when the browser ends the screen share; audio keeps recording until stop(). */
  onScreenEnded?: (surface: string | undefined) => void;
  onSystemAudioLost?: () => void;
  onMicLost?: () => void;
  onMicRestored?: () => void;

  constructor(readonly opts: RecorderOptions) {}

  get hasSystemAudio() {
    return !!this.display?.getAudioTracks().length;
  }
  get hasMic() {
    return !!this.mic?.getAudioTracks().length;
  }
  get videoTrack(): MediaStreamTrack | null {
    return this.display?.getVideoTracks()[0] ?? null;
  }
  get displaySurface(): string | undefined {
    return (this.videoTrack?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface;
  }

  async start() {
    const { mode } = this.opts;
    if (mode === "screen") {
      this.display = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
      if (!this.hasSystemAudio) {
        this.warnings.push(
          "Audio peserta tidak ikut terekam. Saat memilih layar, centang “Bagikan juga audio sistem” (Share system audio) agar suara Teams/Zoom terekam.",
        );
      }
    }
    try {
      this.mic = await this.openMic();
    } catch (e) {
      if (mode === "mic") {
        this.stopTracks();
        throw e;
      }
      this.warnings.push("Mikrofon tidak bisa dipakai; hanya audio layar yang direkam.");
    }
    if (!this.hasMic && !this.hasSystemAudio) {
      this.stopTracks();
      throw new Error("Tidak ada sumber audio. Izinkan mikrofon atau bagikan audio sistem.");
    }

    this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    // Calls and device switches can suspend the context, which would silence the mix track.
    this.ctx.onstatechange = () => {
      if (this.ctx && this.ctx.state !== "running" && this.ctx.state !== "closed" && this.state !== "stopped") void this.ctx.resume().catch(() => {});
    };
    this.mix = this.ctx.createMediaStreamDestination();
    this.mime = pickMime();
    const { noteId } = this.opts;

    this.recorders.mix = new ChannelRecorder(sessionKey(noteId, "mix"), this.mix.stream, this.mime, 64000);
    this.recorders.mix.start();
    this.startedAt = performance.now();
    this.state = "recording";
    if (this.mic) this.attachMic(this.mic);
    if (this.display) this.attachDisplay(this.display);
    navigator.mediaDevices.addEventListener("devicechange", this.onDeviceChange);
  }

  private openMic() {
    const { micDeviceId, echoCancellation = true } = this.opts;
    const audio = (deviceId?: string): MediaTrackConstraints => ({
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    return navigator.mediaDevices
      .getUserMedia({ audio: audio(micDeviceId) })
      .catch((e) => (micDeviceId ? navigator.mediaDevices.getUserMedia({ audio: audio() }) : Promise.reject(e)));
  }

  private attachMic(stream: MediaStream) {
    if (!this.ctx || !this.mix) return;
    this.mic = stream;
    const track = stream.getAudioTracks()[0];
    track?.addEventListener("ended", () => void this.detachMic(stream));
    const src = this.ctx.createMediaStreamSource(stream);
    this.analysers.mic = this.analyser(src);
    src.connect(this.mix);
    this.micSource = src;
    const elapsed = this.elapsed();
    const offsetMs = elapsed < 1000 ? 0 : elapsed;
    const rec = new ChannelRecorder(sessionKey(this.opts.noteId, "mic", offsetMs), stream, this.mime, 32000);
    rec.start();
    if (this.state === "paused") rec.pause();
    this.micParts.push({ rec, offsetMs });
  }

  /** The OS ends the mic track when a call grabs the device or a headset switches profile; reconnect until stop(). */
  private async detachMic(stream: MediaStream) {
    if (this.mic !== stream || this.state === "stopped") return;
    this.mic = null;
    this.micSource?.disconnect();
    this.micSource = null;
    delete this.analysers.mic;
    stream.getTracks().forEach((t) => t.stop());
    await this.micParts.at(-1)?.rec.stop();
    this.onMicLost?.();
    this.scheduleMicRetry(0);
  }

  private micRetry: ReturnType<typeof setTimeout> | null = null;

  private scheduleMicRetry(delayMs = 2000) {
    if (this.micRetry || this.mic || this.state === "stopped") return;
    this.micRetry = setTimeout(async () => {
      this.micRetry = null;
      if (this.mic || this.state === "stopped") return;
      try {
        const stream = await this.openMic();
        if ((this.state as MeetingRecorder["state"]) === "stopped") return stream.getTracks().forEach((t) => t.stop());
        this.attachMic(stream);
        this.onMicRestored?.();
      } catch {
        this.scheduleMicRetry();
      }
    }, delayMs);
  }

  private onDeviceChange = () => {
    if (!this.mic && this.state !== "stopped" && this.micParts.length) {
      if (this.micRetry) clearTimeout(this.micRetry);
      this.micRetry = null;
      this.scheduleMicRetry(300);
    }
  };

  private analyser(src: AudioNode) {
    const an = this.ctx!.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    return an;
  }

  private attachDisplay(display: MediaStream) {
    this.display = display;
    const video = display.getVideoTracks()[0];
    video?.addEventListener("ended", () => void this.detachDisplay(display));
    if (!display.getAudioTracks().length || !this.ctx || !this.mix) return;
    display.getAudioTracks()[0].addEventListener("ended", () => void this.detachSystemAudio(display));
    const stream = new MediaStream(display.getAudioTracks());
    const src = this.ctx.createMediaStreamSource(stream);
    this.analysers.system = this.analyser(src);
    src.connect(this.mix);
    this.systemSource = src;
    const elapsed = this.elapsed();
    const offsetMs = elapsed < 1000 ? 0 : elapsed;
    const rec = new ChannelRecorder(sessionKey(this.opts.noteId, "system", offsetMs), stream, this.mime, 32000);
    if (this.state === "recording" || this.state === "paused") rec.start();
    if (this.state === "paused") rec.pause();
    this.systemParts.push({ rec, offsetMs });
  }

  private async stopSystemPart() {
    if (!this.systemSource) return;
    this.systemSource.disconnect();
    this.systemSource = null;
    delete this.analysers.system;
    await this.systemParts.at(-1)?.rec.stop();
  }

  /** System audio can drop on its own (output device switched by a call) while the video keeps going. */
  private async detachSystemAudio(display: MediaStream) {
    if (this.display !== display || this.state === "stopped" || !this.systemSource) return;
    await this.stopSystemPart();
    if (this.display === display && display.getVideoTracks().some((t) => t.readyState === "live")) this.onSystemAudioLost?.();
  }

  private async detachDisplay(display: MediaStream) {
    if (this.display !== display || this.state === "stopped") return;
    const surface = this.displaySurface;
    this.display = null;
    await this.stopSystemPart();
    display.getTracks().forEach((t) => t.stop());
    this.onScreenEnded?.(surface);
  }

  /** Lets the user pick a screen again after the share ended, continuing slides and participant audio. */
  async reshare() {
    if (this.state === "stopped") throw new Error("Rekaman sudah selesai.");
    const display = await navigator.mediaDevices.getDisplayMedia(DISPLAY_OPTIONS);
    if (this.display) await this.detachDisplay(this.display);
    this.attachDisplay(display);
    return display;
  }

  elapsed() {
    if (!this.startedAt) return 0;
    const now = this.state === "paused" ? this.pausedAt : performance.now();
    return now - this.startedAt - this.pausedTotal;
  }

  pause() {
    if (this.state !== "recording") return;
    this.allRecorders().forEach((r) => r.pause());
    this.pausedAt = performance.now();
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    this.allRecorders().forEach((r) => r.resume());
    this.pausedTotal += performance.now() - this.pausedAt;
    this.state = "recording";
  }

  setMicMuted(muted: boolean) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }
  get micMuted() {
    return !!this.mic && this.mic.getAudioTracks().every((t) => !t.enabled);
  }

  levels(): Levels {
    const level = (an?: AnalyserNode) => {
      if (!an) return 0;
      an.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
      return Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
    };
    return { mic: this.micMuted ? 0 : level(this.analysers.mic), system: level(this.analysers.system) };
  }

  private allRecorders() {
    return [...(Object.values(this.recorders) as ChannelRecorder[]), ...this.micParts.map((p) => p.rec), ...this.systemParts.map((p) => p.rec)];
  }

  private stopTracks() {
    this.display?.getTracks().forEach((t) => t.stop());
    this.mic?.getTracks().forEach((t) => t.stop());
  }

  /** Stops capture and turns the chunk journal into one blob per channel. */
  async stop(): Promise<{ tracks: AudioTrack[]; durationMs: number }> {
    const durationMs = this.elapsed();
    if (this.state === "paused") this.resume();
    this.state = "stopped";
    navigator.mediaDevices.removeEventListener("devicechange", this.onDeviceChange);
    if (this.micRetry) clearTimeout(this.micRetry);
    await Promise.all(this.allRecorders().map((r) => r.stop()));
    this.stopTracks();
    await this.ctx?.close().catch(() => {});
    const { noteId } = this.opts;
    const tracks = await finalizeTracks([
      ...(Object.entries(this.recorders) as [Channel | "mix", ChannelRecorder][]).map(([ch, r]) => ({ session: sessionKey(noteId, ch), mime: r.mime })),
      ...this.micParts.map((p) => ({ session: sessionKey(noteId, "mic", p.offsetMs), mime: p.rec.mime })),
      ...this.systemParts.map((p) => ({ session: sessionKey(noteId, "system", p.offsetMs), mime: p.rec.mime })),
    ]);
    return { tracks, durationMs };
  }
}

export async function finalizeTracks(parts: { session: string; mime: string }[]): Promise<AudioTrack[]> {
  const tracks: AudioTrack[] = [];
  for (const { session, mime } of parts) {
    const parsed = parseSessionKey(session);
    if (!parsed) continue;
    const blob = await takeChunks(session, mime);
    if (!blob || !blob.size) continue;
    const blobKey = `audio:${session}`;
    await putBlob(blobKey, blob);
    tracks.push({ channel: parsed.channel, blobKey, mime: blob.type || mime, bytes: blob.size, ...(parsed.offsetMs ? { offsetMs: parsed.offsetMs } : {}) });
  }
  return tracks;
}

export async function listMicrophones() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput");
  } catch {
    return [];
  }
}
