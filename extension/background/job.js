import { jitter } from "./random.js";

const LIFETIME_MS = 30_000;
const MAX_CLICKS = 2;
const CLICK_SETTLE_MS = 4500;
const CLICK_SETTLE_STEP_MS = 1000;
const MISS_BACKOFF_BASE_MS = 400;
const MISS_BACKOFF_STEP_MS = 200;
const MISS_BACKOFF_MAX_MS = 2000;
const MISSING_GRACE_MS = 5000;

export class WidgetJob {
	#controller = new AbortController();

	constructor(key, widgetId, now = Date.now()) {
		this.key = key;
		this.widgetId = widgetId;
		this.restart(now);
	}

	get signal() {
		return this.#controller.signal;
	}

	get exhausted() {
		return this.clicks >= MAX_CLICKS;
	}

	isExpired(now = Date.now()) {
		return now >= this.deadline;
	}

	isDue(now = Date.now()) {
		return now >= this.nextAttemptAt;
	}

	isMissing(now = Date.now()) {
		return this.missingSince !== null && now - this.missingSince >= MISSING_GRACE_MS;
	}

	restart(now = Date.now()) {
		this.clicks = 0;
		this.misses = 0;
		this.deadline = now + LIFETIME_MS;
		this.nextAttemptAt = now;
		this.missingSince = null;
	}

	extend(now = Date.now()) {
		this.deadline = Math.max(this.deadline, now + LIFETIME_MS);
		this.missingSince = null;
	}

	recordFound() {
		this.missingSince = null;
	}

	recordNotFound(now = Date.now()) {
		this.missingSince ??= now;
	}

	recordClick(now = Date.now()) {
		this.clicks += 1;
		this.misses = 0;
		this.nextAttemptAt = now + CLICK_SETTLE_MS + this.clicks * CLICK_SETTLE_STEP_MS + jitter(250);
	}

	recordMiss(now = Date.now()) {
		this.misses += 1;
		const backoff = Math.min(
			MISS_BACKOFF_BASE_MS + this.misses * MISS_BACKOFF_STEP_MS,
			MISS_BACKOFF_MAX_MS,
		);
		this.nextAttemptAt = now + backoff + jitter(75);
	}

	cancel() {
		this.#controller.abort();
	}
}
