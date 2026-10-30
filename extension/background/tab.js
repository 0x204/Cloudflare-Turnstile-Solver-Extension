import { isFatal } from "./cdp.js";
import { DebuggerConnection } from "./connection.js";
import { clamp } from "./geometry.js";
import { WidgetJob } from "./job.js";
import { warn } from "./log.js";
import { solveWidget } from "./solver.js";
import { idle, SerialQueue } from "./timing.js";

const MIN_TICK_MS = 50;
const MAX_TICK_MS = 1000;

const lifecycles = new SerialQueue();

export class Tab {
	#jobs = new Map();
	#lifetime = new AbortController();
	#wake = null;
	#connection = null;
	#running = false;
	#onIdle;
	#attach;
	#solve;

	constructor(
		id,
		onIdle,
		{ attach = (tabId) => DebuggerConnection.attach(tabId), solve = solveWidget } = {},
	) {
		this.id = id;
		this.#onIdle = onIdle;
		this.#attach = attach;
		this.#solve = solve;
	}

	get cancelled() {
		return this.#lifetime.signal.aborted;
	}

	get ownsDebugger() {
		return this.#connection?.isOpen ?? false;
	}

	begin(key, widgetId) {
		const now = Date.now();
		const job = this.#jobs.get(key);
		if (!job) this.#jobs.set(key, new WidgetJob(key, widgetId, now));
		else if (job.exhausted || job.isExpired(now)) job.restart(now);
		else job.extend(now);

		this.#wake?.abort();
		this.#start();
	}

	end(key) {
		const job = this.#jobs.get(key);
		if (!job) return;
		this.#drop(job);
		this.#wake?.abort();
	}

	cancel() {
		this.#lifetime.abort();
		this.#dropAll();
	}

	handleDebuggerEvent(source, method, params) {
		this.#connection?.handleEvent(source, method, params);
	}

	#drop(job) {
		this.#jobs.delete(job.key);
		job.cancel();
	}

	#dropAll() {
		for (const job of this.#jobs.values()) job.cancel();
		this.#jobs.clear();
	}

	#start() {
		if (this.#running || this.cancelled) return;
		this.#running = true;

		lifecycles
			.run(this.id, () => this.#run())
			.catch((error) => {
				if (this.cancelled) return;
				warn(`Worker for tab ${this.id} stopped:`, error);
				this.#dropAll();
			})
			.finally(() => {
				this.#running = false;
				if (this.cancelled) return;
				if (this.#jobs.size > 0) this.#start();
				else this.#onIdle(this);
			});
	}

	async #run() {
		if (this.cancelled) return;

		let connection;
		try {
			connection = await this.#attach(this.id);
		} catch (error) {
			warn(`Cannot attach to tab ${this.id}:`, error);
			this.#dropAll();
			return;
		}

		this.#connection = connection;
		let graceful = true;
		try {
			this.#lifetime.signal.throwIfAborted();
			await connection.initialize();
			await this.#process(connection);
		} catch (error) {
			graceful = !isFatal(error);
			throw error;
		} finally {
			await connection.close({ graceful });
			this.#connection = null;
		}
	}

	async #process(connection) {
		while (!this.cancelled && this.#jobs.size > 0) {
			for (const job of [...this.#jobs.values()]) {
				if (this.#jobs.get(job.key) !== job) continue;

				const now = Date.now();
				if (job.isExpired(now)) {
					warn("Widget timed out:", job.widgetId);
					this.#drop(job);
					continue;
				}
				if (job.isMissing(now)) {
					warn("Widget is no longer on the page:", job.widgetId);
					this.#drop(job);
					continue;
				}
				if (!job.isDue(now)) continue;
				if (job.exhausted) {
					warn("Widget was not solved after the allowed clicks:", job.widgetId);
					this.#drop(job);
					continue;
				}

				await this.#attempt(connection, job);
			}

			if (this.#jobs.size > 0) await this.#pause(this.#nextTickDelay());
		}
	}

	async #attempt(connection, job) {
		const signal = AbortSignal.any([
			this.#lifetime.signal,
			job.signal,
			AbortSignal.timeout(Math.max(0, job.deadline - Date.now())),
		]);

		let clicked = false;
		try {
			clicked = await this.#solve(connection, job, signal);
		} catch (error) {
			if (isFatal(error)) throw error;
			if (!signal.aborted) warn("Widget attempt failed:", error);
		}

		if (clicked) job.recordClick();
		else job.recordMiss();
	}

	#nextTickDelay() {
		const now = Date.now();
		let next = now + MAX_TICK_MS;
		for (const job of this.#jobs.values()) next = Math.min(next, job.nextAttemptAt, job.deadline);
		return clamp(next - now, MIN_TICK_MS, MAX_TICK_MS);
	}

	async #pause(ms) {
		this.#wake = new AbortController();
		await idle(ms, AbortSignal.any([this.#lifetime.signal, this.#wake.signal]));
		this.#wake = null;
	}
}
