import { DebuggerConnection } from "../extension/background/connection.js";

export const EXTENSION_ID = "self";
export const TAB_ID = 7;
export const WIDGET_ID = "abc";

const COMMAND_TIMEOUT_MS = 5000;
const CHALLENGE_URL = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/abc";

export const never = () => new Promise(() => {});

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export async function letCommandsTimeOut(t, rounds = 1) {
	for (let round = 0; round < rounds; round++) {
		await flush();
		t.mock.timers.tick(COMMAND_TIMEOUT_MS);
	}
}

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

export function fakeStorage(initial = {}) {
	const data = { ...initial };
	let gate = Promise.resolve();
	return {
		data,
		hold() {
			const { promise, resolve } = Promise.withResolvers();
			gate = promise;
			return resolve;
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

export function fakeChrome({ storage = fakeStorage(), respond } = {}) {
	return {
		runtime: { id: EXTENSION_ID, onMessage: fakeEvent() },
		tabs: { onRemoved: fakeEvent() },
		storage: { session: storage },
		debugger: fakeDebugger({ respond }),
	};
}

function fakePage(frames, overrides) {
	return async (method, sessionId, params) => {
		const content = frames[sessionId ?? "root"];
		if (content === "silent") return never();
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
