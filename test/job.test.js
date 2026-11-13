import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Outcome, WidgetJob } from "../extension/background/job.js";

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

		job.record(Outcome.CLICKED, NOW);
		assert.ok(job.nextAttemptAt >= NOW + 5250 && job.nextAttemptAt <= NOW + 5750);
		assert.equal(job.exhausted, false);

		job.record(Outcome.CLICKED, NOW);
		assert.ok(job.nextAttemptAt >= NOW + 6250 && job.nextAttemptAt <= NOW + 6750);
		assert.equal(job.exhausted, true);
	});

	it("backs off on misses up to a cap and resets the miss count after a click", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);

		job.record(Outcome.MISSED, NOW);
		assert.ok(job.nextAttemptAt >= NOW + 525 && job.nextAttemptAt <= NOW + 675);

		for (let miss = 0; miss < 20; miss++) job.record(Outcome.MISSED, NOW);
		assert.ok(job.nextAttemptAt >= NOW + 1925 && job.nextAttemptAt <= NOW + 2075);

		job.record(Outcome.CLICKED, NOW);
		assert.equal(job.misses, 0);
	});

	it("spends a click on an abandoned approach and retries as after a miss", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);

		job.record(Outcome.ABANDONED, NOW);
		assert.equal(job.exhausted, false);
		assert.ok(job.nextAttemptAt >= NOW + 525 && job.nextAttemptAt <= NOW + 675);

		job.record(Outcome.ABANDONED, NOW);
		assert.equal(job.exhausted, true);
	});

	it("backs off when the widget is not found", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		job.record(Outcome.NOT_FOUND, NOW);
		assert.equal(job.misses, 1);
		assert.equal(job.isDue(NOW + 500), false);
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
		job.record(Outcome.CLICKED, NOW);
		job.record(Outcome.CLICKED, NOW);
		job.restart(NOW + 7000);

		assert.equal(job.exhausted, false);
		assert.equal(job.isDue(NOW + 7000), true);
		assert.equal(job.deadline, NOW + 37_000);
	});

	it("counts as missing only after failing to find the widget for a while", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		assert.equal(job.isMissing(NOW + 60_000), false);

		job.record(Outcome.NOT_FOUND, NOW);
		job.record(Outcome.NOT_FOUND, NOW + 3000);
		assert.equal(job.isMissing(NOW + 4999), false);
		assert.equal(job.isMissing(NOW + 5000), true);

		job.record(Outcome.MISSED, NOW + 6000);
		assert.equal(job.isMissing(NOW + 9000), false);
	});

	it("starts the missing grace period over after an attempt that did not search every frame", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		job.record(Outcome.NOT_FOUND, NOW);
		job.record(Outcome.MISSED, NOW + 4000);
		job.record(Outcome.NOT_FOUND, NOW + 4500);

		assert.equal(job.isMissing(NOW + 9499), false);
		assert.equal(job.isMissing(NOW + 9500), true);
	});

	it("is no longer missing when the widget asks for interaction again", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		job.record(Outcome.NOT_FOUND, NOW);
		job.extend(NOW + 1000);
		assert.equal(job.isMissing(NOW + 10_000), false);
	});

	it("aborts its signal when cancelled", () => {
		const job = new WidgetJob("doc:abc", "abc", NOW);
		assert.equal(job.signal.aborted, false);
		job.cancel();
		assert.equal(job.signal.aborted, true);
	});
});
