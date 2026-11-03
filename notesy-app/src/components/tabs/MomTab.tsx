import { useEffect, useRef, useState } from "react";
import { Check, FileDown, FileText, Loader2, Plus, QrCode, RefreshCw, Sparkles, Trash2, Upload, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { Mom, Note, Slide } from "../../lib/types";
import { getNote, updateNote } from "../../lib/db";
import { EVIDENCE_SLOTS, emptyMom, evidenceName, evidenceSlides, meetingDate, meetingTime, momTemplateName, onMomTemplateChange, setMomTemplate, summaryMarkdown } from "../../lib/mom";
import { downloadMom } from "../../lib/mom/export";
import { aiConfigured, generateMomItems } from "../../lib/ai";
import { isProcessing } from "../../lib/session";
import { useBlobUrl } from "../../lib/hooks";
import { toast, toastError } from "../../lib/toast";
import { formatClock, uid } from "../../lib/util";
import { AttendeesTable, MeetingInfoFields, PreparedByFields } from "../mom/MomFields";
import { AttendanceQr } from "../mom/AttendanceQr";
import { attendanceInfo, attendanceOpen, newAttendance, publishAttendance, syncAttendance } from "../../lib/attendance";

const STATUSES = ["Open", "In Progress", "Closed", "Info"];

function Thumb({ slide }: { slide: Slide }) {
  const url = useBlobUrl(slide.blobKey);
  return url ? <img src={url} alt={evidenceName(slide)} /> : <span className="slide-missing" />;
}

function TemplateCard() {
  const [name, setName] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () => void momTemplateName().then((n) => setName(n ?? null));
    load();
    const off = onMomTemplateChange(load);
    return () => void off();
  }, []);
  const pick = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      await setMomTemplate(file);
      toast("Template MoM tersimpan di perangkat ini.", "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (name === undefined) return null;
  return (
    <div className={`card ${name ? "" : "card-warn"} mom-template`}>
      <FileText size={16} />
      <div>
        {name ? (
          <>
            Template: <b>{name}</b>
          </>
        ) : (
          <>
            <b>Unggah template MoM sekali di perangkat ini.</b>
            <small>Pilih file “MoM Roster Meeting.docx”. Template disimpan hanya di perangkat ini, tidak diunggah ke server.</small>
          </>
        )}
      </div>
      <label className={`btn btn-small${name ? "" : " btn-primary"}`}>
        {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} {name ? "Ganti" : "Unggah template"}
        <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </label>
    </div>
  );
}

