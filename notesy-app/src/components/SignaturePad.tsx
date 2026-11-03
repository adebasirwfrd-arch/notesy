import { useEffect, useRef, useState } from "react";
import { Eraser, PenLine, Undo2, Upload, X } from "lucide-react";
import type { Signature } from "../lib/types";
import { toastError } from "../lib/toast";

type Point = { x: number; y: number; w: number };
type Stroke = Point[];

const INK = "#10182b";
const MIN_W = 0.7;
const MAX_W = 1.9;
/** Export resolution relative to CSS pixels, so the thin line stays crisp when printed or zoomed on a phone. */
const EXPORT_SCALE = 3;

function strokeWidth(velocity: number, pressure: number, pen: boolean) {
  const base = pen ? MIN_W + (MAX_W - MIN_W) * Math.min(1, pressure * 1.4) : MAX_W - Math.min(1, velocity / 2.2) * (MAX_W - MIN_W);
  return Math.max(MIN_W, Math.min(MAX_W, base));
}

/** Quadratic segments through the midpoints give a smooth line without the jaggies of raw pointer samples. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number, from = 0) {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.length === 1) {
    ctx.beginPath();
    ctx.arc(s[0].x * scale, s[0].y * scale, (s[0].w * scale) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = Math.max(1, from); i < s.length; i++) {
    const p0 = s[i - 2] ?? s[i - 1];
    const p1 = s[i - 1];
    const p2 = s[i];
    const m0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const m1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    ctx.beginPath();
    ctx.lineWidth = ((p1.w + p2.w) / 2) * scale;
    ctx.moveTo(m0.x * scale, m0.y * scale);
    ctx.quadraticCurveTo(p1.x * scale, p1.y * scale, m1.x * scale, m1.y * scale);
    ctx.stroke();
  }
}

function bounds(strokes: Stroke[]) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes)
    for (const p of s) {
      x0 = Math.min(x0, p.x - p.w);
      y0 = Math.min(y0, p.y - p.w);
      x1 = Math.max(x1, p.x + p.w);
      y1 = Math.max(y1, p.y + p.w);
    }
  return { x0, y0, x1, y1 };
}

function exportStrokes(strokes: Stroke[]): Signature {
  const pad = 4;
  const b = bounds(strokes);
  const w = b.x1 - b.x0 + pad * 2;
  const h = b.y1 - b.y0 + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * EXPORT_SCALE);
  canvas.height = Math.ceil(h * EXPORT_SCALE);
  const ctx = canvas.getContext("2d")!;
  const shifted = strokes.map((s) => s.map((p) => ({ ...p, x: p.x - b.x0 + pad, y: p.y - b.y0 + pad })));
  for (const s of shifted) drawStroke(ctx, s, EXPORT_SCALE);
  return { kind: "drawn", dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height, signedAt: Date.now() };
}

/** Uploaded scans usually sit on white paper: knock the paper out and crop to the ink. */
async function processUpload(file: File, removeWhite: boolean): Promise<Signature> {
  if (!file.type.startsWith("image/")) throw new Error("Unggah gambar tanda tangan (PNG, JPG, atau WEBP).");
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * scale));
  const H = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const data = ctx.getImageData(0, 0, W, H);
  const px = data.data;
  let [x0, y0, x1, y1] = [W, H, -1, -1];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (removeWhite) {
        const light = Math.min(px[i], px[i + 1], px[i + 2]);
        if (light > 235) px[i + 3] = 0;
        else if (light > 190) px[i + 3] = Math.round(px[i + 3] * ((235 - light) / 45));
      }
      if (px[i + 3] > 24) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  if (x1 < 0) throw new Error("Gambar tampak kosong. Pilih foto/scan tanda tangan yang jelas.");
  ctx.putImageData(data, 0, 0);
  const pad = 6;
  const cx = Math.max(0, x0 - pad);
  const cy = Math.max(0, y0 - pad);
  const cw = Math.min(W, x1 + pad) - cx;
  const ch = Math.min(H, y1 + pad) - cy;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d")!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  return { kind: "image", dataUrl: out.toDataURL("image/png"), width: cw, height: ch, signedAt: Date.now() };
}

interface Props {
  name: string;
  onSave: (sig: Signature) => void;
  onClose: () => void;
}

