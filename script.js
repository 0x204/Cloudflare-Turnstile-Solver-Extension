const origins = ["https://challenges.cloudflare.com", "http://challenges.cloudflare.com"];
const screenDelta = { x: 80 + Math.random() * 200 | 0, y: 60 + Math.random() * 100 | 0 };
const screenCache = new WeakMap();

function getScreen(e) {
  let s = screenCache.get(e);
  if (!s) {
    s = { x: e.clientX + screenDelta.x, y: e.clientY + screenDelta.y };
    screenCache.set(e, s);
  }
  return s;
}

Object.defineProperties(MouseEvent.prototype, {
  screenX: { get() { return getScreen(this).x; }, configurable: true },
  screenY: { get() { return getScreen(this).y; }, configurable: true }
});

window.addEventListener("message", e => {
  if (e.source === window || !origins.includes(e.origin)) return;
  const ev = e.data?.event;
  if (ev === "interactiveBegin" || ev === "interactiveEnd") {
    chrome.runtime.sendMessage({ action: ev });
  }
});
