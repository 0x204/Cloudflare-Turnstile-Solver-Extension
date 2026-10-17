import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	clamp,
	clampToRect,
	insetRect,
	isInViewport,
	isParallelogram,
	quadBounds,
	quadPoint,
	quadSize,
	sameQuad,
	samePoint,
	sameSize,
	visibleBounds,
} from "../extension/background/geometry.js";

const rect = [10, 20, 110, 20, 110, 70, 10, 70];
const rotated = [50, 0, 100, 50, 50, 100, 0, 50];

describe("clamp", () => {
	it("keeps values inside the range", () => {
		assert.equal(clamp(5, 0, 10), 5);
		assert.equal(clamp(-5, 0, 10), 0);
		assert.equal(clamp(15, 0, 10), 10);
	});
});

describe("isParallelogram", () => {
	it("accepts rectangles and rotated squares", () => {
		assert.equal(isParallelogram(rect), true);
		assert.equal(isParallelogram(rotated), true);
	});

	it("rejects trapezoids and malformed quads", () => {
		assert.equal(isParallelogram([0, 0, 100, 0, 80, 50, 20, 50]), false);
		assert.equal(isParallelogram([0, 0, 1, 1]), false);
		assert.equal(isParallelogram(undefined), false);
	});
});

describe("quadPoint", () => {
	it("maps relative coordinates onto the quad", () => {
		assert.deepEqual(quadPoint(rect, 0, 0), { x: 10, y: 20 });
		assert.deepEqual(quadPoint(rect, 1, 1), { x: 110, y: 70 });
		assert.deepEqual(quadPoint(rect, 0.5, 0.5), { x: 60, y: 45 });
	});

	it("follows the quad orientation", () => {
		assert.deepEqual(quadPoint(rotated, 0.5, 0.5), { x: 50, y: 50 });
		assert.deepEqual(quadPoint(rotated, 1, 0), { x: 100, y: 50 });
	});
});

describe("quadSize", () => {
	it("measures the top and left edges", () => {
		assert.deepEqual(quadSize(rect), { width: 100, height: 50 });
		const { width, height } = quadSize(rotated);
		assert.ok(Math.abs(width - Math.hypot(50, 50)) < 1e-9);
		assert.ok(Math.abs(height - Math.hypot(50, 50)) < 1e-9);
	});
});

describe("quadBounds and visibleBounds", () => {
	it("returns the axis-aligned bounding box", () => {
		assert.deepEqual(quadBounds(rotated), { left: 0, top: 0, right: 100, bottom: 100 });
	});

	it("clips the bounding box to the viewport", () => {
		const bounds = visibleBounds([-10, -10, 300, -10, 300, 40, -10, 40], {
			width: 200,
			height: 30,
		});
		assert.deepEqual(bounds, { left: 0, top: 0, right: 199, bottom: 29 });
	});
});

describe("insetRect", () => {
	it("shrinks every side", () => {
		const inset = insetRect({ left: 0, top: 0, right: 100, bottom: 50 }, 2);
		assert.deepEqual(inset, { left: 2, top: 2, right: 98, bottom: 48 });
	});

	it("does not turn a thin rectangle inside out", () => {
		const inset = insetRect({ left: 10, top: 10, right: 12, bottom: 11 }, 2);
		assert.ok(inset.left >= 10 && inset.right <= 12);
		assert.ok(inset.top >= 10 && inset.bottom <= 11);
	});
});

describe("clampToRect", () => {
	it("pulls points into the rectangle", () => {
		const area = { left: 0, top: 0, right: 10, bottom: 10 };
		assert.deepEqual(clampToRect({ x: -5, y: 20 }, area), { x: 0, y: 10 });
		assert.deepEqual(clampToRect({ x: 5, y: 5 }, area), { x: 5, y: 5 });
	});
});

describe("isInViewport", () => {
	it("keeps a one pixel margin by default", () => {
		const viewport = { width: 100, height: 50 };
		assert.equal(isInViewport({ x: 1, y: 1 }, viewport), true);
		assert.equal(isInViewport({ x: 0.5, y: 10 }, viewport), false);
		assert.equal(isInViewport({ x: 99, y: 10 }, viewport), false);
		assert.equal(isInViewport({ x: 50, y: 49 }, viewport), false);
	});
});

describe("equality helpers", () => {
	it("tolerate floating point noise only", () => {
		const shift = (amount) => rect.map((value) => value + amount);
		assert.equal(sameQuad(rect, shift(1e-6)), true);
		assert.equal(sameQuad(rect, shift(1)), false);
		assert.equal(samePoint({ x: 1, y: 1 }, { x: 1 + 1e-6, y: 1 }), true);
		assert.equal(samePoint({ x: 1, y: 1 }, { x: 1.01, y: 1 }), false);
		assert.equal(sameSize({ width: 10, height: 5 }, { width: 10, height: 5 }), true);
		assert.equal(sameSize({ width: 10, height: 5 }, { width: 11, height: 5 }), false);
	});
});
