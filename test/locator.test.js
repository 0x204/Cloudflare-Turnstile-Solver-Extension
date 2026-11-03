import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CommandTimeoutError, isFatal } from "../extension/background/cdp.js";
import { locateWidget } from "../extension/background/locator.js";
import { connectToPage, flush, letCommandsTimeOut, TAB_ID, WIDGET_ID } from "./support.js";

afterEach(() => {
	delete globalThis.chrome;
});

describe("locateWidget", () => {
	it("finds the widget in a child frame", async () => {
		const connection = await connectToPage({ root: "empty", child: "widget" });
		const located = await locateWidget(connection, WIDGET_ID);
		assert.equal(located.session.id, "child");
		assert.equal(located.frame.frameId, "challenge");
	});

	it("reports the widget missing when no frame holds it", async () => {
		const connection = await connectToPage({ root: "empty", child: "empty" });
		assert.equal(await locateWidget(connection, WIDGET_ID), null);
	});

	describe("with mocked timers", () => {
		beforeEach((t) => t.mock.timers.enable({ apis: ["setTimeout"] }));

		it("fails instead of reporting the widget missing when a frame does not answer", async (t) => {
			const connection = await connectToPage({ root: "empty", busy: "silent" });
			const failed = assert.rejects(locateWidget(connection, WIDGET_ID), CommandTimeoutError);
			await letCommandsTimeOut(t, 2);
			await failed;
		});

		it("stops at once when the debugger is gone", async () => {
			const connection = await connectToPage(
				{ root: "empty", busy: "silent" },
				{
					"DOM.getDocument": () => {
						throw new Error(`Debugger is not attached to the tab with id: ${TAB_ID}.`);
					},
				},
			);
			let error = null;
			locateWidget(connection, WIDGET_ID).catch((reason) => (error = reason));
			await flush();

			assert.equal(isFatal(error), true);
		});

		it("finds the widget without waiting for a frame that does not answer", async () => {
			const connection = await connectToPage({ root: "empty", busy: "silent", holder: "widget" });
			let located = null;
			locateWidget(connection, WIDGET_ID).then((result) => (located = result));
			await flush();

			assert.equal(located?.session.id, "holder");
		});
	});
});
