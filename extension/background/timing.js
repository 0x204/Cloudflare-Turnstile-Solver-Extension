const noop = () => {};

export function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}

		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function idle(ms, signal) {
	return sleep(ms, signal).catch(noop);
}

export function withTimeout(promise, ms, createError) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(createError()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SerialQueue {
	#tails = new Map();

	run(key, task) {
		const result = (this.#tails.get(key) ?? Promise.resolve()).then(task);
		const tail = result.then(noop, noop).then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		this.#tails.set(key, tail);
		return result;
	}
}
