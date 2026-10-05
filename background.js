"use strict";

importScripts("shared.js");

const { BEGIN, END, isChallengeUrl, isWidgetId } = TurnstileShared;

const PROTOCOL_VERSION = "1.3";
const COMMAND_TIMEOUT_MS = 5000;
const WIDGET_TIMEOUT_MS = 30000;
const MAX_CLICKS = 2;
const CLICK_WAIT_MS = 4500;
const CLICK_WAIT_STEP_MS = 1000;
const AUTO_ATTACH = {
	autoAttach: true,
	waitForDebuggerOnStart: false,
	flatten: true,
	filter: [{ type: "iframe" }]
};

// Tabs with pending widgets. An entry lives exactly as long as its runner.
const tabs = new Map();

class FatalError extends Error {}

const warn = (...args) => console.warn("[Turnstile Solver]", ...args);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function gaussian(mean, deviation) {
	const u = 1 - Math.random();
	const v = Math.random();
	return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function humanDelay(mean, deviation, min, max) {
	return Math.round(clamp(gaussian(mean, deviation), min, max));
}

// Waits up to `ms`, returning false as soon as `keepGoing()` does.
async function waitWhile(ms, keepGoing) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!keepGoing()) return false;
		await delay(Math.min(50, end - Date.now()));
	}
	return keepGoing();
}

function attribute(node, name) {
	const attributes = node.attributes ?? [];
	for (let i = 0; i < attributes.length; i += 2) {
		if (attributes[i] === name) return attributes[i + 1];
	}
	return null;
}

// A CDP session: the tab itself, or an out-of-process iframe attached through it.
class Session {
	constructor(tabId, sessionId = null, parentId = null, targetInfo = null) {
		this.debuggee = sessionId ? { tabId, sessionId } : { tabId };
		this.id = sessionId;
		this.parentId = parentId;
		this.frameId = targetInfo?.targetId ?? null;
		this.url = targetInfo?.url ?? "";
		this.ready = null;
		this.cssReady = null;
	}

