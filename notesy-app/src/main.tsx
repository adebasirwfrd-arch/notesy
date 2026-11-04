import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { settingsStore, storesReady } from "./lib/settings";
import { recoverInterrupted } from "./lib/session";
import { startUpdateChecks } from "./lib/update";
import "./styles.css";

const LINK_MODELS: Record<string, string> = {
  turbo: "onnx-community/whisper-large-v3-turbo",
  small: "onnx-community/whisper-small",
  base: "onnx-community/whisper-base",
};

/** A setup link `…/#pass=<passcode>&model=turbo&lang=en` configures this device; the hash never reaches the server. */
async function takePasscodeFromLink() {
  const q = new URLSearchParams(location.hash.slice(1));
  const pass = q.get("pass")?.trim();
  const model = LINK_MODELS[q.get("model") ?? ""];
  const lang = q.get("lang")?.trim();
  if (!pass && !model && !lang) return;
  history.replaceState(null, "", location.pathname + location.search);
  const s = settingsStore.get();
  await settingsStore.set({
    ...s,
    ...(pass ? { cloudPasscode: pass } : {}),
    ...(model ? { whisperModel: model, sttEngine: "browser" as const, liveTranscribe: true } : {}),
    ...(lang ? { sttLanguage: lang } : {}),
  });
}

storesReady.then(async () => {
  await takePasscodeFromLink().catch(() => {});
  await recoverInterrupted().catch((e) => console.warn("recovery failed", e));
  startUpdateChecks();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