export function SignaturePad({ name, onSave, onClose }: Props) {
  const [mode, setMode] = useState<"draw" | "upload">("draw");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [upload, setUpload] = useState<{ file: File; sig: Signature } | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<{ stroke: Stroke; last: { x: number; y: number; t: number }; vel: number } | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  strokesRef.current = strokes;

  const scale = () => Math.max(2, window.devicePixelRatio || 1);

  const redraw = (list = strokesRef.current) => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const s of list) drawStroke(ctx, s, scale());
  };

  useEffect(() => {
    if (mode !== "draw") return;
    const c = canvasRef.current!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      c.width = Math.round(r.width * scale());
      c.height = Math.round(r.height * scale());
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pos = (e: PointerEvent | React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pos(e);
    const pen = e.pointerType === "pen";
    const w = strokeWidth(0, e.pressure || 0.5, pen);
    live.current = { stroke: [{ ...p, w }], last: { ...p, t: e.timeStamp }, vel: 0 };
    drawStroke(canvasRef.current!.getContext("2d")!, live.current.stroke, scale());
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cur = live.current;
    if (!cur) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext("2d")!;
    const events = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const p = pos(ev);
      const dist = Math.hypot(p.x - cur.last.x, p.y - cur.last.y);
      if (dist < 0.6) continue;
      const dt = Math.max(1, ev.timeStamp - cur.last.t);
      cur.vel = cur.vel * 0.7 + (dist / dt) * 0.3;
      const target = strokeWidth(cur.vel, ev.pressure || 0.5, ev.pointerType === "pen");
      const prevW = cur.stroke[cur.stroke.length - 1].w;
      cur.stroke.push({ ...p, w: prevW + (target - prevW) * 0.35 });
      cur.last = { ...p, t: ev.timeStamp };
      drawStroke(ctx, cur.stroke, scale(), cur.stroke.length - 1);
    }
  };

  const up = () => {
    const cur = live.current;
    live.current = null;
    if (cur) setStrokes((s) => [...s, cur.stroke]);
  };

  const undo = () => {
    const next = strokes.slice(0, -1);
    setStrokes(next);
    redraw(next);
  };

  const clear = () => {
    setStrokes([]);
    redraw([]);
  };

  const pick = async (file: File | undefined, white = removeWhite) => {
    if (!file) return;
    try {
      setUpload({ file, sig: await processUpload(file, white) });
    } catch (e) {
      toastError(e);
    }
  };

  const save = () => {
    if (mode === "draw") {
      if (!strokes.length) return;
      onSave(exportStrokes(strokes));
    } else if (upload) onSave(upload.sig);
  };

  const ready = mode === "draw" ? strokes.length > 0 : !!upload;

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sign-modal" role="dialog" aria-label="Tanda tangan">
        <header className="modal-head">
          <div>
            <b>Tanda tangan</b>
            {name && <small>{name}</small>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup">
            <X size={18} />
          </button>
        </header>
        <div className="segmented">
          <button className={mode === "draw" ? "active" : ""} onClick={() => setMode("draw")}>
            <PenLine size={14} /> Tulis manual
          </button>
          <button className={mode === "upload" ? "active" : ""} onClick={() => setMode("upload")}>
            <Upload size={14} /> Unggah gambar
          </button>
        </div>
        {mode === "draw" ? (
          <>
            <div className="sign-area">
              <canvas ref={canvasRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={(e) => e.buttons === 0 && up()} />
              <span className="sign-line" />
              {!strokes.length && <span className="sign-hint">Tanda tangan di sini</span>}
            </div>
            <div className="row">
              <button className="btn btn-small btn-ghost" onClick={undo} disabled={!strokes.length}>
                <Undo2 size={14} /> Urungkan
              </button>
              <button className="btn btn-small btn-ghost" onClick={clear} disabled={!strokes.length}>
                <Eraser size={14} /> Hapus
              </button>
            </div>
          </>
        ) : (
          <div className="sign-upload">
            <label className="sign-drop">
              {upload ? <img src={upload.sig.dataUrl} alt="Tanda tangan" /> : <span>Pilih gambar tanda tangan (PNG, JPG, WEBP) atau tanda tangan digital yang diekspor sebagai gambar</span>}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden onChange={(e) => pick(e.target.files?.[0])} />
            </label>
            <label className="toggle small">
              <input
                type="checkbox"
                checked={removeWhite}
                onChange={(e) => {
                  setRemoveWhite(e.target.checked);
                  if (upload) void pick(upload.file, e.target.checked);
                }}
              />
              Hapus latar putih (untuk foto/scan di kertas)
            </label>
          </div>
        )}
        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Batal
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!ready}>
            Simpan tanda tangan
          </button>
        </footer>
      </div>
    </div>
  );
}
