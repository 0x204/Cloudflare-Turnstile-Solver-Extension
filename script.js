const screenDelta = {
	x: Math.random() * Math.max(0, screen.width - innerWidth) | 0,
	y: Math.random() * Math.max(0, screen.height - innerHeight) | 0
};

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
	screenX: { get() { return getScreen(this).x }, configurable: false },
	screenY: { get() { return getScreen(this).y }, configurable: false }
});

const _getOPD = Object.getOwnPropertyDescriptor;
Object.getOwnPropertyDescriptor = function(obj, prop) {
	if (obj === MouseEvent.prototype && (prop === "screenX" || prop === "screenY"))
		return undefined;
	return _getOPD.call(this, obj, prop);
};

window.addEventListener("message", (e) => {
	if (e.source === window) return;
	if (!/^https:\/\/([a-z0-9-]+\.)?cloudflare\.com$/i.test(e.origin)) return;

	const ev = e.data?.event;
	if (ev === "interactiveBegin" || ev === "interactiveEnd")
		chrome.runtime.sendMessage({ action: ev });
});
