(() => {
	"use strict";

	const CHALLENGE_ORIGINS = Object.freeze([
		"https://challenges.cloudflare.com",
		"https://challenges.fed.cloudflare.com",
		"https://challenges-staging.cloudflare.com"
	]);
	const challengeOrigins = new Set(CHALLENGE_ORIGINS);
	const MESSAGE_SOURCE = "cloudflare-challenge";
	const BEGIN_ACTION = "turnstile:begin";
	const END_ACTION = "turnstile:end";
	const END_EVENTS = new Set([
		"complete",
		"error",
		"expired",
		"fail",
		"failure",
		"interactiveEnd",
		"interactiveFail",
		"interactiveTimeout",
		"refreshRequest",
		"reject",
		"reloadRequest",
		"timeout",
		"tokenExpired",
		"widgetStale"
	]);
	// Progress / non-terminal events that must never stop an in-flight solve.
	const IGNORE_EVENTS = new Set([
		"interactiveBegin",
		"requestExtraParams",
		"translationInit"
	]);

	function isAllowedChallengeOrigin(value) {
		return typeof value === "string" && challengeOrigins.has(value);
	}

	function isAllowedChallengeUrl(value) {
		if (typeof value !== "string" || value.length === 0) return false;
		try {
			const url = new URL(value);
			return url.protocol === "https:" && challengeOrigins.has(url.origin);
		} catch {
			return false;
		}
	}

	function isValidWidgetId(value) {
		return typeof value === "string"
			&& value.length > 0
			&& value.length <= 128
			&& /^[A-Za-z0-9._:-]+$/.test(value);
	}

	function iframeIdFor(widgetId) {
		return isValidWidgetId(widgetId) ? `cf-chl-widget-${widgetId}` : null;
	}

	function isTerminalChallengeEvent(name) {
		if (typeof name !== "string" || name.length === 0) return false;
		if (END_EVENTS.has(name)) return true;
		if (IGNORE_EVENTS.has(name)) return false;
		// Future-proof: unknown Cloudflare events that look terminal still end the job.
		return /(?:^|[-_])(?:fail|failure|timeout|expired|stale|reject|reload|refresh|complete|error)(?:$|[-_])/i.test(name);
	}

	function parseChallengeEvent(event, ownWindow) {
		if (!event || event.isTrusted !== true) return null;
		if (!event.source || event.source === ownWindow) return null;
		if (!isAllowedChallengeOrigin(event.origin)) return null;

		const data = event.data;
		if (!data || typeof data !== "object") return null;
		if (data.source !== MESSAGE_SOURCE || !isValidWidgetId(data.widgetId)) return null;

		let action = null;
		if (data.event === "interactiveBegin") action = BEGIN_ACTION;
		else if (isTerminalChallengeEvent(data.event)) action = END_ACTION;
		if (!action) return null;

		return { action, widgetId: data.widgetId };
	}

	const api = Object.freeze({
		BEGIN_ACTION,
		CHALLENGE_ORIGINS,
		END_ACTION,
		MESSAGE_SOURCE,
		iframeIdFor,
		isAllowedChallengeOrigin,
		isAllowedChallengeUrl,
		isValidWidgetId,
		parseChallengeEvent
	});

	Object.defineProperty(globalThis, "TurnstileShared", {
		value: api,
		configurable: false,
		enumerable: false,
		writable: false
	});

	if (typeof module === "object" && module?.exports) module.exports = api;
})();
