import { ProtocolError } from "./cdp.js";

const PREFIX = "[Turnstile Solver]";

export function warn(...parts) {
	console.warn(
		PREFIX,
		...parts.map((part) => (part instanceof ProtocolError ? part.message : part)),
	);
}
