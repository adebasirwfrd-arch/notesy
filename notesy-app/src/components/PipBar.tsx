import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLiveSession } from "../lib/session";
import { LiveControls } from "./LiveBar";

let pipWin: Window | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

type DocPip = { requestWindow(o: { width: number; height: number; disallowReturnToOpener?: boolean }): Promise<Window> };

export async function openPip() {
  if (pipWin) return;
  const dpip = (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture;
  if (!dpip) throw new Error("Browser ini belum mendukung kontrol melayang.");
  const win = await dpip.requestWindow({ width: 420, height: 64 });
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = win.document.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      win.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = win.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        win.document.head.appendChild(link);
      }
    }
  }
  win.document.body.className = "pip-body";
  win.addEventListener("pagehide", () => {
    pipWin = null;
    notify();
  });
  pipWin = win;
  notify();
}

export function closePip() {
  pipWin?.close();
  pipWin = null;
  notify();
}

export function PipBar() {
  const win = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => pipWin,
  );
  const live = useLiveSession();
  useEffect(() => {
    if (!live && win) closePip();
  }, [live, win]);
  if (!win || !live) return null;
  return createPortal(<LiveControls live={live} compact />, win.document.body);
}
