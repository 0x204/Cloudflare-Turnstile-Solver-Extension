import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { idle, SerialQueue, sleep, withTimeout } from "../extension/background/timing.js";

describe("sleep", () => {
	it("resolves after the delay", async () => {
		const started = performance.now();
		await sleep(20);
		assert.ok(performance.now() - started >= 15);
	});

	it("rejects with the abort reason", async () => {
		const controller = new AbortController();
		const pending = sleep(10_000, controller.signal);
		const reason = new Error("stop");
		controller.abort(reason);
		await assert.rejects(pending, (error) => error === reason);
	});

	it("rejects right away when the signal is already aborted", async () => {
		await assert.rejects(sleep(10_000, AbortSignal.abort()), { name: "AbortError" });
	});
});

describe("idle", () => {
	it("resolves early when aborted", async () => {
		const controller = new AbortController();
		const started = performance.now();
		const pending = idle(10_000, controller.signal);
		controller.abort();
		await pending;
		assert.ok(performance.now() - started < 1000);
	});
});

describe("withTimeout", () => {
	const late = () => new Error("late");

	it("passes the result through", async () => {
		assert.equal(await withTimeout(Promise.resolve(42), 1000, late), 42);
	});

	it("rejects with the provided error when the promise is too slow", async () => {
		const never = new Promise(() => {});
		await assert.rejects(withTimeout(never, 10, late), { message: "late" });
	});
});

describe("SerialQueue", () => {
	it("runs tasks for the same key one after another", async () => {
		const queue = new SerialQueue();
		const order = [];
		const first = queue.run("tab", async () => {
			await sleep(20);
			order.push("first");
		});
		const second = queue.run("tab", async () => {
			order.push("second");
		});
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first", "second"]);
	});

	it("keeps going after a task fails", async () => {
		const queue = new SerialQueue();
		const failed = queue.run("tab", async () => {
			throw new Error("boom");
		});
		const next = queue.run("tab", async () => "ok");
		await assert.rejects(failed, { message: "boom" });
		assert.equal(await next, "ok");
	});

	it("does not block other keys", async () => {
		const queue = new SerialQueue();
		const order = [];
		const slow = queue.run("a", async () => {
			await sleep(30);
			order.push("a");
		});
		const fast = queue.run("b", async () => {
			order.push("b");
		});
		await Promise.all([slow, fast]);
		assert.deepEqual(order, ["b", "a"]);
	});
});
