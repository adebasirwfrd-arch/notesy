const APP_URL = chrome.runtime.getURL("index.html");

async function openApp() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
  const existing = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(APP_URL) && c.tabId >= 0);
  if (existing) {
    const tab = await chrome.tabs.update(existing.tabId, { active: true });
    if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL, pinned: false });
}

chrome.action.onClicked.addListener(openApp);
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "open-notesy") openApp();
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") openApp();
});
