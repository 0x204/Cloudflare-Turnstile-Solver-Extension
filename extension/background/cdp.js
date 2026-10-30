import { withTimeout } from "./timing.js";

export const PROTOCOL_VERSION = "1.3";

const COMMAND_TIMEOUT_MS = 5000;
const TARGET_GONE = /No tab|not attached|Detached while handling|target closed/i;
const SESSION_GONE =
	/No session with given id|Session with given id (?:not found|does not exist)|session closed/i;

export class ProtocolError extends Error {
	name = "ProtocolError";
}

export class FatalProtocolError extends ProtocolError {
	name = "FatalProtocolError";
}

export class CommandTimeoutError extends ProtocolError {
	name = "CommandTimeoutError";
}

export function isFatal(error) {
	return (
		error instanceof FatalProtocolError ||
		(error instanceof ProtocolError && TARGET_GONE.test(error.message))
	);
}

export async function tolerate(promise, fallback) {
	try {
		return await promise;
	} catch (error) {
		if (!(error instanceof ProtocolError) || isFatal(error)) throw error;
		return fallback;
	}
}

function toProtocolError(error) {
	if (error instanceof ProtocolError) return error;
	return new ProtocolError(error?.message ?? String(error), { cause: error });
}

export class CdpSession {
	closed = false;
	ready = Promise.resolve();
	#pending = new Set();

	constructor(debuggee, { parentId = null, targetInfo = null } = {}) {
		this.debuggee = debuggee;
		this.parentId = parentId;
		this.targetInfo = targetInfo;
	}

	get id() {
		return this.debuggee.sessionId ?? null;
	}

	get isRoot() {
		return this.id === null;
	}

	get targetId() {
		return this.targetInfo?.targetId;
	}

	get url() {
		return this.targetInfo?.url;
	}

	async send(method, params = {}) {
		if (this.closed) throw new ProtocolError(`Cannot send ${method}: session closed`);

		// Chrome never settles a command whose session detaches, so close() rejects it instead.
		let reject;
		const abandoned = new Promise((_, onAbandoned) => (reject = onAbandoned));
		this.#pending.add(reject);

		try {
			return await withTimeout(
				Promise.race([chrome.debugger.sendCommand(this.debuggee, method, params), abandoned]),
				COMMAND_TIMEOUT_MS,
				() => new CommandTimeoutError(`CDP command timed out: ${method}`),
			);
		} catch (error) {
			if (SESSION_GONE.test(error?.message)) this.closed = true;
			throw toProtocolError(error);
		} finally {
			this.#pending.delete(reject);
		}
	}

	async sendAll(commands) {
		for (const [method, params] of commands) await this.send(method, params);
	}

	close() {
		this.closed = true;
		for (const reject of this.#pending) reject(new ProtocolError("Session closed"));
		this.#pending.clear();
	}
}
