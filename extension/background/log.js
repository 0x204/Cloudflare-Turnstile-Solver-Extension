import { ProtocolError } from "./cdp.js";

const PREFIX = "[Turnstile Solver]";

// Protocol errors are expected and their message says enough; anything else keeps its stack.
export function warn(...parts) {
	console.warn(
		PREFIX,
		...parts.map((part) => (part instanceof ProtocolError ? part.message : part)),
	);
}
