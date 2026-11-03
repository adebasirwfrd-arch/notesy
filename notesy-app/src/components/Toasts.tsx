import { X } from "lucide-react";
import { dismiss, useToasts } from "../lib/toast";

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Tutup">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
