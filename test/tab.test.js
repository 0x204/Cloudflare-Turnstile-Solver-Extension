import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { FatalProtocolError } from "../extension/background/cdp.js";
import { Tab } from "../extension/background/tab.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

// Workers of one tab id run one after another, so every test gets its own tab.
let nextTabId = 1;

function fakeConnection() {
	return {
		isOpen: true,
		closedWith: null,
		async initialize() {},
		async close(options) {
			this.isOpen = false;
			this.closedWith = options;
		},
		handleEvent() {},
	};
}

function setup(t, solve, { attached = Promise.resolve() } = {}) {
	const connection = fakeConnection();
	const state = { connection, attaches: 0, idle: 0, solves: 0 };
	const tab = new Tab(
		nextTabId++,
		(released) => {
			state.idle += 1;
			released.cancel();
		},
		{
			attach: async () => {
				state.attaches += 1;
				await attached;
				return connection;
			},
			solve: async (...args) => {
				state.solves += 1;
				return solve(...args);
			},
		},
	);

	t.after(() => tab.cancel());
	state.advance = async (ms, step = 50) => {
		for (let elapsed = 0; elapsed < ms; elapsed += step) {
			t.mock.timers.tick(step);
			await flush();
		}
	};
	return { tab, state };
}

describe("Tab", () => {
	beforeEach((t) => t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 }));

	it("stops clicking after two clicks and releases the debugger", async (t) => {
		const { tab, state } = setup(t, async () => true);
		tab.begin("doc:w", "w");
		await state.advance(20_000);

		assert.equal(state.solves, 2);
		assert.equal(state.idle, 1);
		assert.deepEqual(state.connection.closedWith, { graceful: true });
	});

	it("aborts the attempt in progress when the widget ends", async (t) => {
		let aborted = false;
		const { tab, state } = setup(t, (connection, job, signal) => {
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve(false);
				});
			});
		});
		tab.begin("doc:w", "w");
		await state.advance(100);
		tab.end("doc:w");
		await state.advance(100);

		assert.equal(aborted, true);
		assert.equal(state.idle, 1);
	});

	it("drops a widget that stays missing from the page", async (t) => {
		const { tab, state } = setup(t, async (connection, job) => {
			job.recordNotFound();
			return false;
		});
		tab.begin("doc:w", "w");
		await state.advance(7000);

		assert.equal(state.idle, 1);
		assert.ok(state.solves < 15, `solves=${state.solves}`);
	});

	it("keeps waiting between clicks without counting the widget as missing", async (t) => {
		let attempts = 0;
		const { tab, state } = setup(t, async (connection, job) => {
			attempts += 1;
			job.recordFound();
			return true;
		});
		tab.begin("doc:w", "w");
		await state.advance(8000);
		assert.equal(attempts, 2);
	});

	it("closes without teardown and drops all widgets after a fatal error", async (t) => {
		const { tab, state } = setup(t, async () => {
			throw new FatalProtocolError("Debugger is not attached to the tab with id: 1.");
		});
		tab.begin("doc:a", "a");
		tab.begin("doc:b", "b");
		await state.advance(500);

		assert.equal(state.solves, 1);
		assert.equal(state.idle, 1);
		assert.deepEqual(state.connection.closedWith, { graceful: false });
	});

	it("does not solve anything when cancelled while attaching", async (t) => {
		let finishAttach;
		const { tab, state } = setup(t, async () => true, {
			attached: new Promise((resolve) => (finishAttach = resolve)),
		});
		tab.begin("doc:w", "w");
		await state.advance(100);
		assert.equal(state.attaches, 1);

		tab.cancel();
		finishAttach();
		await state.advance(500);

		assert.equal(state.solves, 0);
		assert.equal(state.connection.isOpen, false);
	});

	it("gives a widget new clicks when it asks for interaction again", async (t) => {
		const { tab, state } = setup(t, async () => true);
		tab.begin("doc:w", "w");
		await state.advance(7000);
		assert.equal(state.solves, 2);

		tab.begin("doc:w", "w");
		await state.advance(500);
		assert.equal(state.solves, 3);
	});
});
