import { useState } from "react";
import { Plus, Star, Trash2 } from "lucide-react";
import { useSettings, useTemplates } from "../../lib/settings";
import type { Template } from "../../lib/types";
import { uid } from "../../lib/util";

function TemplateEditor({ t, onChange, onDelete }: { t: Template; onChange: (t: Template) => void; onDelete: () => void }) {
  return (
    <div className="template-editor">
      <div className="row">
        <input value={t.name} onChange={(e) => onChange({ ...t, name: e.target.value })} placeholder="Nama template" />
        <button className="icon-btn" onClick={onDelete} title="Hapus template">
          <Trash2 size={16} />
        </button>
      </div>
      <input value={t.description} onChange={(e) => onChange({ ...t, description: e.target.value })} placeholder="Kapan dipakai" />
      {t.sections.map((sec, i) => (
        <div className="row" key={i}>
          <input
            value={sec.title}
            placeholder="Judul bagian"
            onChange={(e) => onChange({ ...t, sections: t.sections.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
          />
          <input
            value={sec.hint}
            placeholder="Petunjuk isi"
            onChange={(e) => onChange({ ...t, sections: t.sections.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)) })}
          />
          <button className="icon-btn" onClick={() => onChange({ ...t, sections: t.sections.filter((_, j) => j !== i) })}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-small btn-ghost" onClick={() => onChange({ ...t, sections: [...t.sections, { title: "", hint: "" }] })}>
        <Plus size={14} /> Bagian
      </button>
    </div>
  );
}

export function TemplateSettings() {
  const [s, set] = useSettings();
  const { all, custom, save } = useTemplates();
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <>
      <p className="muted">Template menentukan struktur ringkasan. Bintang menandai template default untuk ringkasan otomatis.</p>
      <div className="template-list">
        {all.map((t) => (
          <div key={t.id} className={`template-row${editing === t.id ? " editing" : ""}`}>
            <button className={`icon-btn${s.defaultTemplateId === t.id ? " star" : ""}`} onClick={() => set({ defaultTemplateId: t.id })} title="Jadikan default">
              <Star size={16} fill={s.defaultTemplateId === t.id ? "currentColor" : "none"} />
            </button>
            <div className="template-info" onClick={() => !t.builtin && setEditing(editing === t.id ? null : t.id)}>
              <b>{t.name}</b>
              <span>{t.description}</span>
              {t.sections.length > 0 && <small>{t.sections.map((x) => x.title).join(" · ")}</small>}
            </div>
            {t.builtin && <span className="tag">bawaan</span>}
            {editing === t.id && !t.builtin && (
              <TemplateEditor
                t={t}
                onChange={(nt) => save(custom.map((x) => (x.id === nt.id ? nt : x)))}
                onDelete={() => {
                  save(custom.filter((x) => x.id !== t.id));
                  if (s.defaultTemplateId === t.id) set({ defaultTemplateId: "auto" });
                }}
              />
            )}
          </div>
        ))}
      </div>
      <button
        className="btn"
        onClick={() => {
          const t: Template = { id: uid("t_"), name: "Template baru", description: "", sections: [{ title: "Ringkasan", hint: "" }] };
          save([...custom, t]);
          setEditing(t.id);
        }}
      >
        <Plus size={14} /> Template baru
      </button>
    </>
  );
}
