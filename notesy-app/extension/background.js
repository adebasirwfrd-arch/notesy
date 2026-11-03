const APP_URL = chrome.runtime.getURL("index.html");

async function openApp() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const existing = contexts.find(
    (c) => c.documentUrl && c.documentUrl.startsWith(APP_URL) && c.tabId >= 0,
  );
  if (existing) {
    const tab = await chrome.tabs.update(existing.tabId, { active: true });
    if (tab?.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL, pinned: false });
}

chrome.action.onClicked.addListener(openApp);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "open-notesy") openApp();
});
const BRIDGE_URLS = ["https://notesy-three.vercel.app/*", "http://localhost/*"];

// Speaker names from Meet/Teams tabs go to Notesy, whether it runs as this extension or as the web app.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "notesy-speaking" || !sender.tab) return;
  chrome.runtime.sendMessage(msg).catch(() => {});
  chrome.tabs.query({ url: BRIDGE_URLS }).then((tabs) => {
    for (const t of tabs)
      if (t.id !== undefined)
        chrome.tabs.sendMessage(t.id, msg).catch(() => {});
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") openApp();
});
