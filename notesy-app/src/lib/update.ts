import { TARGET } from "./platform";
import { hasActiveWork, onActiveWorkChange } from "./session";

declare const __BUILD__: string;

const CHECK_EVERY_MS = 60_000;
/** A stale CDN copy of index.html could otherwise make every load reload again. */
const TRIED_KEY = "notesy-update-tried";
let pending = false;

async function latestBuild(): Promise<string | null> {
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as { build?: string }).build ?? null : null;
  } catch {
    return null;
  }
}

const isEditing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");
};

/** Never reload mid-recording or mid-processing: that would cut the meeting or abort transcription. */
function applyIfIdle() {
  if (!pending || hasActiveWork()) return;
  if (document.visibilityState === "visible" && isEditing()) return;
  location.reload();
}

async function check() {
  if (pending) return applyIfIdle();
  const build = await latestBuild();
  if (build && build !== __BUILD__ && sessionStorage.getItem(TRIED_KEY) !== build) {
    sessionStorage.setItem(TRIED_KEY, build);
    pending = true;
    applyIfIdle();
  }
}

/** Web tabs stay open for days; without this they keep running whatever bundle they first loaded. */
export function startUpdateChecks() {
  if (TARGET !== "web" || import.meta.env.DEV) return;
  setInterval(check, CHECK_EVERY_MS);
  document.addEventListener("visibilitychange", () => void check());
  window.addEventListener("focus", () => void check());
  document.addEventListener("focusout", () => setTimeout(applyIfIdle, 0));
  onActiveWorkChange(applyIfIdle);
  void check();
}
