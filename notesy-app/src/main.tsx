import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { storesReady } from "./lib/settings";
import { recoverInterrupted } from "./lib/session";
import "./styles.css";

storesReady.then(async () => {
  await recoverInterrupted().catch((e) => console.warn("recovery failed", e));
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
