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

export const sessionKey = (noteId: string, ch: Channel | "mix") => `${noteId}:${ch}`;

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
      if (this.rec.state === "inactive") return resolve();
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
  private startedAt = 0;
  private pausedAt = 0;
  private pausedTotal = 0;
  private buf = new Float32Array(2048);
  state: "idle" | "recording" | "paused" | "stopped" = "idle";
  warnings: string[] = [];
  onEnded?: () => void;

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
    const { mode, micDeviceId, echoCancellation = true } = this.opts;
    if (mode === "screen") {
      this.display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
      this.display.getVideoTracks()[0]?.addEventListener("ended", () => this.onEnded?.());
      if (!this.hasSystemAudio) {
        this.warnings.push(
          "Audio peserta tidak ikut terekam. Saat memilih layar, centang “Bagikan juga audio sistem” (Share system audio) agar suara Teams/Zoom terekam.",
        );
      }
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId ? { exact: micDeviceId } : undefined,
          echoCancellation,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
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
    const mix = this.ctx.createMediaStreamDestination();
    const mime = pickMime();
    const { noteId } = this.opts;

    const wire = (ch: Channel, stream: MediaStream) => {
      const src = this.ctx!.createMediaStreamSource(stream);
      const an = this.ctx!.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      src.connect(mix);
      this.analysers[ch] = an;
      this.recorders[ch] = new ChannelRecorder(sessionKey(noteId, ch), stream, mime, 32000);
    };
    if (this.mic) wire("mic", this.mic);
    if (this.display && this.hasSystemAudio) wire("system", new MediaStream(this.display.getAudioTracks()));
    this.recorders.mix = new ChannelRecorder(sessionKey(noteId, "mix"), mix.stream, mime, 64000);

    Object.values(this.recorders).forEach((r) => r!.start());
    this.startedAt = performance.now();
    this.state = "recording";
  }

  elapsed() {
    if (!this.startedAt) return 0;
    const now = this.state === "paused" ? this.pausedAt : performance.now();
    return now - this.startedAt - this.pausedTotal;
  }

  pause() {
    if (this.state !== "recording") return;
    Object.values(this.recorders).forEach((r) => r!.pause());
    this.pausedAt = performance.now();
    this.state = "paused";
  }

  resume() {
    if (this.state !== "paused") return;
    Object.values(this.recorders).forEach((r) => r!.resume());
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

  private stopTracks() {
    this.display?.getTracks().forEach((t) => t.stop());
    this.mic?.getTracks().forEach((t) => t.stop());
  }

  /** Stops capture and turns the chunk journal into one blob per channel. */
  async stop(): Promise<{ tracks: AudioTrack[]; durationMs: number }> {
    const durationMs = this.elapsed();
    if (this.state === "paused") this.resume();
    this.state = "stopped";
    await Promise.all(Object.values(this.recorders).map((r) => r!.stop()));
    this.stopTracks();
    await this.ctx?.close().catch(() => {});
    const tracks = await finalizeTracks(
      this.opts.noteId,
      (Object.entries(this.recorders) as [Channel | "mix", ChannelRecorder][]).map(([ch, r]) => [ch, r.mime]),
    );
    return { tracks, durationMs };
  }
}

export async function finalizeTracks(noteId: string, channels: [Channel | "mix", string][]): Promise<AudioTrack[]> {
  const tracks: AudioTrack[] = [];
  for (const [ch, mime] of channels) {
    const blob = await takeChunks(sessionKey(noteId, ch), mime);
    if (!blob || !blob.size) continue;
    const blobKey = `audio:${noteId}:${ch}`;
    await putBlob(blobKey, blob);
    tracks.push({ channel: ch, blobKey, mime: blob.type || mime, bytes: blob.size });
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
