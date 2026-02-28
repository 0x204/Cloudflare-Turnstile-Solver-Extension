const active = new Set();
const rand = (min, max) => Math.floor(Math.random() * (max - min) + min);
const wait = ms => new Promise(r => setTimeout(r, Math.max(0, ms + rand(-50, 50))));

function quad(t, p0, p1, p2) {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

function frameSrc(node) {
  const a = node.attributes || [];
  for (let i = 0; i < a.length; i += 2) {
    if (a[i] === "src") return a[i + 1];
  }
  return null;
}

const detach = id => {
  active.delete(id);
  chrome.debugger.detach({ tabId: id }, () => void chrome.runtime.lastError);
};

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  if (reason === "target_closed") active.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.tab) return;
  const id = sender.tab.id;
  if (msg.action === "interactiveBegin" && !active.has(id)) {
    active.add(id);
    solve(id);
  }
  if (msg.action === "interactiveEnd") detach(id);
});

async function solve(tabId) {
  const dbg = (m, p) => new Promise((ok, fail) => {
    chrome.debugger.sendCommand({ tabId }, m, p || {}, r => {
      chrome.runtime.lastError ? fail(chrome.runtime.lastError.message) : ok(r);
    });
  });

  await new Promise(ok => chrome.debugger.detach({ tabId }, () => {
    void chrome.runtime.lastError;
    ok();
  }));

  try {
    await new Promise((ok, fail) => chrome.debugger.attach({ tabId }, "1.3", () => {
      chrome.runtime.lastError ? fail() : ok();
    }));
  } catch { detach(tabId); return; }

  try {
    await dbg("DOM.enable");
    await dbg("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch { detach(tabId); return; }

  let tries = 0, lastSrc = null;

  while (active.has(tabId) && tries < 5) {
    await wait(800);

    try {
      const { nodes } = await dbg("DOM.getFlattenedDocument", { depth: -1, pierce: true });

      const frame = nodes.find(n =>
        n.nodeName === "IFRAME" &&
        (n.attributes || []).some(a => /turnstile|cloudflare|cf-|challenge/i.test(a))
      );

      if (!frame) { tries++; continue; }

      const src = frameSrc(frame);
      if (src && src === lastSrc) { tries++; continue; }

      const box = await dbg("DOM.getBoxModel", { nodeId: frame.nodeId });
      if (!box?.model?.content) { tries++; continue; }

      const [x1, y1, , , x3, y3] = box.model.content;
      const cx = (x1 + x3) / 2 | 0;
      const cy = (y1 + y3) / 2 | 0;

      const angle = Math.random() * Math.PI * 2;
      const dist = rand(50, 90);
      const sx = cx + Math.cos(angle) * dist | 0;
      const sy = cy + Math.sin(angle) * dist | 0;
      const cpx = (sx + cx) / 2 + rand(-25, 25);
      const cpy = (sy + cy) / 2 + rand(-25, 25);
      const steps = rand(8, 14);

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        await dbg("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: quad(t, sx, cpx, cx) + rand(-2, 3) | 0,
          y: quad(t, sy, cpy, cy) + rand(-2, 3) | 0
        });
        await wait(rand(8, 28));
      }

      const fx = cx + rand(-4, 5), fy = cy + rand(-4, 5);
      await dbg("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy });
      await wait(rand(30, 70));
      await dbg("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", clickCount: 1 });
      await wait(rand(50, 100));
      await dbg("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button: "left", clickCount: 1 });

      lastSrc = src;
      await wait(1200);

      try {
        await dbg("DOM.getBoxModel", { nodeId: frame.nodeId });
      } catch {
        detach(tabId);
        return;
      }

    } catch (e) {
      if (/No tab|not attached/i.test(e)) return;
      tries++;
    }
  }

  detach(tabId);
}
