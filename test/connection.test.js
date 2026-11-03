import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ProtocolError } from "../extension/background/cdp.js";
import { DebuggerConnection } from "../extension/background/connection.js";
import { flush, installDebugger, letCommandsTimeOut, never, TAB_ID } from "./support.js";

const ALREADY_ATTACHED = `Another debugger is already attached to the tab with id: ${TAB_ID}.`;

function attachChild(connection, sessionId, parentSessionId = undefined) {
	connection.handleEvent({ tabId: TAB_ID, sessionId: parentSessionId }, "Target.attachedToTarget", {
		sessionId,
		targetInfo: { targetId: `target-${sessionId}`, type: "iframe", url: "https://a.test/" },
	});
}

async function children(connection) {
	const sessions = connection.sessions().filter((session) => !session.isRoot);
	await Promise.all(sessions.map((session) => session.ready));
	return sessions.filter((session) => !session.closed).map((session) => session.id);
}

afterEach(() => {
	delete globalThis.chrome;
});

describe("DebuggerConnection", () => {
	it("replaces a session left behind by a previous service worker", async () => {
		let attempts = 0;
		const { calls } = installDebugger({
			attach: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error(ALREADY_ATTACHED);
			},
		});
		await DebuggerConnection.attach(TAB_ID);
		assert.deepEqual(
			calls.map(([name]) => name),
			["attach", "detach", "attach"],
		);
	});

	it("attaches when the session left behind is gone by the time it is detached", async () => {
		let attempts = 0;
		installDebugger({
			attach: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error(ALREADY_ATTACHED);
			},
			detach: async () => {
				throw new Error(`Debugger is not attached to the tab with id: ${TAB_ID}.`);
			},
		});
		await DebuggerConnection.attach(TAB_ID);
		assert.equal(attempts, 2);
	});

	it("does not retry other attach failures", async () => {
		installDebugger({
			attach: async () => {
				throw new Error("Cannot access a chrome-extension:// URL of different extension");
			},
		});
		await assert.rejects(DebuggerConnection.attach(TAB_ID), /different extension/);
	});

	it("sets up child sessions and drops the ones that fail", async () => {
		const { calls } = installDebugger({
			respond: async (method, sessionId) => {
				if (sessionId === "broken" && method === "DOM.enable") throw new Error("Not supported");
				return {};
			},
		});
		const connection = await DebuggerConnection.attach(TAB_ID);
		attachChild(connection, "good");
		attachChild(connection, "broken");

		assert.deepEqual(await children(connection), ["good"]);
		assert.ok(
			calls.some(([method, sessionId]) => method === "Page.enable" && sessionId === "good"),
		);
	});

	it("rejects pending commands and drops descendants when a frame detaches", async () => {
		installDebugger({
			respond: async (method) => (method === "DOM.getDocument" ? new Promise(() => {}) : {}),
		});
		const connection = await DebuggerConnection.attach(TAB_ID);
		attachChild(connection, "outer");
		attachChild(connection, "inner", "outer");
		await children(connection);

		const outer = connection.sessionForTarget("target-outer");
		const pending = outer.send("DOM.getDocument");
		connection.handleEvent({ tabId: TAB_ID }, "Target.detachedFromTarget", { sessionId: "outer" });

		await assert.rejects(pending, ProtocolError);
		assert.deepEqual(await children(connection), []);
	});

	it("aborts a frame watch when a watched frame navigates", async () => {
		installDebugger();
		const connection = await DebuggerConnection.attach(TAB_ID);
		const watch = connection.watchFrames();
		watch.add("frame-1");

		connection.handleEvent({ tabId: TAB_ID }, "Page.frameStartedLoading", { frameId: "frame-2" });
		assert.equal(watch.signal.aborted, false);
		connection.handleEvent({ tabId: TAB_ID }, "Page.frameStartedLoading", { frameId: "frame-1" });
		assert.equal(watch.signal.aborted, true);
		watch.dispose();
	});

	it("detaches even when teardown commands fail and ignores later attachments", async () => {
		const { calls } = installDebugger({
			respond: async (method) => {
				if (method.endsWith(".disable")) throw new Error("Not enabled");
				return {};
			},
		});
		const connection = await DebuggerConnection.attach(TAB_ID);
		await connection.close({ graceful: true });

		assert.equal(connection.isOpen, false);
		assert.equal(calls.at(-1)[0], "detach");
		attachChild(connection, "late");
		assert.deepEqual(await children(connection), []);
	});

	describe("with mocked timers", () => {
		beforeEach((t) => t.mock.timers.enable({ apis: ["setTimeout"] }));

		it("finishes setting up a child frame that answers late", async (t) => {
			const { calls } = installDebugger({
				respond: async (method, sessionId) =>
					sessionId === "busy" && method === "DOM.enable" ? never() : {},
			});
			const connection = await DebuggerConnection.attach(TAB_ID);
			attachChild(connection, "busy");
			await letCommandsTimeOut(t);

			assert.deepEqual(await children(connection), ["busy"]);
			const sent = calls.filter(([, sessionId]) => sessionId === "busy").map(([method]) => method);
			for (const method of ["CSS.enable", "Page.enable", "Emulation.setFocusEmulationEnabled"]) {
				assert.ok(sent.includes(method), `${method} was not sent`);
			}
		});

		it("detaches after one command timeout when the page does not answer teardown", async (t) => {
			const { calls } = installDebugger({ respond: never });
			const connection = await DebuggerConnection.attach(TAB_ID);
			connection.close({ graceful: true });
			await letCommandsTimeOut(t);
			await flush();

			assert.equal(calls.at(-1)[0], "detach");
		});
	});
});