	send(method, params = {}) {
		const command = chrome.debugger.sendCommand(this.debuggee, method, params);
		command.catch(() => {});
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${method} timed out`)), COMMAND_TIMEOUT_MS);
		});
		return Promise.race([command, timeout]).finally(() => clearTimeout(timer));
	}

	// Both of these retry on the next call if they failed before.
	init() {
		if (!this.ready) {
			this.ready = (async () => {
				await this.send("Target.setAutoAttach", AUTO_ATTACH);
				await this.send("Page.enable");
				await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
			})();
			this.ready.catch(() => {
				this.ready = null;
			});
		}
		return this.ready;
	}

	enableCss() {
		if (!this.cssReady) {
			this.cssReady = this.send("DOM.enable").then(() => this.send("CSS.enable"));
			this.cssReady.catch(() => {
				this.cssReady = null;
			});
		}
		return this.cssReady;
	}
}

class Tab {
	constructor(id) {
		this.id = id;
		this.root = new Session(id);
		this.sessions = new Map();
		this.widgets = new Map();
		this.attached = false;
		this.running = false;
		// Frames the current click goes through; if any of them navigates, the click is off.
		this.watchedFrames = new Set();
		this.framesChanged = false;
	}

	parentOf(session) {
		return session.parentId ? this.sessions.get(session.parentId) : this.root;
	}

	frameChanged(frameId) {
		if (this.watchedFrames.has(frameId)) this.framesChanged = true;
	}
}

chrome.runtime.onMessage.addListener((message, sender) => {
	if (!sender.tab || !isWidgetId(message?.widgetId)) return;
	const key = `${sender.documentId}:${message.widgetId}`;

	if (message.action === END) {
		tabs.get(sender.tab.id)?.widgets.delete(key);
		return;
	}
	if (message.action !== BEGIN) return;

	let tab = tabs.get(sender.tab.id);
	if (!tab) {
		tab = new Tab(sender.tab.id);
		tabs.set(tab.id, tab);
	}

	const now = Date.now();
	const job = tab.widgets.get(key);
	if (job && job.clicks < MAX_CLICKS && now < job.deadline) {
		job.deadline = now + WIDGET_TIMEOUT_MS;
	} else {
		// A new widget, or Cloudflare asked again after we gave up on this one.
		tab.widgets.set(key, {
			key,
			widgetId: message.widgetId,
			clicks: 0,
			misses: 0,
			deadline: now + WIDGET_TIMEOUT_MS,
			nextAttemptAt: now
		});
	}
	startRunner(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
	tabs.get(tabId)?.widgets.clear();
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
	const tab = tabs.get(tabId);
	if (!tab?.attached) return;
	// The browser ended the session: the tab closed or the user dismissed the debugging bar.
	tab.attached = false;
	tab.widgets.clear();
});

chrome.debugger.onEvent.addListener((source, method, params) => {
	const tab = tabs.get(source.tabId);
	if (tab?.attached) handleEvent(tab, source.sessionId ?? null, method, params);
});

function handleEvent(tab, sessionId, method, params) {
	switch (method) {
		case "Target.attachedToTarget": {
			const session = new Session(tab.id, params.sessionId, sessionId, params.targetInfo);
			tab.sessions.set(session.id, session);
			session.init();
			break;
		}
		case "Target.detachedFromTarget": {
			const session = tab.sessions.get(params.sessionId);
			if (!session) break;
			tab.sessions.delete(session.id);
			tab.frameChanged(session.frameId);
			break;
		}
		case "Page.frameNavigated": {
			const { frame } = params;
			if (!sessionId && !frame.parentId) {
				// A new top-level document; widgets from the old one are gone.
				tab.widgets.clear();
			}
			const session = tab.sessions.get(sessionId);
			if (session?.frameId === frame.id) session.url = frame.url;
			tab.frameChanged(frame.id);
			break;
		}
		case "Page.frameStartedLoading":
		case "Page.frameDetached":
			tab.frameChanged(params.frameId);
			break;
	}
}

function startRunner(tab) {
	if (tab.running) return;
	tab.running = true;

	run(tab)
		.catch((error) => {
			warn(`Stopped working on tab ${tab.id}:`, error.message);
			tab.widgets.clear();
		})
		.finally(() => {
			tab.running = false;
			if (tab.widgets.size > 0) startRunner(tab);
			else tabs.delete(tab.id);
		});
}

async function run(tab) {
	if (!await attach(tab)) return;
	try {
		await tab.root.init();
		await solveWidgets(tab);
	} finally {
		await detach(tab);
	}
}

async function attach(tab) {
	tab.root = new Session(tab.id);
	// Drop an attachment we may have lost track of, e.g. across a service worker restart.
	await chrome.debugger.detach(tab.root.debuggee).catch(() => {});
	try {
		await chrome.debugger.attach(tab.root.debuggee, PROTOCOL_VERSION);
	} catch (error) {
		warn(`Cannot attach to tab ${tab.id}:`, error.message);
		tab.widgets.clear();
		return false;
	}
	tab.attached = true;
	return true;
}

async function detach(tab) {
	tab.sessions.clear();
	if (!tab.attached) return;
	tab.attached = false;
	await chrome.debugger.detach(tab.root.debuggee).catch(() => {});
}

async function solveWidgets(tab) {
	while (tab.attached && tab.widgets.size > 0) {
		let wakeAt = Date.now() + 1000;

		for (const job of tab.widgets.values()) {
			if (!tab.attached) break;

			const now = Date.now();
			if (now >= job.deadline) {
				warn(`Widget ${job.widgetId} timed out`);
				tab.widgets.delete(job.key);
				continue;
			}
			if (now < job.nextAttemptAt) {
				wakeAt = Math.min(wakeAt, job.nextAttemptAt);
				continue;
			}
			if (job.clicks >= MAX_CLICKS) {
				warn(`Widget ${job.widgetId} did not finish after ${MAX_CLICKS} clicks`);
				tab.widgets.delete(job.key);
				continue;
			}

			const clicked = await attempt(tab, job);
			if (tab.widgets.get(job.key) !== job) continue;

			if (clicked) {
				job.clicks++;
				job.misses = 0;
				job.nextAttemptAt = Date.now() + CLICK_WAIT_MS + job.clicks * CLICK_WAIT_STEP_MS + randInt(-250, 251);
			} else {
				job.misses++;
				job.nextAttemptAt = Date.now() + Math.min(400 + job.misses * 200, 2000) + randInt(-75, 76);
			}
			wakeAt = Math.min(wakeAt, job.nextAttemptAt);
		}

		await waitWhile(clamp(wakeAt - Date.now(), 50, 1000), () => tab.attached && tab.widgets.size > 0);
	}
}

async function attempt(tab, job) {
	const active = () => tab.attached && tab.widgets.get(job.key) === job && Date.now() < job.deadline;
	try {
		return await clickWidget(tab, job, active);
	} catch (error) {
		if (error instanceof FatalError) throw error;
		if (active()) warn(`Attempt on widget ${job.widgetId} failed:`, error.message);
		return false;
	}
}

async function clickWidget(tab, job, active) {
	const widget = await findWidget(tab, job.widgetId);
	if (!widget || !active()) return false;

	await widget.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: widget.backendNodeId });

	tab.watchedFrames.clear();
	tab.framesChanged = false;
	const aim = chooseAim(job.misses);
	const plan = await planClick(tab, widget, aim);
	if (!plan || !active()) return false;

	return moveAndClick(
		tab.root,
		plan,
		() => active() && !tab.framesChanged,
		async () => {
			const fresh = await planClick(tab, widget, aim);
			return fresh !== null && distance(fresh.point, plan.point) < 1;
		}
	);
}

async function findWidget(tab, widgetId) {
	const iframeId = `cf-chl-widget-${widgetId}`;
	return await matchIframe(remoteChallengeFrames(tab), iframeId)
		?? await matchIframe(await localChallengeFrames(tab), iframeId);
}

// Challenge frames in their own process. Their iframe element lives in the parent session.
function remoteChallengeFrames(tab) {
	const frames = [];
	for (const target of tab.sessions.values()) {
		const parent = tab.parentOf(target);
		if (parent && isChallengeUrl(target.url)) frames.push({ session: parent, frameId: target.frameId, target });
	}
	return frames;
}

// Challenge frames sharing a process with their parent, as on *.cloudflare.com pages.
async function localChallengeFrames(tab) {
	const frames = [];
	for (const session of [tab.root, ...tab.sessions.values()]) {
		let frameTree;
		try {
			({ frameTree } = await session.send("Page.getFrameTree"));
		} catch {
			continue;
		}
		const visit = (node) => {
			for (const child of node.childFrames ?? []) {
				if (isChallengeUrl(child.frame.url)) frames.push({ session, frameId: child.frame.id, target: null });
				visit(child);
			}
		};
		visit(frameTree);
	}
	return frames;
}

async function matchIframe(frames, iframeId) {
	for (const { session, frameId, target } of frames) {
		try {
			await target?.init();
			const { backendNodeId } = await session.send("DOM.getFrameOwner", { frameId });
			const { node } = await session.send("DOM.describeNode", { backendNodeId });
			if (node.nodeName === "IFRAME"
				&& attribute(node, "id") === iframeId
				&& isChallengeUrl(attribute(node, "src"))) {
				return { session, frameId, backendNodeId };
			}
		} catch {
			// The frame went away, or its session is not usable yet.
		}
	}
	return null;
}

// The checkbox sits near the left edge, vertically centred. Each miss nudges
// the point a little in case the widget is laid out differently.
function chooseAim(misses) {
	return {
		x: 0.15 + Math.min(0.08, misses * 0.02),
		y: misses % 2 === 1 ? 0.54 : 0.5,
		jitterX: randInt(-2, 3),
		jitterY: randInt(-3, 4)
	};
}

// Maps the aim point from the widget iframe out through every enclosing frame to
// top-level viewport coordinates, hit-testing on the way so nothing covers it.
async function planClick(tab, widget, aim) {
	let session = widget.session;
	let element = { backendNodeId: widget.backendNodeId, frameId: widget.frameId };
	let point = null;

	while (true) {
		tab.watchedFrames.add(element.frameId);
		if (session !== tab.root) await session.init();

		const box = await measure(session, element.backendNodeId);
		if (!box) return null;

		point = point ? mapIntoBox(point, box) : aimAt(box.quad, aim);
		if (!point || !insideViewport(point, box.viewport)) return null;
		if (!await hitsFrame(session, point, element, box.viewport)) return null;

		if (session === tab.root) {
			return { point, bounds: clipToViewport(quadBounds(box.quad), box.viewport), viewport: box.viewport };
		}

		const parent = tab.parentOf(session);
		if (!parent) return null;
		const { backendNodeId } = await parent.send("DOM.getFrameOwner", { frameId: session.frameId });
		element = { backendNodeId, frameId: session.frameId };
		session = parent;
	}
}

// Box quads are in viewport coordinates of the session's frame. In an out-of-process
// frame only the layout viewport describes that frame; the visual one is the page's.
async function measure(session, backendNodeId) {
	const [{ model }, { cssLayoutViewport: viewport }, visible] = await Promise.all([
		session.send("DOM.getBoxModel", { backendNodeId }),
		session.send("Page.getLayoutMetrics"),
		isVisible(session, backendNodeId)
	]);
	const { content, border } = model;
	if (!visible || !isParallelogram(content)) return null;
	return {
		quad: content,
		// Untransformed size of the content box, i.e. the coordinate space of the frame inside it.
		size: {
			width: model.width * edgeLength(content, 0, 2) / edgeLength(border, 0, 2),
			height: model.height * edgeLength(content, 0, 6) / edgeLength(border, 0, 6)
		},
		viewport: {
			width: viewport.clientWidth,
			height: viewport.clientHeight,
			scrollX: viewport.pageX,
			scrollY: viewport.pageY
		}
	};
}

async function isVisible(session, backendNodeId) {
	await session.enableCss();
	await session.send("DOM.getDocument", { depth: 0 });
	const { nodeIds } = await session.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
	const { computedStyle } = await session.send("CSS.getComputedStyleForNode", { nodeId: nodeIds[0] });
	const style = Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
	return style.display !== "none"
		&& style.visibility === "visible"
		&& style["pointer-events"] !== "none"
		&& style["content-visibility"] !== "hidden"
		&& Number.parseFloat(style.opacity) > 0.05;
}

// True if the topmost element at `point` is the iframe or something inside it.
// getNodeForLocation takes document coordinates, hence the scroll offset.
async function hitsFrame(session, point, element, viewport) {
	const hit = await session.send("DOM.getNodeForLocation", {
		x: Math.round(point.x + viewport.scrollX),
		y: Math.round(point.y + viewport.scrollY),
		includeUserAgentShadowDOM: true,
		ignorePointerEventsNone: false
	});
	if (hit.backendNodeId === element.backendNodeId) return true;
	if (hit.frameId !== element.frameId) return false;

	// We are inside an in-process frame; a nested iframe there is not the widget.
	const { node } = await session.send("DOM.describeNode", { backendNodeId: hit.backendNodeId });
	return node.nodeName !== "IFRAME";
}

function aimAt(quad, aim) {
	const width = edgeLength(quad, 0, 2);
	const height = edgeLength(quad, 0, 6);
	if (width < 80 || height < 30) return null;

	const x = clamp(Math.min(35, width * aim.x) / width, 0.08, 0.3);
	const point = pointInQuad(quad, x, aim.y);
	return { x: point.x + aim.jitterX, y: point.y + aim.jitterY };
}

// Maps a point inside a frame to its parent's coordinates, given the frame's owner box.
function mapIntoBox(point, { quad, size }) {
	const x = point.x / size.width;
	const y = point.y / size.height;
	if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
	return pointInQuad(quad, x, y);
}

function edgeLength(quad, from, to) {
	return Math.hypot(quad[to] - quad[from], quad[to + 1] - quad[from + 1]);
}

function pointInQuad(quad, x, y) {
	const topX = quad[0] + (quad[2] - quad[0]) * x;
	const topY = quad[1] + (quad[3] - quad[1]) * x;
	const bottomX = quad[6] + (quad[4] - quad[6]) * x;
	const bottomY = quad[7] + (quad[5] - quad[7]) * x;
	return { x: topX + (bottomX - topX) * y, y: topY + (bottomY - topY) * y };
}

function quadBounds(quad) {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

// Rotations and skews are fine; perspective transforms are not.
function isParallelogram(quad) {
	return Math.abs(quad[0] + quad[4] - quad[2] - quad[6]) <= 0.01
		&& Math.abs(quad[1] + quad[5] - quad[3] - quad[7]) <= 0.01;
}

function insideViewport(point, viewport) {
	return point.x >= 1 && point.y >= 1 && point.x < viewport.width - 1 && point.y < viewport.height - 1;
}

function clipToViewport(bounds, viewport) {
	return {
		left: Math.max(0, bounds.left),
		top: Math.max(0, bounds.top),
		right: Math.min(viewport.width - 1, bounds.right),
		bottom: Math.min(viewport.height - 1, bounds.bottom)
	};
}

function bezier(t, start, control, end) {
	return (1 - t) ** 2 * start + 2 * (1 - t) * t * control + t ** 2 * end;
}

function easeInOut(t) {
	return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

async function moveAndClick(session, { point, bounds, viewport }, active, stillOnTarget) {
	const area = {
		left: Math.min(bounds.right, bounds.left + 2),
		top: Math.min(bounds.bottom, bounds.top + 2),
		right: Math.max(bounds.left, bounds.right - 2),
		bottom: Math.max(bounds.top, bounds.bottom - 2)
	};
	const inArea = (x, y) => ({ x: clamp(x, area.left, area.right), y: clamp(y, area.top, area.bottom) });
	const move = ({ x, y }) => session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });

	const angle = Math.random() * 2 * Math.PI;
	const travel = randInt(45, 81);
	const start = inArea(point.x + Math.cos(angle) * travel, point.y + Math.sin(angle) * travel);
	const control = inArea((start.x + point.x) / 2 + randInt(-22, 23), (start.y + point.y) / 2 + randInt(-22, 23));

	const steps = randInt(10, 16);
	for (let i = 0; i <= steps; i++) {
		const t = easeInOut(i / steps);
		await move({
			x: clamp(bezier(t, start.x, control.x, point.x) + randInt(-1, 2), 0, viewport.width - 1),
			y: clamp(bezier(t, start.y, control.y, point.y) + randInt(-1, 2), 0, viewport.height - 1)
		});
		if (!await waitWhile(humanDelay(18, 6, 7, 42), active)) return false;
	}

	const settleMoves = randInt(3, 6);
	for (let i = 0; i < settleMoves; i++) {
		await move(inArea(point.x + randInt(-2, 3), point.y + randInt(-2, 3)));
		if (!await waitWhile(humanDelay(25, 8, 8, 55), active)) return false;
	}

	await move(point);
	if (!await waitWhile(randInt(35, 71), active)) return false;
	if (!await stillOnTarget() || !active()) return false;

	await click(session, point);
	return true;
}

async function click(session, { x, y }) {
	const event = { x, y, button: "left", clickCount: 1 };
	let pressError = null;
	try {
		await session.send("Input.dispatchMouseEvent", { ...event, type: "mousePressed", buttons: 1 });
		await delay(randInt(45, 86));
	} catch (error) {
		pressError = error;
	}

	// Release even if the press failed: it may have reached the page anyway,
	// and a missing release would leave the button held down.
	try {
		await session.send("Input.dispatchMouseEvent", { ...event, type: "mouseReleased", buttons: 0 });
	} catch (error) {
		throw new FatalError(`Mouse release failed: ${error.message}`);
	}
	if (pressError) warn("Mouse press may not have landed:", pressError.message);
}
