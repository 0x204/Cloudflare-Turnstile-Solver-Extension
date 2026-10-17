import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pointerPath } from "../extension/background/mouse.js";

const target = {
	point: { x: 40, y: 32 },
	bounds: { left: 10, top: 10, right: 310, bottom: 75 },
	viewport: { width: 1280, height: 720 },
};

describe("pointerPath", () => {
	it("ends exactly on the target point", () => {
		for (let run = 0; run < 200; run++) {
			const last = pointerPath(target).at(-1);
			assert.deepEqual({ x: last.x, y: last.y }, target.point);
			assert.ok(last.delay >= 35 && last.delay <= 70);
		}
	});

	it("never leaves the viewport", () => {
		const edgeTarget = {
			...target,
			point: { x: 2, y: 2 },
			bounds: { left: 0, top: 0, right: 80, bottom: 40 },
		};
		for (let run = 0; run < 200; run++) {
			for (const { x, y } of pointerPath(edgeTarget)) {
				assert.ok(x >= 0 && x <= target.viewport.width - 1, `x=${x}`);
				assert.ok(y >= 0 && y <= target.viewport.height - 1, `y=${y}`);
			}
		}
	});

	it("approaches from inside the widget and settles near the checkbox", () => {
		for (let run = 0; run < 200; run++) {
			const path = pointerPath(target);
			assert.ok(path.length >= 15 && path.length <= 22, String(path.length));

			const [first] = path;
			assert.ok(first.x >= 10 && first.x <= 310 && first.y >= 10 && first.y <= 75);

			for (const { x, y, delay } of path.slice(-6, -1)) {
				assert.ok(Math.abs(x - target.point.x) <= 22 && Math.abs(y - target.point.y) <= 22);
				assert.ok(delay >= 7 && delay <= 55);
			}
		}
	});
});
