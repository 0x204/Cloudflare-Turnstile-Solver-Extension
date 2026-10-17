import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { humanDelay, jitter, randomInt } from "../extension/background/random.js";

describe("randomInt", () => {
	it("includes both bounds", (t) => {
		const random = t.mock.method(Math, "random", () => 0);
		assert.equal(randomInt(3, 5), 3);

		random.mock.mockImplementation(() => 0.999_999);
		assert.equal(randomInt(3, 5), 5);
	});

	it("covers the whole range evenly", () => {
		const counts = new Map();
		for (let index = 0; index < 30_000; index++) {
			const value = randomInt(3, 5);
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
		assert.deepEqual([...counts.keys()].sort(), [3, 4, 5]);
		for (const count of counts.values()) assert.ok(count > 9000 && count < 11_000, String(count));
	});
});

describe("jitter", () => {
	it("stays within the amplitude", () => {
		for (let index = 0; index < 1000; index++) {
			const value = jitter(2);
			assert.ok(Number.isInteger(value) && value >= -2 && value <= 2, String(value));
		}
	});
});

describe("humanDelay", () => {
	const profile = { mean: 18, deviation: 6, min: 7, max: 42 };

	it("clamps the normal distribution to the profile limits", () => {
		const wide = { ...profile, deviation: 30 };
		for (let index = 0; index < 1000; index++) {
			const value = humanDelay(wide);
			assert.ok(Number.isInteger(value) && value >= 7 && value <= 42, String(value));
		}
	});

	it("survives Math.random returning zero", (t) => {
		t.mock.method(Math, "random", () => 0);
		assert.equal(Number.isFinite(humanDelay(profile)), true);
	});
});
