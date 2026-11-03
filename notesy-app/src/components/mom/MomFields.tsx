import { useState } from "react";
import { createPortal } from "react-dom";
import { PenLine, Plus, Trash2, X } from "lucide-react";
import type { Mom, MomAttendee, Signature } from "../../lib/types";
import { newAttendee } from "../../lib/mom";
import { SignaturePad } from "../SignaturePad";

type Patch = (fn: (m: Mom) => void) => void;

export function SignatureCell({ sig, name, onChange }: { sig?: Signature; name: string; onChange: (s: Signature | undefined) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {sig ? (
        <div className="sig-preview">
          <button className="sig-img" onClick={() => setOpen(true)} title="Ganti tanda tangan">
            <img src={sig.dataUrl} alt={`Tanda tangan ${name}`} />
          </button>
          <button className="icon-btn" onClick={() => onChange(undefined)} title="Hapus tanda tangan" aria-label="Hapus tanda tangan">
            <X size={14} />
          </button>
        </div>
      ) : (
        <button className="btn btn-small sig-btn" onClick={() => setOpen(true)}>
          <PenLine size={14} /> Tanda tangan
        </button>
      )}
      {open &&
        createPortal(
          <SignaturePad
            name={name}
            onClose={() => setOpen(false)}
            onSave={(s) => {
              onChange(s);
              setOpen(false);
            }}
          />,
          document.body,
        )}
    </>
  );
}

export function MeetingInfoFields({ mom, patch, placeholders }: { mom: Mom; patch: Patch; placeholders?: { date: string; time: string } }) {
  return (
    <div className="mom-grid">
      {placeholders && (
        <>
          <label>
            <span>Date</span>
            <input value={mom.date} placeholder={placeholders.date} onChange={(e) => patch((m) => void (m.date = e.target.value))} />
          </label>
          <label>
            <span>Time</span>
            <input value={mom.time} placeholder={placeholders.time} onChange={(e) => patch((m) => void (m.time = e.target.value))} />
          </label>
        </>
      )}
      <label>
        <span>Location</span>
        <input value={mom.location} placeholder="mis. Ruang Rapat Lt. 3 / Zoom" onChange={(e) => patch((m) => void (m.location = e.target.value))} />
      </label>
      <label>
        <span>Facilitator</span>
        <input value={mom.facilitator} placeholder="Nama pemimpin rapat" onChange={(e) => patch((m) => void (m.facilitator = e.target.value))} />
      </label>
    </div>
  );
}

export function PreparedByFields({ mom, patch, withSignature }: { mom: Mom; patch: Patch; withSignature?: boolean }) {
  return (
    <div className="mom-grid">
      <label>
        <span>Prepared by — Name</span>
        <input value={mom.preparedBy.name} placeholder="Nama penyusun MoM" onChange={(e) => patch((m) => void (m.preparedBy.name = e.target.value))} />
      </label>
      <label>
        <span>Position</span>
        <input value={mom.preparedBy.position} placeholder="Jabatan" onChange={(e) => patch((m) => void (m.preparedBy.position = e.target.value))} />
      </label>
      {withSignature && (
        <div className="mom-sign-field">
          <span>Signature</span>
          <SignatureCell
            sig={mom.preparedBy.signature}
            name={mom.preparedBy.name}
            onChange={(s) =>
              patch((m) => {
                m.preparedBy.signature = s;
              })
            }
          />
        </div>
      )}
    </div>
  );
}

export function AttendeesTable({ mom, patch, withSignature }: { mom: Mom; patch: Patch; withSignature?: boolean }) {
  const set = (id: string, fn: (a: MomAttendee) => void) =>
    patch((m) => {
      const a = m.attendees.find((x) => x.id === id);
      if (a) fn(a);
    });
  return (
    <div className="mom-attendees">
      {mom.attendees.length === 0 && <p className="muted small-note">Belum ada peserta. Tambahkan nama peserta yang hadir.</p>}
      {mom.attendees.map((a, i) => (
        <div className="attendee-row" key={a.id}>
          <span className="attendee-no">{i + 1}.</span>
          <input className="a-name" value={a.name} placeholder="Print name" onChange={(e) => set(a.id, (x) => void (x.name = e.target.value))} />
          <input className="a-company" value={a.company} placeholder="Company" onChange={(e) => set(a.id, (x) => void (x.company = e.target.value))} />
          <input className="a-emp" value={a.empNo} placeholder="Emp #" onChange={(e) => set(a.id, (x) => void (x.empNo = e.target.value))} />
          <input className="a-title" value={a.title} placeholder="Title/Position" onChange={(e) => set(a.id, (x) => void (x.title = e.target.value))} />
          {withSignature && (
            <div className="a-sign">
              <SignatureCell sig={a.signature} name={a.name} onChange={(s) => set(a.id, (x) => void (x.signature = s))} />
            </div>
          )}
          <button className="icon-btn" onClick={() => patch((m) => void (m.attendees = m.attendees.filter((x) => x.id !== a.id)))} aria-label="Hapus peserta" title="Hapus peserta">
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button className="btn btn-small" onClick={() => patch((m) => void m.attendees.push(newAttendee()))}>
        <Plus size={14} /> Tambah peserta
      </button>
    </div>
  );
}
