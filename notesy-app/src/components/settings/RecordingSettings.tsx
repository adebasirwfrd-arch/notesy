import { useEffect, useState } from "react";
import { useSettings } from "../../lib/settings";
import { listMicrophones } from "../../lib/recorder";
import { canCaptureScreen, hasDocumentPip } from "../../lib/platform";
import { Card, Field, Toggle } from "./Field";

export function RecordingSettings() {
  const [s, set] = useSettings();
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    listMicrophones().then(setMics);
  }, []);

  return (
    <>
      {canCaptureScreen && (
        <Card tone="info">
          <b>Merekam Teams/Zoom desktop di Windows</b>
          <ol>
            <li>Mulai rapat di aplikasi Teams/Zoom seperti biasa.</li>
            <li>Di Notesy klik <b>Rekam rapat</b> → tab <b>Seluruh layar</b> → pilih layar.</li>
            <li>
              Centang <b>Bagikan juga audio sistem</b> di pojok kiri bawah, lalu <b>Bagikan</b>.
            </li>
            <li>{hasDocumentPip ? "Klik ikon kontrol melayang agar timer dan tombol tetap terlihat di atas Teams." : "Biarkan tab Notesy terbuka."}</li>
          </ol>
          <small>Di Mac, audio sistem hanya tersedia saat berbagi tab Chrome (Teams/Zoom versi web). Untuk aplikasi desktop di Mac, gunakan mode mikrofon.</small>
        </Card>
      )}
      <Field label="Mikrofon">
        <select value={s.micDeviceId} onChange={(e) => set({ micDeviceId: e.target.value })}>
          <option value="">Default sistem</option>
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label || `Mikrofon ${m.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Peredam gema" hint="Nyalakan jika tidak memakai headset, agar suara peserta tidak masuk ke kanal Anda.">
        <Toggle checked={s.echoCancellation} onChange={(v) => set({ echoCancellation: v })} />
      </Field>
      <Field label="Tangkap slide otomatis" hint="Mengambil gambar setiap kali layar yang dibagikan berganti.">
        <Toggle checked={s.captureSlides} onChange={(v) => set({ captureSlides: v })} />
      </Field>
      <Field label="Sensitivitas deteksi slide" hint="Tinggi = lebih banyak tangkapan (perubahan kecil ikut tertangkap).">
        <input type="range" min={0} max={1} step={0.05} value={s.slideSensitivity} onChange={(e) => set({ slideSensitivity: Number(e.target.value) })} />
      </Field>
      <Field label="Interval pemeriksaan layar">
        <select value={s.slideIntervalMs} onChange={(e) => set({ slideIntervalMs: Number(e.target.value) })}>
          <option value={1000}>1 detik</option>
          <option value={1500}>1,5 detik</option>
          <option value={3000}>3 detik (hemat baterai)</option>
        </select>
      </Field>
      <Field label="Maks. gambar di ringkasan">
        <input type="number" min={0} max={30} value={s.maxSlidesInSummary} onChange={(e) => set({ maxSlidesInSummary: Number(e.target.value) })} />
      </Field>
    </>
  );
}
