import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CommandTimeoutError } from "../extension/background/cdp.js";
import { Outcome, WidgetJob } from "../extension/background/job.js";
import { solveWidget } from "../extension/background/solver.js";
import { connectToPage, letCommandsTimeOut, WIDGET_ID } from "./support.js";

function solve(connection) {
	const job = new WidgetJob(`doc:${WIDGET_ID}`, WIDGET_ID);
	return solveWidget(connection, job, new AbortController().signal);
}

afterEach(() => {
	delete globalThis.chrome;
});

describe("solveWidget", () => {
	it("reports a widget that no frame holds as not found", async () => {
		const connection = await connectToPage({ root: "empty", child: "empty" });
		assert.equal(await solve(connection), Outcome.NOT_FOUND);
	});

	it("reports a miss when the widget has no layout box to scroll to", async () => {
		const connection = await connectToPage(
			{ root: "widget" },
			{
				"DOM.scrollIntoViewIfNeeded": () => {
					throw new Error('{"code":-32000,"message":"Node does not have a layout object"}');
				},
			},
		);
		assert.equal(await solve(connection), Outcome.MISSED);
	});

	it("lets a failed search through instead of reporting the widget as not found", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const connection = await connectToPage({ root: "empty", busy: "silent" });
		const failed = assert.rejects(solve(connection), CommandTimeoutError);
		await letCommandsTimeOut(t, 2);
		await failed;
	});
});
