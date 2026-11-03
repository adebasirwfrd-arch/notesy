import { useSettings } from "../../lib/settings";
import { Field, Toggle } from "./Field";

export function GeneralSettings() {
  const [s, set] = useSettings();
  return (
    <>
      <Field label="Nama Anda" hint="Dipakai AI untuk menyebut Anda di ringkasan dan tindak lanjut.">
        <input value={s.displayName} onChange={(e) => set({ displayName: e.target.value })} placeholder="mis. Izza" />
      </Field>
      <Field label="Label suara Anda" hint="Nama untuk kanal mikrofon di transkrip.">
        <input value={s.meLabel} onChange={(e) => set({ meLabel: e.target.value })} />
      </Field>
      <Field label="Label suara peserta" hint="Nama untuk kanal audio sistem (Teams/Zoom).">
        <input value={s.othersLabel} onChange={(e) => set({ othersLabel: e.target.value })} />
      </Field>
      <Field label="Bahasa ringkasan">
        <select value={s.summaryLanguage} onChange={(e) => set({ summaryLanguage: e.target.value })}>
          <option>Bahasa Indonesia</option>
          <option>English</option>
          <option value="bahasa yang sama dengan rapat">Ikuti bahasa rapat</option>
        </select>
      </Field>
      <Field label="Ringkas otomatis" hint="Setelah rekaman selesai dan transkrip jadi, AI langsung membuat ringkasan.">
        <Toggle checked={s.autoSummarize} onChange={(v) => set({ autoSummarize: v })} />
      </Field>
      <Field label="Judul otomatis" hint="AI mengganti judul sementara dengan judul yang spesifik.">
        <Toggle checked={s.autoTitle} onChange={(v) => set({ autoTitle: v })} />
      </Field>
    </>
  );
}
