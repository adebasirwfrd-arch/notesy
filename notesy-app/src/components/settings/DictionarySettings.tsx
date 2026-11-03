import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useDictionary } from "../../lib/settings";
import { uid } from "../../lib/util";

export function DictionarySettings() {
  const [dict, setDict] = useDictionary();
  const [term, setTerm] = useState("");
  const [aliases, setAliases] = useState("");

  const add = () => {
    if (!term.trim()) return;
    setDict([
      ...dict,
      {
        id: uid("d_"),
        term: term.trim(),
        aliases: aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      },
    ]);
    setTerm("");
    setAliases("");
  };

  return (
    <>
      <p className="muted">
        Nama orang, produk, singkatan, dan istilah kantor. Ejaan salah dari transkrip otomatis diganti dengan istilah yang benar, dan AI diberi tahu
        ejaan resminya.
      </p>
      <div className="dict-add">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Istilah benar, mis. Karhutla" onKeyDown={(e) => e.key === "Enter" && add()} />
        <input
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
          placeholder="Ejaan salah, pisahkan koma: kar hutla, karhut la"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary" onClick={add} disabled={!term.trim()}>
          <Plus size={14} /> Tambah
        </button>
      </div>
      <table className="dict-table">
        <thead>
          <tr>
            <th>Istilah</th>
            <th>Dikoreksi dari</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dict.map((d) => (
            <tr key={d.id}>
              <td>
                <input value={d.term} onChange={(e) => setDict(dict.map((x) => (x.id === d.id ? { ...x, term: e.target.value } : x)))} />
              </td>
              <td>
                <input
                  defaultValue={d.aliases.join(", ")}
                  onBlur={(e) =>
                    setDict(
                      dict.map((x) =>
                        x.id === d.id
                          ? {
                              ...x,
                              aliases: e.target.value
                                .split(",")
                                .map((a) => a.trim())
                                .filter(Boolean),
                            }
                          : x,
                      ),
                    )
                  }
                />
              </td>
              <td>
                <button className="icon-btn" onClick={() => setDict(dict.filter((x) => x.id !== d.id))}>
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
          {!dict.length && (
            <tr>
              <td colSpan={3} className="muted">
                Kamus masih kosong.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
