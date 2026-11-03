import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, PlugZap, XCircle } from "lucide-react";
import { useSettings } from "../../lib/settings";
import { testConnection } from "../../lib/ai";
import type { CursorModel } from "../../lib/ai/cursor";
import { ensureHostPermission } from "../../lib/platform";
import { errorMessage } from "../../lib/util";
import { Card, Field, Toggle } from "./Field";

type Status = { kind: "idle" } | { kind: "testing" } | { kind: "ok"; who: string } | { kind: "error"; message: string };

export function IntelligenceSettings() {
  const [s, set] = useSettings();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [models, setModels] = useState<CursorModel[]>([]);
  const [keyDraft, setKeyDraft] = useState(s.cursorApiKey);

  const test = async (override?: Partial<typeof s>) => {
    const cfg = { ...s, ...override };
    setStatus({ kind: "testing" });
    try {
      if (cfg.aiProvider === "openai") await ensureHostPermission(cfg.openaiBase);
      const r = await testConnection(cfg);
      setModels(r.models);
      setStatus({ kind: "ok", who: r.who ?? "terhubung" });
    } catch (e) {
      setStatus({ kind: "error", message: errorMessage(e) });
    }
  };

  const keyInput = useRef<HTMLInputElement>(null);
  const connect = () => {
    const key = (keyInput.current?.value ?? keyDraft).trim();
    if (!key) return;
    setKeyDraft(key);
    set({ cursorApiKey: key });
    void test({ cursorApiKey: key });
  };

  useEffect(() => {
    if ((s.aiProvider === "cursor" && s.cursorApiKey) || (s.aiProvider === "openai" && s.openaiBase)) void test();
  }, [s.aiProvider]);

  return (
    <>
      <Field label="Penyedia AI">
        <div className="segmented">
          <button className={s.aiProvider === "cursor" ? "active" : ""} onClick={() => set({ aiProvider: "cursor" })}>
            Cursor (disarankan)
          </button>
          <button className={s.aiProvider === "openai" ? "active" : ""} onClick={() => set({ aiProvider: "openai" })}>
            Kompatibel OpenAI
          </button>
        </div>
      </Field>

      {s.aiProvider === "cursor" ? (
        <>
          <Card tone="info">
            <b>Pakai langganan Cursor Anda sebagai AI.</b> Notesy menjalankan agent Cursor di cloud untuk membaca slide, menyusun ringkasan,
            dan menjawab pertanyaan, jadi MacBook tidak perlu menyala. Cukup isi API key sekali. Setelah itu Notesy otomatis terhubung setiap kali dibuka.
            <ol>
              <li>
                Buka{" "}
                <a href="https://cursor.com/dashboard/integrations" target="_blank" rel="noreferrer">
                  cursor.com/dashboard → Integrations <ExternalLink size={12} />
                </a>
              </li>
              <li>
                Di bagian <b>API Keys</b>, klik <b>Create API key</b>, beri nama “Notesy”, lalu salin.
              </li>
              <li>Tempel di bawah, lalu klik Hubungkan.</li>
            </ol>
            <small>
              Pemakaian dihitung ke kuota akun Cursor Anda, sama seperti agent biasa. Kalau key sudah disimpan di server Notesy, cukup isi kode akses.
            </small>
          </Card>
          <Field label="Cursor API key atau kode akses">
            <div className="row">
              <input
                ref={keyInput}
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && connect()}
                placeholder="crsr_… atau kode akses"
                autoComplete="off"
              />
              <button className="btn btn-primary" disabled={status.kind === "testing"} onClick={connect}>
                <PlugZap size={14} /> Hubungkan
              </button>
            </div>
          </Field>
          <Field label="Model" hint="Kosongkan untuk memakai model default akun Cursor Anda.">
            <select value={s.cursorModel} onChange={(e) => set({ cursorModel: e.target.value })}>
              <option value="">Default akun Cursor</option>
              {s.cursorModel && !models.some((m) => m.id === s.cursorModel) && <option value={s.cursorModel}>{s.cursorModel}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </Field>
        </>
      ) : (
        <>
          <Card tone="info">Untuk OpenAI, Groq, OpenRouter, LM Studio, atau Ollama (endpoint /v1). Model harus mendukung gambar agar slide bisa dibaca.</Card>
          <Field label="Base URL">
            <input value={s.openaiBase} onChange={(e) => set({ openaiBase: e.target.value })} />
          </Field>
          <Field label="API key">
            <input type="password" value={s.openaiKey} onChange={(e) => set({ openaiKey: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Model">
            <input value={s.openaiModel} onChange={(e) => set({ openaiModel: e.target.value })} />
          </Field>
          <Field label="Uji koneksi">
            <button className="btn" onClick={() => test()} disabled={status.kind === "testing"}>
              <PlugZap size={14} /> Uji
            </button>
          </Field>
        </>
      )}

      <div className={`connection connection-${status.kind}`}>
        {status.kind === "testing" && (
          <>
            <Loader2 size={16} className="spin" /> Menghubungkan…
          </>
        )}
        {status.kind === "ok" && (
          <>
            <CheckCircle2 size={16} /> Terhubung{status.who ? `: ${status.who}` : ""}
          </>
        )}
        {status.kind === "error" && (
          <>
            <XCircle size={16} /> {status.message}
          </>
        )}
      </div>

      <Field label="Jelaskan tangkapan layar" hint="AI melihat setiap slide dan menuliskan penjelasannya di ringkasan.">
        <Toggle checked={s.describeSlides} onChange={(v) => set({ describeSlides: v })} />
      </Field>
      <Field label="Instruksi tambahan" hint="Berlaku untuk semua ringkasan, mis. “Selalu sebut angka anggaran” atau “Pakai istilah KPI”.">
        <textarea rows={3} value={s.extraInstructions} onChange={(e) => set({ extraInstructions: e.target.value })} />
      </Field>
    </>
  );
}
