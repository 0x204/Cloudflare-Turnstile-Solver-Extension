// Stand-ins for the chrome.* APIs the extension uses, shared by the unit tests.

export const EXTENSION_ID = "self";

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

export function fakeChrome({ storage = fakeStorage(), respond } = {}) {
	return {
		runtime: { id: EXTENSION_ID, onMessage: fakeEvent() },
		tabs: { onRemoved: fakeEvent() },
		storage: { session: storage },
		debugger: fakeDebugger({ respond }),
	};
}
