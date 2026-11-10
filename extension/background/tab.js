import { ClickBudget } from "./budget.js";
import { isFatal } from "./cdp.js";
import { DebuggerConnection } from "./connection.js";
import { clamp } from "./geometry.js";
import { jobKey, Outcome, spendsClick, WidgetJob } from "./job.js";
import { warn } from "./log.js";
import { solveWidget } from "./solver.js";
import { deadlineSignal, idle, SerialQueue } from "./timing.js";

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
	#budget;

	constructor(
		id,
		onIdle,
		{
			attach = (tabId) => DebuggerConnection.attach(tabId),
			solve = solveWidget,
			budget = new ClickBudget(),
		} = {},
	) {
		this.id = id;
		this.#onIdle = onIdle;
		this.#attach = attach;
		this.#solve = solve;
		this.#budget = budget;
	}

	get cancelled() {
		return this.#lifetime.signal.aborted;
	}

	get ownsDebugger() {
		return this.#connection?.isOpen ?? false;
	}

	begin(documentKey, widgetId) {
		const now = Date.now();
		const key = jobKey(documentKey, widgetId);
		const job = this.#jobs.get(key);
		if (!job) this.#jobs.set(key, new WidgetJob(documentKey, widgetId, now));
		else if (job.exhausted || job.isExpired(now)) job.restart(now);
		else job.extend(now);

		this.#wake?.abort();
		this.#start();
	}

	end(documentKey, widgetId) {
		const job = this.#jobs.get(jobKey(documentKey, widgetId));
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
		try {
			this.#lifetime.signal.throwIfAborted();
			await connection.initialize();
			await this.#process(connection);
		} finally {
			await connection.close();
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
				if (!this.#budget.allows(job.documentKey)) {
					warn("The document has used up its clicks:", job.widgetId);
					this.#drop(job);
					continue;
				}

				await this.#attempt(connection, job);
			}

			if (this.#jobs.size > 0) await this.#pause(this.#nextTickDelay());
		}
	}

	async #attempt(connection, job) {
		const expiry = deadlineSignal(() => job.deadline);
		const signal = AbortSignal.any([this.#lifetime.signal, job.signal, expiry.signal]);

		let outcome = Outcome.MISSED;
		try {
			outcome = await this.#solve(connection, job, signal);
		} catch (error) {
			if (isFatal(error)) throw error;
			if (!signal.aborted) warn("Widget attempt failed:", error);
		} finally {
			expiry.dispose();
		}
		job.record(outcome);
		if (spendsClick(outcome)) this.#budget.spend(job.documentKey);
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
