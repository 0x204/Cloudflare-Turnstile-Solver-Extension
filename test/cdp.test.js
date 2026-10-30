import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
	CdpSession,
	CommandTimeoutError,
	FatalProtocolError,
	isFatal,
	ProtocolError,
	tolerate,
} from "../extension/background/cdp.js";

function fakeDebugger(sendCommand) {
	globalThis.chrome = { debugger: { sendCommand } };
}

afterEach(() => {
	delete globalThis.chrome;
});

describe("isFatal", () => {
	it("treats a lost tab or debugger as fatal", () => {
		const messages = [
			"Debugger is not attached to the tab with id: 7.",
			"No tab with given id 7.",
			"Detached while handling command.",
		];
		for (const message of messages) assert.equal(isFatal(new ProtocolError(message)), true);
		assert.equal(isFatal(new FatalProtocolError("Mouse release failed")), true);
	});

	it("treats node errors, timeouts and non-protocol errors as recoverable", () => {
		const node = new ProtocolError('{"code":-32000,"message":"Could not find node with given id"}');
		assert.equal(isFatal(node), false);
		assert.equal(isFatal(new CommandTimeoutError("CDP command timed out: DOM.getDocument")), false);
		assert.equal(isFatal(new TypeError("Debugger is not attached")), false);
	});
});

describe("tolerate", () => {
	it("returns the fallback for recoverable protocol errors", async () => {
		const failed = Promise.reject(new ProtocolError("Could not compute box model."));
		assert.equal(await tolerate(failed, "fallback"), "fallback");
	});

	it("rethrows fatal protocol errors and programming errors", async () => {
		await assert.rejects(tolerate(Promise.reject(new FatalProtocolError("gone")), null), {
			name: "FatalProtocolError",
		});
		await assert.rejects(tolerate(Promise.reject(new TypeError("bug")), null), TypeError);
	});
});

describe("CdpSession", () => {
	it("wraps debugger errors in ProtocolError", async () => {
		fakeDebugger(async () => {
			throw new Error("No tab with given id 7.");
		});
		const session = new CdpSession({ tabId: 7 });
		await assert.rejects(session.send("DOM.enable"), (error) => {
			assert.ok(error instanceof ProtocolError);
			assert.equal(isFatal(error), true);
			return true;
		});
	});

	it("marks itself closed when the session is gone", async () => {
		fakeDebugger(async () => {
			throw new Error('{"code":-32001,"message":"Session with given id not found."}');
		});
		const session = new CdpSession({ tabId: 7, sessionId: "child" });
		await assert.rejects(session.send("DOM.enable"));
		assert.equal(session.closed, true);
		await assert.rejects(session.send("DOM.enable"), /session closed/);
	});

	it("rejects commands still in flight when it is closed", async () => {
		fakeDebugger(() => new Promise(() => {}));
		const session = new CdpSession({ tabId: 7, sessionId: "child" });
		const pending = session.send("DOM.getDocument");
		session.close();
		await assert.rejects(pending, (error) => error instanceof ProtocolError && !isFatal(error));
	});

	describe("with mocked timers", () => {
		beforeEach((t) => t.mock.timers.enable({ apis: ["setTimeout"] }));

		it("gives up on a silent command without treating it as fatal", async (t) => {
			fakeDebugger(() => new Promise(() => {}));
			const pending = new CdpSession({ tabId: 7 }).send("DOM.getDocument");
			t.mock.timers.tick(5000);
			await assert.rejects(pending, (error) => {
				assert.ok(error instanceof CommandTimeoutError);
				assert.equal(isFatal(error), false);
				return true;
			});
		});
	});
});
