const PREFIX = "[Turnstile Solver]";

export function warn(...parts) {
	console.warn(PREFIX, ...parts.map((part) => (part instanceof Error ? part.message : part)));
}
