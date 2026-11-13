import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClickBudget } from "../extension/background/budget.js";
import { fakeStorage } from "./support.js";

const NOW = 1_000_000;
const MINUTE = 60_000;

function spendAll(budget, tabId, now = NOW) {
	for (let click = 0; click < 10; click++) budget.spend(tabId, now);
}

describe("ClickBudget", () => {
	it("allows ten clicks in a tab", () => {
		const budget = new ClickBudget(fakeStorage());
		for (let click = 0; click < 10; click++) {
			assert.equal(budget.allows(1, NOW), true, `click ${click + 1}`);
			budget.spend(1, NOW);
		}
		assert.equal(budget.allows(1, NOW), false);
	});

	it("counts every tab on its own", () => {
		const budget = new ClickBudget(fakeStorage());
		spendAll(budget, 1);
		assert.equal(budget.allows(2, NOW), true);
	});

	it("allows clicks again ten minutes after the ones that used it up", () => {
		const budget = new ClickBudget(fakeStorage());
		spendAll(budget, 1);
		assert.equal(budget.allows(1, NOW + 10 * MINUTE - 1), false);
		assert.equal(budget.allows(1, NOW + 10 * MINUTE), true);
	});

	it("remembers the clicks across a service worker restart", async () => {
		const storage = fakeStorage();
		const before = new ClickBudget(storage);
		spendAll(before, 1);
		await before.spend(2, NOW);

		const after = new ClickBudget(storage);
		await after.load();
		assert.equal(after.allows(1, NOW), false);
		assert.equal(after.allows(2, NOW), true);
	});

	it("stops storing a tab whose clicks are all older than ten minutes", async () => {
		const storage = fakeStorage();
		const budget = new ClickBudget(storage);
		await budget.spend(1, NOW);
		await budget.spend(2, NOW + 10 * MINUTE);

		assert.deepEqual(Object.keys(storage.data.clickTimes), ["2"]);
	});
});
