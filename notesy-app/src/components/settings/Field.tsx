import type { ReactNode } from "react";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Card({ children, tone }: { children: ReactNode; tone?: "info" | "warn" | "ok" }) {
  return <div className={`card${tone ? ` card-${tone}` : ""}`}>{children}</div>;
}
