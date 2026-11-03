export const uid = (prefix = "") =>
  prefix + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDuration(ms: number) {
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 mnt";
  if (min < 60) return `${min} mnt`;
  return `${Math.floor(min / 60)} j ${min % 60} mnt`;
}

const dayFmt = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" });

export const formatDate = (t: number) => dayFmt.format(t);
export const formatTime = (t: number) => timeFmt.format(t);

export function dayBucket(t: number, now = Date.now()) {
  const d = new Date(t);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - start.getTime()) / 86400000);
  if (diff <= 0) return "Hari ini";
  if (diff === 1) return "Kemarin";
  if (diff < 7) return "7 hari terakhir";
  if (diff < 30) return "30 hari terakhir";
  return new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" }).format(d);
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

declare const __TARGET__: string;

/** Android WebView ignores <a download>, so files are written to cache and handed to the share sheet. */
async function shareOnAndroid(name: string, blob: Blob) {
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
  const data = await blobToBase64(blob);
  const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
  await Share.share({ title: name, url: uri, dialogTitle: "Simpan atau bagikan" });
}

export function download(name: string, data: Blob | string, type = "text/plain") {
  const blob = typeof data === "string" ? new Blob([data], { type }) : data;
  if (__TARGET__ === "android") {
    void shareOnAndroid(name, blob).catch((e) => console.warn("share failed", e));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function safeFileName(s: string) {
  return s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "notesy";
}

export function errorMessage(e: unknown) {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
