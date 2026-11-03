// Reports who is speaking in Google Meet / Microsoft Teams (web) to Notesy.
// Primary source: live captions (CC), which label every line with the account name.
// Secondary: "is speaking" labels on video tiles, when the page exposes them.
(() => {
  const POLL_MS = 250;
  const HOLD_MS = 1500;
  const CAPTION_LAG_MS = 800;
  const teams = !location.hostname.includes("meet.google");

  const seen = new WeakMap();
  const lastGrowth = new Map();
  let first = true;
  let lastSent = "";
  let lastSentAt = 0;
  let wasCaptions = false;

  const textNodes = (el) => {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = w.currentNode.textContent.trim();
      if (t) out.push(t);
    }
    return out;
  };

  /** [block element, speaker name, caption text] for every caption line on screen. */
  function captionLines() {
    const out = [];
    if (teams) {
      for (const t of document.querySelectorAll(
        '[data-tid="closed-caption-text"]',
      )) {
        let el = t.parentElement;
        let author = null;
        for (let i = 0; el && i < 6 && !author; i++, el = el.parentElement)
          author = el.querySelector('[data-tid="author"]');
        if (author)
          out.push([t, author.textContent.trim(), t.textContent.trim()]);
      }
      return out;
    }
    const region =
      document.querySelector('[role="region"][aria-label*="aption" i]') ||
      document.querySelector('[role="region"][aria-label*="teks" i]') ||
      document.querySelector('[jsname="dsyhDe"]');
    if (!region) return out;
    // Each Meet caption block holds an avatar, the name, then the words.
    for (const img of region.querySelectorAll("img")) {
      let block = img.parentElement;
      while (block && block !== region && textNodes(block).length < 2)
        block = block.parentElement;
      if (!block || block === region) continue;
      const [name, ...rest] = textNodes(block);
      if (name && name.length < 80) out.push([block, name, rest.join(" ")]);
    }
    return out;
  }

  /** Names from tiles labelled as currently speaking (no captions needed when available). */
  function tileSpeakers() {
    const out = [];
    for (const el of document.querySelectorAll("[aria-label]")) {
      const label = el.getAttribute("aria-label");
      if (!label || label.length > 160) continue;
      const m = label.match(
        /^(.+?)[,،]?\s+(?:is speaking|sedang berbicara|speaking)\b/i,
      );
      if (m) out.push(m[1].trim());
    }
    return out;
  }

  function poll() {
    const now = Date.now();
    for (const [block, name, text] of captionLines()) {
      const prev = seen.get(block);
      if (prev !== text) {
        seen.set(block, text);
        if (!first && text) lastGrowth.set(name, now);
      }
    }
    first = false;
    const names = new Set();
    for (const [name, at] of lastGrowth)
      if (now - at < HOLD_MS) names.add(name);
    const fromCaptions = names.size > 0;
    for (const n of tileSpeakers()) names.add(n);
    const list = [...names].sort();
    const key = list.join("\n");
    if (key === lastSent && (!list.length || now - lastSentAt < 1000)) return;
    lastSent = key;
    lastSentAt = now;
    try {
      // Silence is noticed HOLD_MS after the last caption word, which itself trails the voice.
      const lagMs = fromCaptions
        ? CAPTION_LAG_MS
        : !list.length && wasCaptions
          ? CAPTION_LAG_MS + HOLD_MS
          : 0;
      wasCaptions = fromCaptions;
      chrome.runtime
        .sendMessage({ type: "notesy-speaking", names: list, lagMs })
        .catch(() => {});
    } catch {
      clearInterval(timer);
    }
  }

  const timer = setInterval(poll, POLL_MS);
})();
