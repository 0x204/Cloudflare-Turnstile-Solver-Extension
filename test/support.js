// Stand-ins for the chrome.* APIs the extension uses, shared by the unit tests.

import { DebuggerConnection } from "../extension/background/connection.js";

export const EXTENSION_ID = "self";
export const WIDGET_ID = "abc";

const TAB_ID = 7;
const CHALLENGE_URL = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/abc";

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function fakeEvent() {
	const listeners = new Set();
	return {
		addListener: (listener) => listeners.add(listener),
		removeListener: (listener) => listeners.delete(listener),
		hasListener: (listener) => listeners.has(listener),
		emit: (...args) => [...listeners].map((listener) => listener(...args)),
		get size() {
			return listeners.size;
		},
	};
}

// Records every call as [name, ...details]. A `respond` that returns a promise which never
// settles plays a frame that does not answer.
export function fakeDebugger({
	attach = async () => {},
	detach = async () => {},
	respond = async () => ({}),
} = {}) {
	const calls = [];
	return {
		calls,
		onDetach: fakeEvent(),
		onEvent: fakeEvent(),
		async attach(debuggee) {
			calls.push(["attach", debuggee]);
			await attach(debuggee);
		},
		async detach(debuggee) {
			calls.push(["detach", debuggee]);
			await detach(debuggee);
		},
		async sendCommand(debuggee, method, params) {
			const sessionId = debuggee.sessionId ?? null;
			calls.push([method, sessionId, params]);
			return respond(method, sessionId, params);
		},
	};
}

export function installDebugger(options) {
	globalThis.chrome = { debugger: fakeDebugger(options) };
	return globalThis.chrome.debugger;
}

// chrome.storage.session. While held, reads and writes wait, as they do on a slow disk.
export function fakeStorage(initial = {}) {
	const data = { ...initial };
	let gate = Promise.resolve();
	return {
		data,
		hold() {
			let release;
			gate = new Promise((resolve) => (release = resolve));
			return release;
		},
		async get(key) {
			await gate;
			return key in data ? { [key]: data[key] } : {};
		},
		async set(items) {
			await gate;
			Object.assign(data, items);
		},
	};
}

// Answers for a page whose frames each hold the widget, hold nothing, or never answer.
// `overrides` replaces the answer to single commands.
function fakePage(frames, overrides) {
	return async (method, sessionId, params) => {
		const content = frames[sessionId ?? "root"];
		if (content === "silent") return new Promise(() => {});
		if (method in overrides) return overrides[method](sessionId, params);

		switch (method) {
			case "DOM.performSearch":
				return { searchId: "search", resultCount: content === "widget" ? 1 : 0 };
			case "DOM.getSearchResults":
				return { nodeIds: [10] };
			case "DOM.describeNode":
				return {
					node: {
						nodeName: "IFRAME",
						backendNodeId: 20,
						frameId: "challenge",
						attributes: ["id", `cf-chl-widget-${WIDGET_ID}`, "src", CHALLENGE_URL],
					},
				};
			case "Page.getFrameTree":
				return {
					frameTree: {
						frame: { id: "main", url: "https://a.test/" },
						childFrames: [{ frame: { id: "challenge", url: CHALLENGE_URL } }],
					},
				};
			default:
				return {};
		}
	};
}

// `frames` maps session ids to "widget", "empty" or "silent"; "root" is the tab itself.
export async function connectToPage(frames, overrides = {}) {
	installDebugger({ respond: fakePage(frames, overrides) });
	const connection = await DebuggerConnection.attach(TAB_ID);
	for (const sessionId of Object.keys(frames)) {
		if (sessionId === "root") continue;
		connection.handleEvent({ tabId: TAB_ID }, "Target.attachedToTarget", {
			sessionId,
			targetInfo: { targetId: `target-${sessionId}`, type: "iframe", url: "https://b.test/" },
		});
	}
	return connection;
}

export function fakeChrome({ storage = fakeStorage(), respond } = {}) {
	return {
		runtime: { id: EXTENSION_ID, onMessage: fakeEvent() },
		tabs: { onRemoved: fakeEvent() },
		storage: { session: storage },
		debugger: fakeDebugger({ respond }),
	};
}
