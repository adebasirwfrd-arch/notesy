import { useEffect, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { storageEstimate } from "../../lib/db";
import { exportBackup, importBackup } from "../../lib/export";
import { download } from "../../lib/util";
import { toast, toastError } from "../../lib/toast";
import { TARGET } from "../../lib/platform";
import { Field } from "./Field";

const mb = (n?: number) => (n ? `${(n / 1024 / 1024).toFixed(0)} MB` : "-");

export function DataSettings() {
  const [est, setEst] = useState<StorageEstimate | null>(null);
  const [withAudio, setWithAudio] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    storageEstimate().then(setEst);
  }, []);

  return (
    <>
      <Field label="Penyimpanan" hint="Rapat, audio, dan slide disimpan di browser/perangkat ini saja.">
        <span>
          {mb(est?.usage)} terpakai{est?.quota ? ` dari ${mb(est.quota)}` : ""}
        </span>
      </Field>
      <Field label="Cadangkan" hint="File JSON berisi semua rapat, memo, ringkasan, transkrip, dan slide.">
        <div className="row">
          <label className="toggle small">
            <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} /> sertakan audio (besar)
          </label>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                download(`notesy-backup-${new Date().toISOString().slice(0, 10)}.json`, await exportBackup(withAudio));
              } catch (e) {
                toastError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Download size={14} /> Ekspor
          </button>
        </div>
      </Field>
      <Field label="Pulihkan" hint="Gabungkan cadangan dari perangkat lain (mis. dari laptop kantor ke Android).">
        <button className="btn" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Impor cadangan
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              toast(`${await importBackup(f)} rapat dipulihkan`, "success");
            } catch (err) {
              toastError(err);
            }
          }}
        />
      </Field>
      <Field label="Versi">
        <span className="muted">
          Notesy 0.1.0 · {TARGET === "extension" ? "Chrome extension" : TARGET === "android" ? "Android" : "Web"}
        </span>
      </Field>
    </>
  );
}
