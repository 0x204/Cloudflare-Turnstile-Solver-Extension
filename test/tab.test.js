import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ClickBudget } from "../extension/background/budget.js";
import { CommandTimeoutError, FatalProtocolError } from "../extension/background/cdp.js";
import { Outcome } from "../extension/background/job.js";
import { Tab } from "../extension/background/tab.js";
import { fakeStorage, flush } from "./support.js";

let nextTabId = 1;

function fakeConnection(initialize) {
	return {
		isOpen: true,
		initialize,
		async close() {
			this.isOpen = false;
		},
		handleEvent() {},
	};
}

function setup(t, solve, { attached = Promise.resolve(), initialize = async () => {} } = {}) {
	const connection = fakeConnection(initialize);
	const state = { connection, attaches: 0, idle: 0, solves: 0 };
	const tab = new Tab(
		nextTabId++,
		(released) => {
			state.idle += 1;
			released.cancel();
		},
		new ClickBudget(fakeStorage()),
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
		const { tab, state } = setup(t, async () => Outcome.CLICKED);
		tab.begin("doc:w", "w");
		await state.advance(20_000);

		assert.equal(state.solves, 2);
		assert.equal(state.idle, 1);
		assert.equal(state.connection.isOpen, false);
	});

	it("counts an approach abandoned before the press as a click", async (t) => {
		const { tab, state } = setup(t, async () => Outcome.ABANDONED);
		tab.begin("doc:w", "w");
		await state.advance(5000);

		assert.equal(state.solves, 2);
		assert.equal(state.idle, 1);
	});

	it("aborts the attempt in progress when the widget ends", async (t) => {
		let aborted = false;
		const { tab, state } = setup(t, (connection, job, signal) => {
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve(Outcome.MISSED);
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
		const { tab, state } = setup(t, async () => Outcome.NOT_FOUND);
		tab.begin("doc:w", "w");
		await state.advance(7000);

		assert.equal(state.idle, 1);
		assert.ok(state.solves < 15, `solves=${state.solves}`);
	});

	it("keeps a widget whose search keeps failing until its deadline", async (t) => {
		let attempts = 0;
		const { tab, state } = setup(t, async () => {
			attempts += 1;
			if (attempts === 1) return Outcome.NOT_FOUND;
			throw new CommandTimeoutError("CDP command timed out: DOM.getDocument");
		});
		tab.begin("doc:w", "w");
		await state.advance(10_000);
		assert.equal(state.idle, 0);

		await state.advance(21_000);
		assert.equal(state.idle, 1);
	});

	it("keeps waiting between clicks without counting the widget as missing", async (t) => {
		let attempts = 0;
		const { tab, state } = setup(t, async () => {
			attempts += 1;
			return Outcome.CLICKED;
		});
		tab.begin("doc:w", "w");
		await state.advance(8000);
		assert.equal(attempts, 2);
	});

	it("detaches and drops all widgets after a fatal error", async (t) => {
		const { tab, state } = setup(t, async () => {
			throw new FatalProtocolError("Debugger is not attached to the tab with id: 1.");
		});
		tab.begin("doc:a", "a");
		tab.begin("doc:b", "b");
		await state.advance(500);

		assert.equal(state.solves, 1);
		assert.equal(state.idle, 1);
		assert.equal(state.connection.isOpen, false);
	});

	it("detaches when the page does not answer setup", async (t) => {
		const { tab, state } = setup(t, async () => Outcome.CLICKED, {
			initialize: async () => {
				throw new CommandTimeoutError("CDP command timed out: DOM.enable");
			},
		});
		tab.begin("doc:w", "w");
		await state.advance(100);

		assert.equal(state.solves, 0);
		assert.equal(state.connection.isOpen, false);
	});

	it("does not solve anything when cancelled while attaching", async (t) => {
		let finishAttach;
		const { tab, state } = setup(t, async () => Outcome.CLICKED, {
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
		const { tab, state } = setup(t, async () => Outcome.CLICKED);
		tab.begin("doc:w", "w");
		await state.advance(7000);
		assert.equal(state.solves, 2);

		tab.begin("doc:w", "w");
		await state.advance(500);
		assert.equal(state.solves, 3);
	});

	it("stops clicking once the tab has used up its clicks", async (t) => {
		const { tab, state } = setup(t, async () => Outcome.CLICKED);
		for (let round = 0; round < 7; round++) {
			tab.begin(`doc-${round}:w`, "w");
			await state.advance(7000);
		}

		assert.equal(state.solves, 10);
	});

	it("keeps an attempt going when the widget asks again before the old deadline", async (t) => {
		let aborted = false;
		const { tab, state } = setup(t, (connection, job, signal) => {
			return new Promise((resolve) => {
				signal.addEventListener("abort", () => {
					aborted = true;
					resolve(Outcome.MISSED);
				});
			});
		});
		tab.begin("doc:w", "w");
		await state.advance(29_000);
		tab.begin("doc:w", "w");
		await state.advance(2000);
		assert.equal(aborted, false);

		await state.advance(29_000);
		assert.equal(aborted, true);
	});
});
