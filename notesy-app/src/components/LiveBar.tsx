import { useRef, useState } from "react";
import { Camera, Mic, MicOff, MonitorUp, Pause, Play, PictureInPicture2, Square, Wand2 } from "lucide-react";
import {
  AUDIO_LOST,
  SCREEN_LOST,
  captureSlideNow,
  getElapsed,
  getLevels,
  pauseRecording,
  reshareScreen,
  resumeRecording,
  setAutoSlides,
  stopRecording,
  toggleMic,
  type LiveSession,
} from "../lib/session";
import { useTick } from "../lib/hooks";
import { formatClock } from "../lib/util";
import { toast, toastError } from "../lib/toast";
import { hasDocumentPip } from "../lib/platform";
import { openPip } from "./PipBar";

export function Meter({ label, getter }: { label: string; getter: () => number }) {
  const bar = useRef<HTMLSpanElement>(null);
  useTick(() => {
    if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0.02, getter())})`;
  });
  return (
    <span className="meter" title={label}>
      <small>{label}</small>
      <span className="meter-track">
        <span ref={bar} className="meter-fill" />
      </span>
    </span>
  );
}

export function Clock() {
  const ref = useRef<HTMLSpanElement>(null);
  useTick(() => {
    if (ref.current) ref.current.textContent = formatClock(getElapsed());
  });
  return <span ref={ref} className="clock" />;
}

export function LiveControls({ live, compact }: { live: LiveSession; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const paused = live.state === "paused";
  const snap = async () => {
    try {
      await captureSlideNow();
      toast("Tangkapan layar disimpan", "success", 1500);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className={`live-controls${compact ? " compact" : ""}`}>
      <span className={`rec-dot${paused ? "" : " pulse"}`} />
      <Clock />
      {live.hasMic && <Meter label="Saya" getter={() => getLevels().mic} />}
      {live.hasSystemAudio && <Meter label="Peserta" getter={() => getLevels().system} />}
      <div className="spacer" />
      {live.screenLost && (
        <button
          className="icon-btn danger"
          title="Berbagi layar berhenti. Klik untuk bagikan ulang."
          onClick={() =>
            reshareScreen().catch(() => {
              window.focus();
              toast("Berbagi layar berhenti. Klik “Bagikan ulang” di Notesy.", "error");
            })
          }
        >
          <MonitorUp size={16} />
        </button>
      )}
      {live.hasMic && (
        <button className={`icon-btn${live.micMuted ? " danger" : ""}`} onClick={toggleMic} title={live.micMuted ? "Nyalakan mikrofon" : "Bisukan mikrofon"}>
          {live.micMuted ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
      )}
      {live.mode === "screen" && (
        <>
          <button className="icon-btn" onClick={snap} title="Ambil tangkapan layar sekarang">
            <Camera size={16} />
            {!compact && live.slideCount > 0 && <span className="count">{live.slideCount}</span>}
          </button>
          {!compact && (
            <button className={`icon-btn${live.autoSlides ? " active" : ""}`} onClick={() => setAutoSlides(!live.autoSlides)} title="Tangkap slide otomatis">
              <Wand2 size={16} />
            </button>
          )}
        </>
      )}
      <button className="icon-btn" onClick={paused ? resumeRecording : pauseRecording} title={paused ? "Lanjutkan" : "Jeda"}>
        {paused ? <Play size={16} /> : <Pause size={16} />}
      </button>
      {!compact && hasDocumentPip && (
        <button className="icon-btn" onClick={() => openPip().catch(toastError)} title="Kontrol melayang di atas Teams/Zoom">
          <PictureInPicture2 size={16} />
        </button>
      )}
      <button
        className="btn btn-stop"
        disabled={busy || live.state === "stopping"}
        onClick={async () => {
          setBusy(true);
          await stopRecording().catch(toastError);
          setBusy(false);
        }}
      >
        <Square size={12} fill="currentColor" />
        {!compact && (live.state === "stopping" ? "Menyimpan…" : "Selesai")}
      </button>
    </div>
  );
}

export function ReshareButton({ small }: { small?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`btn btn-primary${small ? " btn-small" : ""}`}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await reshareScreen();
          toast("Layar dibagikan lagi. Audio peserta dan slide terekam kembali.", "success");
        } catch (e) {
          if (!(e instanceof DOMException && e.name === "NotAllowedError")) toastError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <MonitorUp size={14} /> Bagikan ulang
    </button>
  );
}

export function LiveBar({ live }: { live: LiveSession }) {
  return (
    <div className="live-bar">
      <LiveControls live={live} />
      {live.warnings.map((w) => {
        const alert = live.screenLost && (w === SCREEN_LOST || w === AUDIO_LOST);
        return (
          <p key={w} className={`live-warning${alert ? " live-alert" : ""}`}>
            {w}
            {alert && <ReshareButton small />}
          </p>
        );
      })}
    </div>
  );
}
