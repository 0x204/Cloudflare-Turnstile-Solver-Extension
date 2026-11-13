import { warn } from "./log.js";

const STORAGE_KEY = "clickTimes";
const MAX_CLICKS = 10;
const WINDOW_MS = 10 * 60_000;

export class ClickBudget {
	#clickTimes = new Map();
	#storage;

	constructor(storage) {
		this.#storage = storage;
	}

	async load() {
		try {
			const { [STORAGE_KEY]: stored = {} } = await this.#storage.get(STORAGE_KEY);
			for (const [tabId, times] of Object.entries(stored)) {
				this.#clickTimes.set(Number(tabId), times);
			}
		} catch (error) {
			warn("Cannot read the click budget:", error);
		}
	}

	allows(tabId, now = Date.now()) {
		return this.#recent(tabId, now).length < MAX_CLICKS;
	}

	spend(tabId, now = Date.now()) {
		this.#clickTimes.set(tabId, [...this.#recent(tabId, now), now]);
		this.#forgetExpired(now);
		return this.#save();
	}

	#recent(tabId, now) {
		return (this.#clickTimes.get(tabId) ?? []).filter((time) => now - time < WINDOW_MS);
	}

	#forgetExpired(now) {
		for (const tabId of this.#clickTimes.keys()) {
			const recent = this.#recent(tabId, now);
			if (recent.length > 0) this.#clickTimes.set(tabId, recent);
			else this.#clickTimes.delete(tabId);
		}
	}

	async #save() {
		try {
			await this.#storage.set({ [STORAGE_KEY]: Object.fromEntries(this.#clickTimes) });
		} catch (error) {
			warn("Cannot save the click budget:", error);
		}
	}
}
