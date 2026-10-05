"use strict";

// Used by both the content script and the service worker.
globalThis.TurnstileShared = (() => {
	const BEGIN = "turnstile:begin";
	const END = "turnstile:end";

	const CHALLENGE_ORIGINS = new Set([
		"https://challenges.cloudflare.com",
		"https://challenges.fed.cloudflare.com",
		"https://challenges-staging.cloudflare.com"
	]);

	// An event ends the widget if any word of its name is one of these, so
	// "interactiveTimeout", "tokenExpired" or an unknown "widgetFailure" all count.
	const FINAL_WORDS = new Set([
		"complete",
		"error",
		"expired",
		"fail",
		"failure",
		"refresh",
		"reject",
		"reload",
		"stale",
		"timeout"
	]);

	function isFinalEvent(name) {
		if (name === "interactiveEnd") return true;
		return name.split(/[-_]|(?=[A-Z])/).some((word) => FINAL_WORDS.has(word.toLowerCase()));
	}

	function isChallengeUrl(value) {
		try {
			return CHALLENGE_ORIGINS.has(new URL(value).origin);
		} catch {
			return false;
		}
	}

	function isWidgetId(value) {
		return typeof value === "string" && /^[\w.:-]{1,128}$/.test(value);
	}

	// Turns a postMessage from a Turnstile iframe into a message for the service worker.
	function parseChallengeMessage(event, ownWindow) {
		if (!event.isTrusted || event.source === ownWindow || !CHALLENGE_ORIGINS.has(event.origin)) return null;

		const { source, widgetId, event: name } = event.data ?? {};
		if (source !== "cloudflare-challenge" || !isWidgetId(widgetId) || typeof name !== "string") return null;

		if (name === "interactiveBegin") return { action: BEGIN, widgetId };
		if (isFinalEvent(name)) return { action: END, widgetId };
		return null;
	}

	return { BEGIN, END, isChallengeUrl, isWidgetId, parseChallengeMessage };
})();
