import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import "../extension/shared.js";
import { EXTENSION_ID } from "./support.js";

const { Action } = globalThis.TurnstileProtocol;

let pages = 0;

async function openPage() {
	const listeners = new Map();
	const sent = [];
	globalThis.window = {
		addEventListener: (type, listener) => listeners.set(type, listener),
	};
	globalThis.chrome = {
		runtime: { id: EXTENSION_ID, sendMessage: async (message) => sent.push(message) },
	};

	pages += 1;
	await import(`../extension/content/relay.js?page=${pages}`);

	const dispatch = (type, event) => listeners.get(type)?.(event);
	return {
		sent,
		challenge: (event, widgetId) =>
			dispatch("message", {
				isTrusted: true,
				origin: "https://challenges.cloudflare.com",
				source: {},
				data: { source: "cloudflare-challenge", event, widgetId },
			}),
		hide: (persisted) => dispatch("pagehide", { persisted }),
		show: (persisted) => dispatch("pageshow", { persisted }),
	};
}

const begin = (widgetId) => ({ action: Action.BEGIN, widgetId });
const end = (widgetId) => ({ action: Action.END, widgetId });

afterEach(() => {
	delete globalThis.window;
	delete globalThis.chrome;
});

describe("relay", () => {
	it("ends the widgets still waiting when the page goes away", async () => {
		const page = await openPage();
		page.challenge("interactiveBegin", "a");
		page.challenge("interactiveBegin", "b");
		page.challenge("complete", "b");
		page.hide(false);

		assert.deepEqual(page.sent, [begin("a"), begin("b"), end("b"), end("a")]);
	});

	it("starts the waiting widgets again when the page comes back from the cache", async () => {
		const page = await openPage();
		page.challenge("interactiveBegin", "a");
		page.challenge("interactiveBegin", "b");
		page.challenge("complete", "b");
		page.hide(true);
		page.show(true);

		assert.deepEqual(page.sent.slice(3), [end("a"), begin("a")]);
	});

	it("does not repeat a widget when the page is first shown after it began", async () => {
		const page = await openPage();
		page.challenge("interactiveBegin", "a");
		page.show(false);

		assert.deepEqual(page.sent, [begin("a")]);
	});
});
