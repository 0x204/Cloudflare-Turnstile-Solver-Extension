import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import "../extension/shared.js";

const { Action } = globalThis.TurnstileProtocol;
const EXTENSION_ID = "self";

let chrome;

function fakeEvent() {
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

function fakeChrome() {
	const stored = {};
	const attached = [];
	return {
		attached,
		stored,
		runtime: { id: EXTENSION_ID, onMessage: fakeEvent() },
		tabs: { onRemoved: fakeEvent() },
		storage: {
			session: {
				get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
				set: async (items) => Object.assign(stored, items),
			},
		},
		debugger: {
			onDetach: fakeEvent(),
			onEvent: fakeEvent(),
			attach: async ({ tabId }) => attached.push(tabId),
			detach: async () => {},
			sendCommand: async (debuggee, method) =>
				method === "DOM.performSearch" ? { searchId: "search", resultCount: 0 } : {},
		},
	};
}

function begin(tabId, { extensionId = EXTENSION_ID } = {}) {
	const message = { action: Action.BEGIN, widgetId: "w" };
	const sender = { id: extensionId, tab: { id: tabId }, documentId: `doc-${tabId}` };
	chrome.runtime.onMessage.emit(message, sender);
}

describe("service worker routing", () => {
	before(async () => {
		chrome = globalThis.chrome = fakeChrome();
		await import("../extension/background/index.js");
		await sleep(10);
	});

	after(async () => {
		for (const tabId of [1, 2, 3]) chrome.tabs.onRemoved.emit(tabId);
		await sleep(50);
		delete globalThis.chrome;
	});

	it("does not watch tab closing while it has nothing to clean up", () => {
		assert.equal(chrome.tabs.onRemoved.size, 0);
	});

	it("attaches the debugger when a widget asks for interaction", async () => {
		begin(1);
		await sleep(20);
		assert.deepEqual(chrome.attached, [1]);
		assert.equal(chrome.tabs.onRemoved.size, 1);
	});

	it("ignores messages from other extensions", async () => {
		begin(2, { extensionId: "other" });
		await sleep(20);
		assert.equal(chrome.attached.includes(2), false);
	});

	it("leaves a tab alone after the user cancels debugging, until the tab closes", async () => {
		begin(3);
		await sleep(20);
		chrome.debugger.onDetach.emit({ tabId: 3 }, "canceled_by_user");
		await sleep(20);
		assert.deepEqual(chrome.stored.declinedTabs, [3]);

		begin(3);
		await sleep(20);
		assert.equal(chrome.attached.filter((tabId) => tabId === 3).length, 1);

		chrome.tabs.onRemoved.emit(3);
		await sleep(20);
		assert.deepEqual(chrome.stored.declinedTabs, []);
	});
});
