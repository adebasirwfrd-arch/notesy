import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { storesReady } from "./lib/settings";
import { recoverInterrupted } from "./lib/session";
import { startUpdateChecks } from "./lib/update";
import "./styles.css";

storesReady.then(async () => {
  await recoverInterrupted().catch((e) => console.warn("recovery failed", e));
  startUpdateChecks();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
