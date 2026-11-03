import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, History, X } from "lucide-react";
import type { Mom } from "../../lib/types";
import { emptyMom, getLastForm, newAttendee } from "../../lib/mom";
import { attendanceInfo, attendanceOpen, newAttendance } from "../../lib/attendance";
import { toastError } from "../../lib/toast";
import { AttendeesTable, MeetingInfoFields, PreparedByFields } from "./MomFields";
import { AttendanceQr } from "./AttendanceQr";

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
  const [step, setStep] = useState<"form" | "qr">("form");

  useEffect(() => {
    void getLastForm().then((last) => {
      if (!last) return;
      setHasLast(true);
      if (!initial) setMom((m) => ({ ...m, needSignature: last.needSignature ?? m.needSignature, preparedBy: { ...m.preparedBy, ...last.preparedBy } }));
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

  const cleaned = () => ({ ...mom, attendees: mom.attendees.filter((a) => a.name.trim()) });

  const next = async () => {
    try {
      if (!mom.attendance || !attendanceOpen(mom.attendance)) {
        const attendance = await newAttendance();
        setMom((m) => ({ ...m, attendance }));
      }
      setStep("qr");
    } catch (e) {
      toastError(e);
    }
  };

  if (step === "qr" && mom.attendance)
    return (
      <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <form
          className="modal mom-start"
          role="dialog"
          aria-label="QR absensi"
          onSubmit={(e) => {
            e.preventDefault();
            onStart(cleaned(), title.trim());
          }}
        >
          <header className="modal-head">
            <div>
              <b>QR absensi</b>
              <small>Tampilkan atau bagikan QR ini. Peserta scan dengan kamera HP lalu mengisi daftar hadir.</small>
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Tutup">
              <X size={18} />
            </button>
          </header>
          <div className="modal-body">
            <AttendanceQr attendance={mom.attendance} info={attendanceInfo(mom, title)} />
          </div>
          <footer className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setStep("form")}>
              <ArrowLeft size={15} /> Kembali
            </button>
            <button type="submit" className="btn btn-record" autoFocus>
              <span className="rec-dot" /> Mulai rekam
            </button>
          </footer>
        </form>
      </div>
    );

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal mom-start"
        role="dialog"
        aria-label="Informasi rapat"
        onSubmit={(e) => {
          e.preventDefault();
          void next();
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
          <label className="toggle mom-sign-toggle">
            <input type="checkbox" checked={mom.needSignature !== false} onChange={(e) => patch((m) => void (m.needSignature = e.target.checked))} />
            <span>
              <b>Peserta wajib tanda tangan</b>
              <small>Form absensi lewat QR akan menampilkan kolom tanda tangan (tulis manual atau unggah gambar). Bila tidak dicentang, peserta cukup mengisi data diri.</small>
            </span>
          </label>
          <h4>Disusun oleh</h4>
          <PreparedByFields mom={mom} patch={patch} />
          <p className="muted small-note">Setelah klik Lanjut, Notesy membuat QR absensi untuk peserta. Tanda tangan penyusun bisa diisi di tab MoM.</p>
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onSkip}>
            Lewati
          </button>
          <button type="submit" className="btn btn-primary">
            Lanjut <ArrowRight size={15} />
          </button>
        </footer>
      </form>
    </div>
  );
}
