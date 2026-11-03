import { useRef, useState } from "react";
import { Camera, Eye, EyeOff, ImagePlus, Trash2, X } from "lucide-react";
import { useBlobUrl } from "../../lib/hooks";
import { deleteSlide, putSlide } from "../../lib/db";
import { importImages } from "../../lib/session";
import { formatClock } from "../../lib/util";
import { toastError } from "../../lib/toast";
import type { Note, Slide } from "../../lib/types";

function SlideCard({ slide, onOpen }: { slide: Slide; onOpen: () => void }) {
  const url = useBlobUrl(slide.blobKey);
  return (
    <figure className={`slide-card${slide.excluded ? " excluded" : ""}`}>
      <button className="slide-thumb" onClick={onOpen}>
        {url && <img src={url} alt={slide.caption ?? ""} loading="lazy" />}
        <span className="slide-time">{formatClock(slide.t)}</span>
        {!slide.auto && <span className="slide-tag">manual</span>}
      </button>
      <figcaption>
        <input
          className="slide-caption"
          defaultValue={slide.caption ?? ""}
          placeholder="Tambah keterangan"
          onBlur={(e) => e.target.value !== (slide.caption ?? "") && putSlide({ ...slide, caption: e.target.value })}
        />
        <div className="slide-actions">
          <button
            className="icon-btn"
            title={slide.excluded ? "Sertakan di ringkasan" : "Jangan sertakan di ringkasan"}
            onClick={() => putSlide({ ...slide, excluded: !slide.excluded })}
          >
            {slide.excluded ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
          <button className="icon-btn" title="Hapus" onClick={() => deleteSlide(slide)}>
            <Trash2 size={15} />
          </button>
        </div>
      </figcaption>
    </figure>
  );
}

function Lightbox({ slide, onClose }: { slide: Slide; onClose: () => void }) {
  const url = useBlobUrl(slide.blobKey);
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="icon-btn lightbox-close" aria-label="Tutup">
        <X size={20} />
      </button>
      {url && <img src={url} alt={slide.caption ?? ""} onClick={(e) => e.stopPropagation()} />}
      {(slide.caption || slide.description) && (
        <div className="lightbox-text" onClick={(e) => e.stopPropagation()}>
          <b>
            {formatClock(slide.t)} · {slide.caption}
          </b>
          {slide.description && <p>{slide.description}</p>}
        </div>
      )}
    </div>
  );
}

export function SlidesTab({ note, slides, isLive }: { note: Note; slides: Slide[]; isLive: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<Slide | null>(null);
  const onFiles = (files: FileList | null) => files && importImages(note.id, files).catch(toastError);

  return (
    <div className="slides-tab">
      <div className="slides-toolbar">
        <span className="muted">
          {slides.length
            ? `${slides.length} tangkapan · ${slides.filter((s) => !s.excluded).length} dipakai di ringkasan`
            : isLive
              ? "Slide akan muncul di sini setiap kali layar berganti."
              : "Belum ada tangkapan layar."}
        </span>
        <div className="spacer" />
        <button className="btn btn-small btn-ghost" onClick={() => camRef.current?.click()}>
          <Camera size={14} /> Foto
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => fileRef.current?.click()}>
          <ImagePlus size={14} /> Tambah gambar
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFiles(e.target.files)} />
      </div>
      <div className="slide-grid">
        {slides.map((s) => (
          <SlideCard key={s.id} slide={s} onOpen={() => setOpen(s)} />
        ))}
      </div>
      {open && <Lightbox slide={open} onClose={() => setOpen(null)} />}
      {note.summaries.length > 0 && slides.length > 0 && (
        <p className="fineprint">Slide yang disembunyikan (ikon mata) tidak dikirim ke AI saat ringkasan dibuat ulang.</p>
      )}
    </div>
  );
}
