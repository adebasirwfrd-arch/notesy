import { useSyncExternalStore } from "react";
import { errorMessage, uid } from "./util";

export interface Toast {
  id: string;
  kind: "info" | "error" | "success";
  text: string;
}

let toasts: Toast[] = [];
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export function toast(text: string, kind: Toast["kind"] = "info", ms = kind === "error" ? 8000 : 3500) {
  const t = { id: uid(), kind, text };
  toasts = [...toasts, t];
  notify();
  setTimeout(() => dismiss(t.id), ms);
}

export const toastError = (e: unknown) => toast(errorMessage(e), "error");

export function dismiss(id: string) {
  toasts = toasts.filter((t) => t.id !== id);
  notify();
}

export const useToasts = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => toasts,
  );