export function MomTab({ note, slides }: { note: Note; slides: Slide[] }) {
  const [draft, setDraft] = useState<Mom>(() => structuredClone(note.mom ?? emptyMom()));
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState<"docx" | "pdf" | "ai" | "sync" | null>(null);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (dirty.current) return;
    const next = structuredClone(note.mom ?? emptyMom());
    draftRef.current = next;
    setDraft(next);
  }, [note.mom]);

  const write = async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = draftRef.current;
    await updateNote(note.id, (n) => void (n.mom = value));
    if (draftRef.current === value) dirty.current = false;
  };

  useEffect(
    () => () => {
      if (timer.current) void write();
    },
    [],
  );

  const patch = (fn: (m: Mom) => void, items = false) => {
    const next = structuredClone(draftRef.current);
    fn(next);
    if (items) next.itemsEdited = true;
    draftRef.current = next;
    dirty.current = true;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void write(), 400);
  };

  const download = async (kind: "docx" | "pdf") => {
    setBusy(kind);
    try {
      await write();
      await downloadMom((await getNote(note.id))!, kind);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    if (draft.items.length && draft.itemsEdited && !confirm("Poin pembahasan yang sudah Anda edit akan diganti hasil AI. Lanjutkan?")) return;
    setBusy("ai");
    try {
      await write();
      await generateMomItems(note.id);
      toast("Poin pembahasan disusun ulang oleh AI.", "success");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  const info = attendanceInfo(draft, note.titleIsAuto ? "" : note.title, note);
  const infoKey = JSON.stringify(info);
  const published = useRef(infoKey);
  const attendance = draft.attendance;
  useEffect(() => {
    if (!attendance || !attendanceOpen(attendance) || published.current === infoKey) return;
    const t = setTimeout(() => {
      published.current = infoKey;
      publishAttendance(attendance, info).catch(() => (published.current = ""));
    }, 1500);
    return () => clearTimeout(t);
  }, [attendance?.key, infoKey]);

  const openQr = async () => {
    if (!attendance || !attendanceOpen(attendance)) {
      const next = await newAttendance();
      patch((m) => void (m.attendance = next));
    }
    published.current = infoKey;
    setShowQr(true);
  };

  const refreshAttendance = async () => {
    setBusy("sync");
    try {
      await write();
      const n = await syncAttendance(note.id);
      toast(n ? `${n} peserta dari QR ditambahkan.` : "Belum ada peserta baru dari QR.", n ? "success" : "info");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const fromQr = draft.attendees.filter((a) => a.source).length;

  const evidence = evidenceSlides(draft, slides);
  const chosen = new Set(evidence.map((s) => s.id));
  const toggleEvidence = (id: string) =>
    patch((m) => {
      const ids = evidenceSlides(m, slides).map((s) => s.id);
      m.evidenceSlideIds = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
    });
  const hasSummary = !!summaryMarkdown(note);
  const processing = isProcessing(note.id);

  return (
    <div className="mom-tab">
      <TemplateCard />
      <div className="mom-actions">
        <button className="btn btn-primary" disabled={!!busy} onClick={() => download("docx")}>
          {busy === "docx" ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />} Unduh Word
        </button>
        <button className="btn" disabled={!!busy} onClick={() => download("pdf")}>
          {busy === "pdf" ? <Loader2 size={15} className="spin" /> : <FileDown size={15} />} Unduh PDF
        </button>
      </div>

      <section className="mom-section">
        <h3>Informasi rapat</h3>
        <MeetingInfoFields mom={draft} patch={patch} placeholders={{ date: meetingDate(note), time: meetingTime(note) }} />
      </section>

      <section className="mom-section">
        <div className="mom-section-head">
          <h3>Key points covered</h3>
          <button className="btn btn-small" disabled={!!busy || processing || !aiConfigured() || (!note.transcript.length && !note.memo.trim())} onClick={regenerate}>
            {busy === "ai" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {draft.items.length ? "Susun ulang dengan AI" : "Susun dengan AI"}
          </button>
        </div>
        {!draft.items.length && (
          <p className="muted small-note">
            {processing ? "AI akan mengisi poin pembahasan setelah transkrip dan ringkasan selesai." : "Belum ada poin. Klik “Susun dengan AI” atau tambahkan manual."}
          </p>
        )}
        <div className="mom-items">
          {draft.items.length > 0 && (
            <div className="mom-item head">
              <span>No</span>
              <span>Description</span>
              <span>PIC</span>
              <span>Status</span>
              <span />
            </div>
          )}
          {draft.items.map((it, i) => (
            <div className="mom-item" key={it.id}>
              <span className="mom-no">{i + 1}</span>
              <textarea
                rows={2}
                value={it.description}
                onChange={(e) => patch((m) => void (m.items[i].description = e.target.value), true)}
                ref={(el) => {
                  if (el) {
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight + 2}px`;
                  }
                }}
              />
              <input value={it.pic} placeholder="PIC" onChange={(e) => patch((m) => void (m.items[i].pic = e.target.value), true)} />
              <input list="mom-status" value={it.status} placeholder="Status" onChange={(e) => patch((m) => void (m.items[i].status = e.target.value), true)} />
              <button className="icon-btn" aria-label="Hapus poin" title="Hapus poin" onClick={() => patch((m) => void m.items.splice(i, 1), true)}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <datalist id="mom-status">
            {STATUSES.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button className="btn btn-small" onClick={() => patch((m) => void m.items.push({ id: uid("k_"), description: "", pic: "-", status: "Open" }), true)}>
            <Plus size={14} /> Tambah poin
          </button>
        </div>
      </section>

      <section className="mom-section">
        <div className="mom-section-head">
          <h3>Daftar hadir & tanda tangan</h3>
          <div className="row">
            {attendance && (
              <button className="btn btn-small btn-ghost" disabled={!!busy} onClick={refreshAttendance}>
                {busy === "sync" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Muat absensi
              </button>
            )}
            <button className="btn btn-small" onClick={openQr}>
              <QrCode size={14} /> QR absensi
            </button>
          </div>
        </div>
        <label className="toggle mom-sign-toggle">
          <input type="checkbox" checked={draft.needSignature !== false} onChange={(e) => patch((m) => void (m.needSignature = e.target.checked))} />
          <span>
            <b>Peserta wajib tanda tangan</b>
            <small>{attendance ? `Form absensi QR ${draft.needSignature !== false ? "meminta" : "tidak meminta"} tanda tangan.` : "Berlaku untuk form absensi QR."}{fromQr ? ` ${fromQr} peserta mengisi lewat QR.` : ""}</small>
          </span>
        </label>
        <AttendeesTable mom={draft} patch={patch} withSignature={draft.needSignature !== false} />
      </section>

      <section className="mom-section">
        <h3>Prepared by</h3>
        <PreparedByFields mom={draft} patch={patch} withSignature />
      </section>

      <section className="mom-section">
        <div className="mom-section-head">
          <h3>Evidence</h3>
          {draft.evidenceSlideIds && (
            <button className="btn btn-small btn-ghost" onClick={() => patch((m) => void delete m.evidenceSlideIds)}>
              Pilih otomatis
            </button>
          )}
        </div>
        {slides.length ? (
          <>
            <p className="muted small-note">
              Klik gambar untuk memilih bukti. Template berisi {EVIDENCE_SLOTS} kotak; bila lebih, baris bukti ditambah otomatis. Terpilih: {evidence.length}.
            </p>
            <div className="evidence-grid">
              {slides.map((s) => (
                <button key={s.id} className={`evidence-card${chosen.has(s.id) ? " chosen" : ""}${s.excluded ? " excluded" : ""}`} onClick={() => toggleEvidence(s.id)}>
                  <Thumb slide={s} />
                  {chosen.has(s.id) && (
                    <span className="evidence-check">
                      <Check size={13} />
                    </span>
                  )}
                  <small>
                    {formatClock(s.t)} · {evidenceName(s)}
                  </small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="muted small-note">Belum ada tangkapan layar. Kotak “PICTURE HERE” dibiarkan kosong seperti template.</p>
        )}
      </section>

      {showQr &&
        draft.attendance &&
        createPortal(
          <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && setShowQr(false)}>
            <div className="modal mom-start" role="dialog" aria-label="QR absensi">
              <header className="modal-head">
                <div>
                  <b>QR absensi</b>
                  <small>Peserta scan dengan kamera HP lalu mengisi daftar hadir.</small>
                </div>
                <button className="icon-btn" onClick={() => setShowQr(false)} aria-label="Tutup">
                  <X size={18} />
                </button>
              </header>
              <div className="modal-body">
                <AttendanceQr attendance={draft.attendance} info={info} />
              </div>
            </div>
          </div>,
          document.body,
        )}

      <section className="mom-section">
        <h3>Ringkasan</h3>
        <p className="muted small-note">
          {hasSummary ? "Ringkasan rapat dicetak di halaman terakhir MoM (bagian SUMMARY)." : "Belum ada ringkasan. Setelah AI membuat ringkasan, isinya dicetak di halaman terakhir MoM."}
        </p>
      </section>
    </div>
  );
}
