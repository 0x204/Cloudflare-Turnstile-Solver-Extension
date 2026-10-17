import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WidgetJob } from "../extension/background/job.js";

const NOW = 1_000_000;

describe("WidgetJob", () => {
	it("is due immediately and expires after its lifetime", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		assert.equal(job.isDue(NOW), true);
		assert.equal(job.isExpired(NOW + 29_999), false);
		assert.equal(job.isExpired(NOW + 30_000), true);
	});

	it("waits longer after every click and gives up after two", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);

		job.recordClick(NOW);
		assert.ok(job.nextAttemptAt >= NOW + 5250 && job.nextAttemptAt <= NOW + 5750);
		assert.equal(job.exhausted, false);

		job.recordClick(NOW);
		assert.ok(job.nextAttemptAt >= NOW + 6250 && job.nextAttemptAt <= NOW + 6750);
		assert.equal(job.exhausted, true);
	});

	it("backs off on misses up to a cap and resets the miss count after a click", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);

		job.recordMiss(NOW);
		assert.ok(job.nextAttemptAt >= NOW + 525 && job.nextAttemptAt <= NOW + 675);

		for (let miss = 0; miss < 20; miss++) job.recordMiss(NOW);
		assert.ok(job.nextAttemptAt >= NOW + 1925 && job.nextAttemptAt <= NOW + 2075);

		job.recordClick(NOW);
		assert.equal(job.misses, 0);
	});

	it("extends the deadline without shortening it", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		job.extend(NOW + 10_000);
		assert.equal(job.deadline, NOW + 40_000);
		job.extend(NOW);
		assert.equal(job.deadline, NOW + 40_000);
	});

	it("starts over on restart", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		job.recordClick(NOW);
		job.recordClick(NOW);
		job.restart(NOW + 7000);

		assert.equal(job.exhausted, false);
		assert.equal(job.isDue(NOW + 7000), true);
		assert.equal(job.deadline, NOW + 37_000);
	});

	it("aborts its signal when cancelled", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		assert.equal(job.signal.aborted, false);
		job.cancel();
		assert.equal(job.signal.aborted, true);
	});
});
