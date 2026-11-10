const MAX_CLICKS_PER_DOCUMENT = 6;

export class ClickBudget {
	#spent = new Map();

	allows(documentKey) {
		return (this.#spent.get(documentKey) ?? 0) < MAX_CLICKS_PER_DOCUMENT;
	}

	spend(documentKey) {
		this.#spent.set(documentKey, (this.#spent.get(documentKey) ?? 0) + 1);
	}
}
