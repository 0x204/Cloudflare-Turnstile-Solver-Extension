const origins = ["https://challenges.cloudflare.com", "http://challenges.cloudflare.com"];
const r = (a, b) => a + Math.random() * (b - a) | 0;

Object.defineProperties(MouseEvent.prototype, {
  screenX: { value: r(800, 1200) },
  screenY: { value: r(400, 600) }
});

window.addEventListener("message", e => {
  if (e.source === window || !origins.includes(e.origin)) return;
  const ev = e.data?.event;
  if (ev === "interactiveBegin" || ev === "interactiveEnd") {
    chrome.runtime.sendMessage({ action: ev });
  }
});
