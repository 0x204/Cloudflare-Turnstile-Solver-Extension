import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ProtocolError } from "../extension/background/cdp.js";
import { DebuggerConnection } from "../extension/background/connection.js";

const TAB_ID = 7;

function fakeDebugger({ attach = async () => {}, respond = async () => ({}) } = {}) {
	const calls = [];
	globalThis.chrome = {
		debugger: {
			attach: async (debuggee) => {
				calls.push(["attach", debuggee]);
				await attach(calls);
			},
			detach: async (debuggee) => calls.push(["detach", debuggee]),
			sendCommand: (debuggee, method, params) => {
				calls.push([method, debuggee.sessionId ?? null, params]);
				return respond(method, debuggee.sessionId ?? null);
			},
		},
	};
	return calls;
}

function attachChild(connection, sessionId, parentSessionId = undefined) {
	connection.handleEvent({ tabId: TAB_ID, sessionId: parentSessionId }, "Target.attachedToTarget", {
		sessionId,
		targetInfo: { targetId: `target-${sessionId}`, type: "iframe", url: "https://a.test/" },
	});
}

async function children(connection) {
	const sessions = [];
	for await (const session of connection.openSessions()) {
		if (!session.isRoot) sessions.push(session.id);
	}
	return sessions;
}

afterEach(() => {
	delete globalThis.chrome;
});

describe("DebuggerConnection", () => {
	it("replaces a session left behind by a previous service worker", async () => {
		let attempts = 0;
		const calls = fakeDebugger({
			attach: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw new Error(`Another debugger is already attached to the tab with id: ${TAB_ID}.`);
				}
			},
		});
		await DebuggerConnection.attach(TAB_ID);
		assert.deepEqual(
			calls.map(([name]) => name),
			["attach", "detach", "attach"],
		);
	});

	it("does not retry other attach failures", async () => {
		fakeDebugger({
			attach: async () => {
				throw new Error("Cannot access a chrome-extension:// URL of different extension");
			},
		});
		await assert.rejects(DebuggerConnection.attach(TAB_ID), /different extension/);
	});

	it("sets up child sessions and drops the ones that fail", async () => {
		const calls = fakeDebugger({
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
		fakeDebugger({
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
		fakeDebugger();
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
		const calls = fakeDebugger({
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
});
