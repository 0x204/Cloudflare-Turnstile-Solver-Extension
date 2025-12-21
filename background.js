const active = new Set();
const rand = (min, max) => Math.random() * (max - min) + min | 0;
const wait = ms => new Promise(r => setTimeout(r, ms + rand(-50, 50)));

const detach = id => {
  active.delete(id);
  chrome.debugger.detach({ tabId: id }, () => chrome.runtime.lastError);
};

chrome.debugger.onDetach.addListener((source, reason) => {
  if (reason === "target_closed") active.delete(source.tabId);
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

  try {
    await new Promise((ok, fail) => chrome.debugger.attach({ tabId }, "1.3", () => {
      chrome.runtime.lastError ? fail() : ok();
    }));
  } catch { return; }

  try {
    await dbg("DOM.enable");
    await dbg("Page.enable");
    await dbg("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch { detach(tabId); return; }

  let tries = 0, last = null;

  while (active.has(tabId) && tries < 5) {
    await wait(800);
    
    try {
      const { nodes } = await dbg("DOM.getFlattenedDocument", { depth: -1, pierce: true });
      
      const frame = nodes.find(n => 
        n.nodeName === "IFRAME" && 
        (n.attributes || []).some(a => /turnstile|cloudflare|cf-|challenge/i.test(a))
      );

      if (!frame) { tries++; continue; }
      if (frame.nodeId === last) { tries++; continue; }

      const box = await dbg("DOM.getBoxModel", { nodeId: frame.nodeId });
      if (!box?.model?.content) continue;

      const [x1, y1, , , x3, y3] = box.model.content;
      const cx = (x1 + x3) / 2 | 0, cy = (y1 + y3) / 2 | 0;

      const sx = cx + rand(-80, -40), sy = cy + rand(-60, -30);
      const steps = rand(6, 10);
      
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const ease = t * t * (3 - 2 * t);
        await dbg("Input.dispatchMouseEvent", { 
          type: "mouseMoved", 
          x: sx + (cx - sx) * ease + rand(-2, 2) | 0,
          y: sy + (cy - sy) * ease + rand(-2, 2) | 0
        });
        await wait(rand(10, 25));
      }

      await wait(rand(30, 80));
      await dbg("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
      await wait(rand(40, 90));
      await dbg("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

      last = frame.nodeId;
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
