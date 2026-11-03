import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useSettings } from "../../lib/settings";
import { STT_LANGUAGES, WHISPER_MODELS, prepareWhisper } from "../../lib/stt";
import { hasWebGPU } from "../../lib/platform";
import { errorMessage } from "../../lib/util";
import { Card, Field } from "./Field";

export function TranscriptionSettings() {
  const [s, set] = useSettings();
  const [dl, setDl] = useState<string | null>(null);

  const preload = async () => {
    setDl("Menyiapkan…");
    try {
      const used = await prepareWhisper(s, (l, t) => setDl(t ? `Mengunduh ${Math.round((l / t) * 100)}%` : "Mengunduh…"));
      setDl(`Siap (${used === "webgpu" ? "WebGPU" : "CPU/WASM"})`);
    } catch (e) {
      setDl(`Gagal: ${errorMessage(e)}`);
    }
  };

  return (
    <>
      <Field label="Mesin transkripsi">
        <div className="segmented">
          <button className={s.sttEngine === "browser" ? "active" : ""} onClick={() => set({ sttEngine: "browser" })}>
            Di perangkat (Whisper)
          </button>
          <button className={s.sttEngine === "api" ? "active" : ""} onClick={() => set({ sttEngine: "api" })}>
            Layanan API
          </button>
        </div>
      </Field>
      <Field label="Bahasa rapat" hint="Transkrip ditulis dalam bahasa yang diucapkan, tidak diterjemahkan. Otomatis mendeteksi bahasa setiap potongan ucapan, cocok untuk rapat campuran Indonesia dan Inggris. Memilih satu bahasa membuat bagian berbahasa lain ikut diterjemahkan.">
        <select value={s.sttLanguage} onChange={(e) => set({ sttLanguage: e.target.value })}>
          {STT_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>

      {s.sttEngine === "browser" ? (
        <>
          <Card tone="info">
            Audio tidak pernah meninggalkan perangkat. Model diunduh sekali dari Hugging Face lalu disimpan di browser.
            {!hasWebGPU && " Browser ini tidak mendukung WebGPU, jadi transkripsi memakai CPU (lebih lambat)."}
          </Card>
          <Field label="Model">
            <div className="radio-list">
              {WHISPER_MODELS.map((m) => (
                <label key={m.id} className={s.whisperModel === m.id ? "active" : ""}>
                  <input type="radio" name="model" checked={s.whisperModel === m.id} onChange={() => set({ whisperModel: m.id })} />
                  <div>
                    <b>{m.name}</b> <small>{m.size}</small>
                    <span>{m.note}</span>
                  </div>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Akselerasi">
            <select value={s.whisperDevice} onChange={(e) => set({ whisperDevice: e.target.value as typeof s.whisperDevice })}>
              <option value="auto">Otomatis (WebGPU jika ada)</option>
              <option value="webgpu">WebGPU</option>
              <option value="wasm">CPU (WASM)</option>
            </select>
          </Field>
          <Field
            label="Transkrip langsung saat merekam"
            hint="Disarankan untuk rapat panjang: transkrip sudah hampir selesai saat rapat berakhir. Matikan jika laptop terasa berat selama rapat; transkrip lalu dibuat setelah rekaman selesai."
          >
            <label className="toggle">
              <input type="checkbox" checked={s.liveTranscribe} onChange={(e) => set({ liveTranscribe: e.target.checked })} /> Aktif
            </label>
          </Field>
          <Field label="Unduh model sekarang" hint="Agar rapat pertama langsung bisa ditranskrip, termasuk saat offline.">
            <button className="btn" onClick={preload} disabled={!!dl && dl.startsWith("Mengunduh")}>
              {dl?.startsWith("Mengunduh") || dl === "Menyiapkan…" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
              {dl ?? "Unduh"}
            </button>
          </Field>
        </>
      ) : (
        <>
          <Card tone="warn">Audio rapat dikirim ke layanan yang Anda pilih. Pastikan sesuai kebijakan kantor.</Card>
          <Field label="Base URL (kompatibel OpenAI)" hint="Groq: https://api.groq.com/openai/v1 · OpenAI: https://api.openai.com/v1">
            <input value={s.sttApiBase} onChange={(e) => set({ sttApiBase: e.target.value })} />
          </Field>
          <Field label="API key">
            <input type="password" value={s.sttApiKey} onChange={(e) => set({ sttApiKey: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Model">
            <input value={s.sttApiModel} onChange={(e) => set({ sttApiModel: e.target.value })} placeholder="whisper-large-v3" />
          </Field>
        </>
      )}
    </>
  );
}
