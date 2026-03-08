const active = new Set();
const rand = (lo, hi) => Math.floor(Math.random() * (hi - lo) + lo);
const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms + rand(-50, 50))));

function gauss(mean, sd) {
	const u = Math.random(), v = Math.random();
	return Math.round(mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

function quad(t, a, b, c) {
	const u = 1 - t;
	return u * u * a + 2 * u * t * b + t * t * c;
}

function ease(t) {
	return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

function attr(node, name) {
	const a = node.attributes || [];
	for (let i = 0; i < a.length; i += 2)
		if (a[i] === name) return a[i + 1];
	return null;
}

function isTurnstile(n) {
	return n.nodeName === "IFRAME" && (attr(n, "src") || "").includes("challenges.cloudflare.com");
}

function detach(id) {
	active.delete(id);
	chrome.debugger.detach({ tabId: id }, () => void chrome.runtime.lastError);
}

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
	const dbg = (method, params) => new Promise((ok, fail) => {
		chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
			chrome.runtime.lastError ? fail(chrome.runtime.lastError.message) : ok(res);
		});
	});

	await new Promise((ok) => chrome.debugger.detach({ tabId }, () => {
		void chrome.runtime.lastError;
		ok();
	}));

	try {
		await new Promise((ok, fail) => chrome.debugger.attach({ tabId }, "1.3", () => {
			chrome.runtime.lastError ? fail() : ok();
		}));
	} catch {
		detach(tabId);
		return;
	}

	try {
		await dbg("DOM.enable");
		await dbg("Emulation.setFocusEmulationEnabled", { enabled: true });
	} catch {
		detach(tabId);
		return;
	}

	let misses = 0, clicks = 0, prevSrc = null;

	while (active.has(tabId) && misses < 10 && clicks < 3) {
		await wait(800 + misses * 300);

		try {
			const { nodes } = await dbg("DOM.getFlattenedDocument", { depth: -1, pierce: true });
			const candidates = nodes.filter(isTurnstile);

			if (!candidates.length) { misses++; continue; }

			let frame = null, box = null;
			for (const f of candidates) {
				try {
					const b = await dbg("DOM.getBoxModel", { nodeId: f.nodeId });
					if (b?.model?.content) { frame = f; box = b; break; }
				} catch { continue; }
			}

			if (!frame) { misses++; continue; }
			misses = 0;

			const src = attr(frame, "src");
			if (src && src === prevSrc) { clicks++; continue; }

			const [x1, y1, , , x3, y3] = box.model.content;
			const w = x3 - x1;
			const cy = (y1 + y3) / 2 | 0;

			const tx = x1 + Math.min(35, w * 0.15) + rand(-3, 4);
			const ty = cy + rand(-4, 5);

			const ang = Math.random() * Math.PI * 2;
			const dist = rand(50, 90);
			const sx = tx + Math.cos(ang) * dist | 0;
			const sy = ty + Math.sin(ang) * dist | 0;
			const cpx = (sx + tx) / 2 + rand(-25, 25);
			const cpy = (sy + ty) / 2 + rand(-25, 25);
			const steps = rand(8, 14);

			for (let i = 0; i <= steps; i++) {
				const t = ease(i / steps);
				await dbg("Input.dispatchMouseEvent", {
					type: "mouseMoved",
					x: quad(t, sx, cpx, tx) + rand(-2, 3) | 0,
					y: quad(t, sy, cpy, ty) + rand(-2, 3) | 0
				});
				await wait(Math.max(4, gauss(18, 6)));
			}

			const fx = tx + rand(-3, 4), fy = ty + rand(-3, 4);

			await dbg("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy });
			await wait(rand(30, 70));
			await dbg("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button: "left", clickCount: 1 });
			await wait(rand(50, 100));
			await dbg("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button: "left", clickCount: 1 });

			prevSrc = src;
			await wait(1500);

			if (!active.has(tabId)) break;

			try {
				await dbg("DOM.getBoxModel", { nodeId: frame.nodeId });
			} catch {
				detach(tabId);
				return;
			}
		} catch (e) {
			if (/No tab|not attached/i.test(String(e))) return;
			misses++;
		}
	}

	detach(tabId);
}
