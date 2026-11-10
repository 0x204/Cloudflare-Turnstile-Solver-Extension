import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ClickBudget } from "../extension/background/budget.js";

describe("ClickBudget", () => {
	it("allows six clicks in a document", () => {
		const budget = new ClickBudget();
		for (let click = 0; click < 6; click++) {
			assert.equal(budget.allows("doc"), true, `click ${click + 1}`);
			budget.spend("doc");
		}
		assert.equal(budget.allows("doc"), false);
	});

	it("counts every document on its own", () => {
		const budget = new ClickBudget();
		for (let click = 0; click < 6; click++) budget.spend("doc-a");
		assert.equal(budget.allows("doc-b"), true);
	});
});
