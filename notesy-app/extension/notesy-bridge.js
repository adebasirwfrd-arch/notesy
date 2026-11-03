// Lets the Notesy web app receive speaker names from the extension.
const post = (data) =>
  window.postMessage({ ...data, from: "notesy-extension" }, location.origin);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "notesy-speaking")
    post({ notesy: "speaking", names: msg.names, lagMs: msg.lagMs });
});

window.addEventListener("message", (e) => {
  if (e.source === window && e.data?.notesy === "ping")
    post({ notesy: "ext-ready" });
});
post({ notesy: "ext-ready" });
