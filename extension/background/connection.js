import { CdpSession, CommandTimeoutError, PROTOCOL_VERSION } from "./cdp.js";

// Left behind by a previous service worker that stopped while attached.
const STALE_SESSION = /Another debugger is already attached/i;

const AUTO_ATTACH = {
	autoAttach: true,
	waitForDebuggerOnStart: false,
	flatten: true,
	filter: [{ type: "iframe", exclude: false }],
};

const SETUP = [
	["Target.setAutoAttach", AUTO_ATTACH],
	["DOM.enable"],
	["CSS.enable"],
	["Page.enable"],
	// Background tabs do not acknowledge Input.dispatchMouseEvent unless they render. Focus
	// emulation keeps them rendering, so the page reports itself visible while attached.
	["Emulation.setFocusEmulationEnabled", { enabled: true }],
];

const TEARDOWN = [
	["Emulation.setFocusEmulationEnabled", { enabled: false }],
	["Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }],
	["CSS.disable"],
	["DOM.disable"],
	["Page.disable"],
];

class FrameWatch {
	#frames = new Set();
	#controller = new AbortController();
	#release;

	constructor(release) {
		this.#release = release;
	}

	get signal() {
		return this.#controller.signal;
	}

	add(frameId) {
		this.#frames.add(frameId);
	}

	notify(frameId) {
		if (this.#frames.has(frameId)) this.#controller.abort();
	}

	dispose() {
		this.#release(this);
	}
}

export class DebuggerConnection {
	#children = new Map();
	#watches = new Set();
	#closing = false;

	constructor(root) {
		this.root = root;
	}

	static async attach(tabId) {
		const root = new CdpSession({ tabId });
		try {
			await chrome.debugger.attach(root.debuggee, PROTOCOL_VERSION);
		} catch (error) {
			if (!STALE_SESSION.test(error?.message)) throw error;
			await chrome.debugger.detach(root.debuggee);
			await chrome.debugger.attach(root.debuggee, PROTOCOL_VERSION);
		}
		return new DebuggerConnection(root);
	}

	get isOpen() {
		return !this.#closing;
	}

	initialize() {
		return this.root.sendAll(SETUP);
	}

	async close({ graceful }) {
		this.#closing = true;
		if (graceful) {
			for (const [method, params] of TEARDOWN) {
				await this.root.send(method, params).catch(() => {});
			}
		}
		await chrome.debugger.detach(this.root.debuggee).catch(() => {});
		for (const session of this.#children.values()) session.close();
		this.#children.clear();
		this.root.close();
	}

	async *openSessions() {
		yield this.root;
		for (const session of [...this.#children.values()]) {
			await session.ready;
			if (!session.closed) yield session;
		}
	}

	sessionForTarget(targetId) {
		for (const session of this.#children.values()) {
			if (session.targetId === targetId) return session;
		}
		return null;
	}

	async parentOf(session) {
		if (!session.parentId) return this.root;
		const parent = this.#children.get(session.parentId);
		if (!parent) return null;
		await parent.ready;
		return parent.closed ? null : parent;
	}

	watchFrames() {
		const watch = new FrameWatch((released) => this.#watches.delete(released));
		this.#watches.add(watch);
		return watch;
	}

	handleEvent(source, method, params) {
		switch (method) {
			case "Page.frameNavigated":
				this.#frameChanged(params.frame?.id);
				break;
			case "Page.frameStartedLoading":
				this.#frameChanged(params.frameId);
				break;
			case "Target.targetInfoChanged":
				this.#targetChanged(params.targetInfo);
				break;
			case "Target.attachedToTarget":
				this.#attached(source.sessionId, params);
				break;
			case "Target.detachedFromTarget":
				this.#detached(params.sessionId);
				break;
		}
	}

	#frameChanged(frameId) {
		for (const watch of this.#watches) watch.notify(frameId);
	}

	#targetChanged(targetInfo) {
		if (!targetInfo?.targetId) return;
		this.#frameChanged(targetInfo.targetId);
		const session = this.sessionForTarget(targetInfo.targetId);
		if (session) session.targetInfo = targetInfo;
	}

	#attached(parentId = null, { sessionId, targetInfo }) {
		if (this.#closing || typeof sessionId !== "string" || this.#children.has(sessionId)) return;

		const debuggee = { tabId: this.root.debuggee.tabId, sessionId };
		const session = new CdpSession(debuggee, { parentId, targetInfo });
		this.#children.set(sessionId, session);
		session.ready = session.sendAll(SETUP).catch((error) => {
			// A busy frame answers late but still applies the commands in order.
			if (!(error instanceof CommandTimeoutError)) this.#drop(session);
		});
	}

	#detached(sessionId) {
		const session = this.#children.get(sessionId);
		if (session) this.#drop(session);
	}

	#drop(session) {
		session.close();
		if (this.#children.get(session.id) === session) this.#children.delete(session.id);
		for (const child of [...this.#children.values()]) {
			if (child.parentId === session.id) this.#drop(child);
		}
	}
}
