import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { Briefcase, Building2, CalendarDays, CircleCheck, IdCard, Loader2, MapPin, PenLine, Target, User, X } from "lucide-react";
import { SignaturePad } from "../components/SignaturePad";
import { Toasts } from "../components/Toasts";
import type { Signature } from "../lib/types";
import "../styles.css";
import "./attend.css";

interface Meeting {
  title: string;
  date: string;
  location: string;
  facilitator: string;
  needSignature: boolean;
  closed: boolean;
}

interface Profile {
  name: string;
  empNo: string;
  title: string;
  company: string;
}

const PROFILE_KEY = "notesy-att-profile";
const id = new URLSearchParams(location.search).get("i") ?? "";
const doneKey = `notesy-att-done-${id}`;

const readLocal = <T,>(key: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
};

async function api<T>(init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/attendance?id=${encodeURIComponent(id)}`, { ...init, cache: "no-store" });
  } catch {
    throw new Error("Tidak ada koneksi internet. Periksa sinyal lalu coba lagi.");
  }
  const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res.ok) throw new Error(body?.message ?? `Gagal (${res.status}). Coba lagi.`);
  return body as T;
}

/** Keeps the upload small: the thin strokes stay crisp at 900px wide, which is far more than the MoM cell needs. */
async function shrink(sig: Signature): Promise<Signature> {
  const max = 900;
  if (sig.width <= max && sig.dataUrl.length < 300_000) return sig;
  const img = new Image();
  img.src = sig.dataUrl;
  await img.decode();
  const scale = Math.min(1, max / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { ...sig, dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

function Field({ label, icon, value, onChange, placeholder, autoComplete, required }: { label: string; icon: React.ReactNode; value: string; onChange: (v: string) => void; placeholder: string; autoComplete?: string; required?: boolean }) {
  return (
    <label className="att-field">
      <span className="att-label">{label}</span>
      <span className="att-input">
        {icon}
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} required={required} />
      </span>
    </label>
  );
}

function App() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState<Profile>(() => readLocal<Profile>(PROFILE_KEY) ?? { name: "", empNo: "", title: "", company: "" });
  const [signature, setSignature] = useState<Signature | null>(null);
  const [signing, setSigning] = useState(false);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState("");
  const [done, setDone] = useState<{ name: string; at: number } | null>(() => readLocal(doneKey));

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) {
      setError("Link absensi tidak lengkap. Scan ulang QR dari penyelenggara rapat.");
      return;
    }
    api<Meeting>().then(setMeeting, (e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (meeting?.title) document.title = `Attendance · ${meeting.title}`;
  }, [meeting?.title]);

  const set = (k: keyof Profile) => (v: string) => setProfile((p) => ({ ...p, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!profile.name.trim()) return setFormError("Nama lengkap wajib diisi.");
    if (meeting?.needSignature && !signature) return setFormError("Tanda tangan wajib diisi. Ketuk kotak tanda tangan.");
    setSending(true);
    try {
      const sig = signature ? await shrink(signature) : undefined;
      await api({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...profile, signature: sig }) });
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      const record = { name: profile.name.trim(), at: Date.now() };
      localStorage.setItem(doneKey, JSON.stringify(record));
      setDone(record);
      setSignature(null);
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const header = meeting && (
    <>
      <span className="att-badge">ATTENDANCE FORM</span>
      <h1 className="att-title">{meeting.title}</h1>
      <div className="att-card att-info">
        {meeting.date && (
          <span>
            <CalendarDays size={17} /> {meeting.date}
          </span>
        )}
        {meeting.location && (
          <span>
            <MapPin size={17} /> {meeting.location}
          </span>
        )}
        {meeting.facilitator && (
          <span className="wide">
            <Target size={17} /> {meeting.facilitator}
          </span>
        )}
      </div>
    </>
  );

  return (
    <main className="att-page">
      {!meeting && !error && (
        <div className="att-center">
          <Loader2 size={28} className="spin" />
        </div>
      )}
      {error && (
        <div className="att-center">
          <div className="att-card att-message">
            <X size={30} className="att-bad" />
            <b>Absensi tidak dapat dibuka</b>
            <p>{error}</p>
          </div>
        </div>
      )}
      {meeting && header}
      {meeting && meeting.closed && (
        <div className="att-card att-message">
          <b>Absensi sudah ditutup</b>
          <p>Hubungi penyelenggara rapat bila Anda belum tercatat.</p>
        </div>
      )}
      {meeting && !meeting.closed && done && (
        <div className="att-card att-message">
          <CircleCheck size={40} className="att-ok" />
          <b>Terima kasih, {done.name}!</b>
          <p>Kehadiran Anda sudah tercatat pada {new Date(done.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}.</p>
          <button
            className="att-link"
            onClick={() => {
              localStorage.removeItem(doneKey);
              setDone(null);
              setProfile({ name: "", empNo: "", title: "", company: "" });
            }}
          >
            Isi untuk peserta lain di HP ini
          </button>
        </div>
      )}
      {meeting && !meeting.closed && !done && (
        <form className="att-card att-form" onSubmit={submit} noValidate>
          <Field label="FULL NAME" icon={<User size={18} />} value={profile.name} onChange={set("name")} placeholder="Enter your name" autoComplete="name" required />
          <Field label="# EMPLOYEE NUMBER" icon={<IdCard size={18} />} value={profile.empNo} onChange={set("empNo")} placeholder="Enter employee number" />
          <Field label="TITLE / POSITION" icon={<Briefcase size={18} />} value={profile.title} onChange={set("title")} placeholder="e.g. Safety Officer" autoComplete="organization-title" />
          <Field label="COMPANY / DIVISION" icon={<Building2 size={18} />} value={profile.company} onChange={set("company")} placeholder="e.g. Operations" autoComplete="organization" />
          {meeting.needSignature && (
            <div className="att-field">
              <span className="att-label">SIGNATURE</span>
              <button type="button" className={`att-sign${signature ? " has" : ""}`} onClick={() => setSigning(true)}>
                {signature ? (
                  <img src={signature.dataUrl} alt="Tanda tangan" />
                ) : (
                  <span>
                    <PenLine size={18} /> Ketuk untuk tanda tangan atau unggah gambar
                  </span>
                )}
              </button>
              {signature && (
                <button type="button" className="att-link small" onClick={() => setSignature(null)}>
                  Hapus tanda tangan
                </button>
              )}
            </div>
          )}
          {formError && <p className="att-error">{formError}</p>}
          <button type="submit" className="att-submit" disabled={sending}>
            {sending ? <Loader2 size={20} className="spin" /> : "SUBMIT ATTENDANCE"}
          </button>
        </form>
      )}
      <footer className="att-foot">Notesy · Data hanya diteruskan ke penyelenggara rapat.</footer>
      {signing &&
        createPortal(
          <SignaturePad
            name={profile.name}
            onClose={() => setSigning(false)}
            onSave={(s) => {
              setSignature(s);
              setSigning(false);
            }}
          />,
          document.body,
        )}
      <Toasts />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
