import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkboxPoint } from "../extension/background/targeting.js";

function rect(left, top, width, height) {
	return [left, top, left + width, top, left + width, top + height, left, top + height];
}

describe("checkboxPoint", () => {
	it("aims at a fixed offset from the left edge whatever the widget width", () => {
		for (const width of [300, 450, 600, 800, 1000]) {
			const point = checkboxPoint(rect(0, 0, width, 65), width, 0);
			assert.equal(point.x, 35, `width=${width}`);
			assert.equal(point.y, 32.5);
		}
	});

	it("keeps the offset in the widget's own pixels when it is scaled", () => {
		const point = checkboxPoint(rect(100, 0, 210, 45.5), 300, 0);
		assert.ok(Math.abs(point.x - (100 + 35 * 0.7)) < 1e-9, `x=${point.x}`);
	});

	it("stays inside narrow widgets and moves right after misses", () => {
		const first = checkboxPoint(rect(0, 0, 150, 140), 150, 0);
		const later = checkboxPoint(rect(0, 0, 150, 140), 150, 3);
		assert.equal(first.x, 22.5);
		assert.ok(later.x > first.x && later.x <= 35, `x=${later.x}`);
	});
});
