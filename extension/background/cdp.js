import { withTimeout } from "./timing.js";

export const PROTOCOL_VERSION = "1.3";

const COMMAND_TIMEOUT_MS = 5000;
const TARGET_GONE = /No tab|not attached|Detached while handling|target closed/i;
const SESSION_GONE =
	/No session with given id|Session with given id (?:not found|does not exist)|session closed/i;

export class FatalProtocolError extends Error {
	name = "FatalProtocolError";
}

export function isFatal(error) {
	return error instanceof FatalProtocolError || TARGET_GONE.test(error?.message);
}

export async function tolerate(promise, fallback) {
	try {
		return await promise;
	} catch (error) {
		if (isFatal(error)) throw error;
		return fallback;
	}
}

export class CdpSession {
	closed = false;
	ready = Promise.resolve();

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
		try {
			return await withTimeout(
				chrome.debugger.sendCommand(this.debuggee, method, params),
				COMMAND_TIMEOUT_MS,
				() => new FatalProtocolError(`CDP command timed out: ${method}`),
			);
		} catch (error) {
			if (SESSION_GONE.test(error?.message)) this.closed = true;
			throw error;
		}
	}

	async sendAll(commands) {
		for (const [method, params] of commands) await this.send(method, params);
	}
}
