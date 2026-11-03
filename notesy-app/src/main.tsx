import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { settingsStore, storesReady } from "./lib/settings";
import { recoverInterrupted } from "./lib/session";
import { startUpdateChecks } from "./lib/update";
import "./styles.css";

/** A setup link `…/#pass=<passcode>` stores the passcode on this device; the hash never reaches the server. */
async function takePasscodeFromLink() {
  const pass = new URLSearchParams(location.hash.slice(1)).get("pass")?.trim();
  if (!pass) return;
  history.replaceState(null, "", location.pathname + location.search);
  await settingsStore.set({ ...settingsStore.get(), cloudPasscode: pass });
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
