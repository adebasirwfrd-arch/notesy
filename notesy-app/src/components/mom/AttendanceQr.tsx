import { useEffect, useState } from "react";
import { Check, Copy, Download, Loader2, RefreshCw, Share2, TriangleAlert } from "lucide-react";
import type { MomAttendance } from "../../lib/types";
import { attendanceUrl, publishAttendance, qrCard, qrDataUrl, type AttendanceInfo } from "../../lib/attendance";
import { download, errorMessage } from "../../lib/util";
import { toast } from "../../lib/toast";

const fileName = (title: string) => `QR Absensi - ${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "Rapat"}.png`;

/** Publishes the meeting info, then shows the attendance QR with download, copy and share actions. */
export function AttendanceQr({ attendance, info }: { attendance: MomAttendance; info: AttendanceInfo }) {
  const url = attendanceUrl(attendance.id);
  const [qr, setQr] = useState("");
  const [state, setState] = useState<"publishing" | "ready" | { error: string }>("publishing");
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const infoKey = JSON.stringify(info);

  useEffect(() => void qrDataUrl(url, 560).then(setQr), [url]);

  useEffect(() => {
    let live = true;
    setState("publishing");
    publishAttendance(attendance, info).then(
      () => live && setState("ready"),
      (e) => live && setState({ error: errorMessage(e) }),
    );
    return () => void (live = false);
  }, [attendance.key, infoKey, attempt]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      prompt("Salin link absensi:", url);
    }
  };

  const save = async () => download(fileName(info.title), await qrCard(info, url), "image/png");

  const share = async () => {
    const file = new File([await qrCard(info, url)], fileName(info.title), { type: "image/png" });
    const text = `Daftar hadir: ${info.title}\n${url}`;
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text });
      else await navigator.share({ title: "Daftar hadir", text, url });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast("Berbagi tidak didukung di perangkat ini. Gunakan Unduh QR atau Salin link.", "info");
    }
  };

  return (
    <div className="att-qr">
      <div className={`att-qr-code${state === "ready" ? "" : " pending"}`}>
        {qr ? <img src={qr} alt="QR absensi" /> : <Loader2 size={22} className="spin" />}
      </div>
      <div className="att-qr-side">
        <b className="att-qr-title">{info.title}</b>
        <small className="muted">
          {[info.date, info.location].filter(Boolean).join(" · ")}
          <br />
          {info.needSignature ? "Peserta wajib tanda tangan (tulis manual atau unggah gambar)." : "Tanpa tanda tangan: peserta cukup isi data diri."}
        </small>
        {state === "publishing" && (
          <p className="att-qr-status">
            <Loader2 size={14} className="spin" /> Mengaktifkan link absensi…
          </p>
        )}
        {state === "ready" && (
          <p className="att-qr-status ok">
            <Check size={14} /> Aktif 3 hari. Peserta yang mengisi otomatis masuk ke daftar hadir MoM.
          </p>
        )}
        {typeof state === "object" && (
          <p className="att-qr-status err">
            <TriangleAlert size={14} /> {state.error}
            <button type="button" className="btn btn-small" onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw size={13} /> Coba lagi
            </button>
          </p>
        )}
        <code className="att-qr-link">{url}</code>
        <div className="att-qr-actions">
          <button type="button" className="btn btn-small btn-primary" onClick={save} disabled={!qr}>
            <Download size={14} /> Unduh QR
          </button>
          <button type="button" className="btn btn-small" onClick={copy}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Tersalin" : "Salin link"}
          </button>
          {"share" in navigator && (
            <button type="button" className="btn btn-small" onClick={share}>
              <Share2 size={14} /> Bagikan
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
