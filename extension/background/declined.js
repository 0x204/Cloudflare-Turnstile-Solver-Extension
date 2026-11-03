import { warn } from "./log.js";

const STORAGE_KEY = "declinedTabs";

export class DeclinedTabs {
	#ids = new Set();
	#storage;

	constructor(storage) {
		this.#storage = storage;
	}

	get size() {
		return this.#ids.size;
	}

	async load() {
		try {
			const { [STORAGE_KEY]: ids = [] } = await this.#storage.get(STORAGE_KEY);
			for (const id of ids) this.#ids.add(id);
		} catch (error) {
			warn("Cannot read declined tabs:", error);
		}
	}

	has(tabId) {
		return this.#ids.has(tabId);
	}

	add(tabId) {
		if (this.#ids.has(tabId)) return Promise.resolve();
		this.#ids.add(tabId);
		return this.#save();
	}

	delete(tabId) {
		if (!this.#ids.delete(tabId)) return Promise.resolve();
		return this.#save();
	}

	async #save() {
		try {
			await this.#storage.set({ [STORAGE_KEY]: [...this.#ids] });
		} catch (error) {
			warn("Cannot save declined tabs:", error);
		}
	}
}
