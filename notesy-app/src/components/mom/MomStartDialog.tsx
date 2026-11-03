import { useEffect, useState } from "react";
import { History, X } from "lucide-react";
import type { Mom } from "../../lib/types";
import { emptyMom, getLastForm, newAttendee } from "../../lib/mom";
import { AttendeesTable, MeetingInfoFields, PreparedByFields } from "./MomFields";

interface Props {
  initial?: Mom;
  title: string;
  onStart: (mom: Mom, title: string) => void;
  onSkip: () => void;
  onClose: () => void;
}

/** Shown before every new recording so the MoM header and roster are ready when the meeting ends. */
export function MomStartDialog({ initial, title: initialTitle, onStart, onSkip, onClose }: Props) {
  const [mom, setMom] = useState<Mom>(() => structuredClone(initial ?? emptyMom()));
  const [title, setTitle] = useState(initialTitle);
  const [hasLast, setHasLast] = useState(false);

  useEffect(() => {
    void getLastForm().then((last) => {
      if (!last) return;
      setHasLast(true);
      if (!initial) setMom((m) => ({ ...m, preparedBy: { ...m.preparedBy, ...last.preparedBy } }));
    });
  }, [initial]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patch = (fn: (m: Mom) => void) =>
    setMom((m) => {
      const next = structuredClone(m);
      fn(next);
      return next;
    });

  const useLast = async () => {
    const last = await getLastForm();
    if (!last) return;
    setMom((m) => ({
      ...m,
      location: last.location,
      facilitator: last.facilitator,
      attendees: last.attendees.map((a) => newAttendee({ name: a.name, company: a.company, empNo: a.empNo, title: a.title })),
      preparedBy: { ...m.preparedBy, ...last.preparedBy },
    }));
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal mom-start"
        role="dialog"
        aria-label="Informasi rapat"
        onSubmit={(e) => {
          e.preventDefault();
          onStart({ ...mom, attendees: mom.attendees.filter((a) => a.name.trim()) }, title.trim());
        }}
      >
        <header className="modal-head">
          <div>
            <b>Informasi rapat (MoM)</b>
            <small>Diisi sebelum rekam agar MoM langsung lengkap. Poin pembahasan diisi otomatis oleh AI setelah rapat.</small>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Tutup">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <label className="mom-title-field">
            <span>Judul rapat</span>
            <input value={title} placeholder="Otomatis dari isi rapat bila dikosongkan" onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>
          <MeetingInfoFields mom={mom} patch={patch} />
          <div className="mom-section-head">
            <h4>Peserta (daftar hadir)</h4>
            {hasLast && (
              <button type="button" className="btn btn-small btn-ghost" onClick={useLast}>
                <History size={14} /> Pakai data rapat terakhir
              </button>
            )}
          </div>
          <AttendeesTable mom={mom} patch={patch} />
          <h4>Disusun oleh</h4>
          <PreparedByFields mom={mom} patch={patch} />
          <p className="muted small-note">Tanda tangan peserta dan penyusun bisa diisi di tab MoM setelah rapat (tulis manual atau unggah gambar).</p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onSkip}>
            Lewati
          </button>
          <button type="submit" className="btn btn-record">
            <span className="rec-dot" /> Mulai rekam
          </button>
        </footer>
      </form>
    </div>
  );
}
