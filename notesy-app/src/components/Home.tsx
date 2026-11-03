import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Menu, MonitorUp, Sparkles, Image as ImageIcon, FileAudio } from "lucide-react";
import { useSettings } from "../lib/settings";
import { aiConfigured, testConnection } from "../lib/ai";
import { canCaptureScreen, isAndroid } from "../lib/platform";
import { RecordButton } from "./RecordButton";

interface Props {
  onNavigate: (path: string) => void;
  onToggleSidebar: () => void;
}

export function Home({ onNavigate, onToggleSidebar }: Props) {
  const [settings] = useSettings();
  const [who, setWho] = useState<string | null>(null);
  const connected = aiConfigured(settings);

  useEffect(() => {
    if (!connected) return setWho(null);
    let alive = true;
    testConnection(settings)
      .then((r) => alive && setWho(r.who ?? "terhubung"))
      .catch(() => alive && setWho(null));
    return () => {
      alive = false;
    };
  }, [connected, settings.cursorApiKey, settings.aiProvider]);

  return (
    <div className="page home">
      <header className="page-header">
        <button className="icon-btn only-mobile" onClick={onToggleSidebar} aria-label="Menu">
          <Menu size={20} />
        </button>
      </header>
      <div className="home-body">
        <h1>Siap mencatat rapat</h1>
        <p className="lead">
          {canCaptureScreen
            ? "Klik Rekam rapat, pilih layar Teams/Zoom, dan centang “bagikan audio sistem”. Notesy merekam suara, menangkap slide, mentranskrip di perangkat ini, lalu AI menyusun ringkasan bergambar."
            : "Rekam rapat lewat mikrofon, tambahkan foto slide dari kamera, lalu AI menyusun ringkasan."}
        </p>
        <RecordButton variant="hero" onStarted={(id) => onNavigate(`note/${id}`)} />

        <div className="checklist">
          <button className="check-item" onClick={() => onNavigate("settings/intelligence")}>
            {connected && who ? <CheckCircle2 className="ok" size={18} /> : <Circle size={18} />}
            <div>
              <b>Intelligence</b>
              <span>{connected ? (who ? `Terhubung: ${who}` : "Memeriksa koneksi…") : "Masukkan API key Cursor sekali saja"}</span>
            </div>
          </button>
          <button className="check-item" onClick={() => onNavigate("settings/transcription")}>
            <CheckCircle2 className="ok" size={18} />
            <div>
              <b>Transkripsi</b>
              <span>{settings.sttEngine === "browser" ? "Whisper di perangkat (tanpa kirim audio ke cloud)" : "Layanan API"}</span>
            </div>
          </button>
        </div>

        <div className="feature-grid">
          <div>
            <MonitorUp size={18} />
            <b>Layar + audio</b>
            <span>{isAndroid ? "Di Android: mikrofon. Untuk layar, gunakan Chrome di laptop." : "Teams/Zoom desktop, tab browser, atau seluruh layar."}</span>
          </div>
          <div>
            <ImageIcon size={18} />
            <b>Slide otomatis</b>
            <span>Setiap slide baru ditangkap dan dijelaskan di ringkasan.</span>
          </div>
          <div>
            <FileAudio size={18} />
            <b>Transkrip 2 kanal</b>
            <span>Suara Anda dan suara peserta dipisah otomatis.</span>
          </div>
          <div>
            <Sparkles size={18} />
            <b>Ringkasan & tanya</b>
            <span>Template rapat, tindak lanjut, dan tanya jawab tentang isi rapat.</span>
          </div>
        </div>
        <p className="fineprint">Beri tahu peserta bahwa rapat direkam. Semua data tersimpan di perangkat ini.</p>
      </div>
    </div>
  );
}
