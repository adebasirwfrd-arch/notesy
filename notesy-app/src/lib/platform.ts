declare const __TARGET__: "web" | "extension" | "android";

export const TARGET = __TARGET__;
export const isExtension = TARGET === "extension" || (typeof chrome !== "undefined" && !!chrome.runtime?.id);
export const isAndroid = TARGET === "android" || /Android/i.test(navigator.userAgent);
export const isMobile = isAndroid || /iPhone|iPad/i.test(navigator.userAgent);

/** The Android app captures the screen natively (slides only; Android keeps call audio private). */
export const canCaptureScreen = TARGET === "android" || (!isMobile && !!navigator.mediaDevices?.getDisplayMedia);
export const hasDocumentPip = typeof window !== "undefined" && "documentPictureInPicture" in window;
export const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;

/** Origins that refuse browser CORS go through the same-origin proxy (Vite in dev, Vercel function in production). */
export function apiUrl(url: string) {
  if (TARGET === "web" && url.startsWith("https://api.cursor.com")) {
    return url.replace("https://api.cursor.com", "/cursor-api");
  }
  return url;
}

export async function ensureHostPermission(url: string): Promise<boolean> {
  if (!isExtension || !chrome.permissions) return true;
  const origin = new URL(url).origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

export const assetUrl = (path: string) => new URL(path, document.baseURI).href;
