import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import "../extension/shared.js";
import { EXTENSION_ID, fakeChrome, fakeStorage } from "./support.js";

const { Action } = globalThis.TurnstileProtocol;

const emptyPage = async (method) =>
	method === "DOM.performSearch" ? { searchId: "search", resultCount: 0 } : {};

let workers = 0;

async function startWorker(t, options = {}) {
	const chrome = fakeChrome({ respond: emptyPage, ...options });
	globalThis.chrome = chrome;
	t.after(async () => {
		for (const tabId of attachedTabs(chrome)) chrome.tabs.onRemoved.emit(tabId);
		await sleep(50);
		delete globalThis.chrome;
	});

	workers += 1;
	await import(`../extension/background/index.js?worker=${workers}`);
	return chrome;
}

function attachedTabs(chrome) {
	return chrome.debugger.calls.filter(([name]) => name === "attach").map(([, { tabId }]) => tabId);
}

function begin(chrome, tabId, { extensionId = EXTENSION_ID } = {}) {
	const message = { action: Action.BEGIN, widgetId: "w" };
	const sender = { id: extensionId, tab: { id: tabId }, documentId: `doc-${tabId}` };
	chrome.runtime.onMessage.emit(message, sender);
}

describe("service worker", () => {
	it("does not watch tab closing while it has nothing to clean up", async (t) => {
		const chrome = await startWorker(t);
		await sleep(10);
		assert.equal(chrome.tabs.onRemoved.size, 0);
	});

	it("attaches the debugger when a widget asks for interaction", async (t) => {
		const chrome = await startWorker(t);
		begin(chrome, 1);
		await sleep(20);
		assert.deepEqual(attachedTabs(chrome), [1]);
		assert.equal(chrome.tabs.onRemoved.size, 1);
	});

	it("ignores messages from other extensions", async (t) => {
		const chrome = await startWorker(t);
		begin(chrome, 2, { extensionId: "other" });
		await sleep(20);
		assert.deepEqual(attachedTabs(chrome), []);
	});

	it("leaves a tab alone after the user cancels debugging, until the tab closes", async (t) => {
		const chrome = await startWorker(t);
		const stored = chrome.storage.session.data;
		begin(chrome, 3);
		await sleep(20);
		chrome.debugger.onDetach.emit({ tabId: 3 }, "canceled_by_user");
		await sleep(20);
		assert.deepEqual(stored.declinedTabs, [3]);

		begin(chrome, 3);
		await sleep(20);
		assert.deepEqual(attachedTabs(chrome), [3]);

		chrome.tabs.onRemoved.emit(3);
		await sleep(20);
		assert.deepEqual(stored.declinedTabs, []);
	});

	it("keeps watching tab closing while a declined tab is being saved", async (t) => {
		const chrome = await startWorker(t);
		const storage = chrome.storage.session;
		begin(chrome, 4);
		await sleep(20);

		const release = storage.hold();
		chrome.debugger.onDetach.emit({ tabId: 4 }, "canceled_by_user");
		await sleep(10);
		chrome.tabs.onRemoved.emit(4);
		release();
		await sleep(20);

		assert.deepEqual(storage.data.declinedTabs, []);
		assert.equal(chrome.tabs.onRemoved.size, 0);
	});

	describe("while the declined tabs are still loading", () => {
		it("forgets a declined tab whose closing woke the worker", async (t) => {
			const storage = fakeStorage({ declinedTabs: [5] });
			const release = storage.hold();
			const chrome = await startWorker(t, { storage });

			chrome.tabs.onRemoved.emit(5);
			release();
			await sleep(10);

			assert.deepEqual(storage.data.declinedTabs, []);
			assert.equal(chrome.tabs.onRemoved.size, 0);
		});

		it("keeps the tabs declined earlier when another tab is declined", async (t) => {
			const storage = fakeStorage({ declinedTabs: [5] });
			const release = storage.hold();
			const chrome = await startWorker(t, { storage });

			chrome.debugger.onDetach.emit({ tabId: 12 }, "canceled_by_user");
			release();
			await sleep(10);

			assert.deepEqual(storage.data.declinedTabs, [5, 12]);
		});
	});
});
