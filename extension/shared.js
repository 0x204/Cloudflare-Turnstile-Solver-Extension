"use strict";

{
	const CHALLENGE_ORIGINS = new Set([
		"https://challenges.cloudflare.com",
		"https://challenges.fed.cloudflare.com",
		"https://challenges-staging.cloudflare.com",
	]);

	const MESSAGE_SOURCE = "cloudflare-challenge";
	const BEGIN_EVENT = "interactiveBegin";
	const WIDGET_ID_PATTERN = /^[\w.:-]{1,128}$/;

	const KNOWN_TERMINAL_EVENTS = new Set([
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
		"widgetStale",
	]);

	const TERMINAL_WORDS = new Set([
		"complete",
		"completed",
		"error",
		"expired",
		"fail",
		"failed",
		"failure",
		"refresh",
		"reject",
		"rejected",
		"reload",
		"stale",
		"timeout",
	]);

	const Action = Object.freeze({
		BEGIN: "turnstile:begin",
		END: "turnstile:end",
	});

	function isChallengeUrl(value) {
		return CHALLENGE_ORIGINS.has(URL.parse(value)?.origin);
	}

	function isValidWidgetId(value) {
		return typeof value === "string" && WIDGET_ID_PATTERN.test(value);
	}

	function widgetFrameId(widgetId) {
		return `cf-chl-widget-${widgetId}`;
	}

	function splitWords(name) {
		return name.split(/[-_]|(?<=[a-z\d])(?=[A-Z])/).map((word) => word.toLowerCase());
	}

	function isTerminalEvent(name) {
		return (
			KNOWN_TERMINAL_EVENTS.has(name) || splitWords(name).some((word) => TERMINAL_WORDS.has(word))
		);
	}

	function parseChallengeMessage(event, ownWindow) {
		if (!event.isTrusted || !event.source || event.source === ownWindow) return null;
		if (!CHALLENGE_ORIGINS.has(event.origin)) return null;

		const { data } = event;
		if (data?.source !== MESSAGE_SOURCE || typeof data.event !== "string") return null;
		if (!isValidWidgetId(data.widgetId)) return null;

		if (data.event === BEGIN_EVENT) return { action: Action.BEGIN, widgetId: data.widgetId };
		if (isTerminalEvent(data.event)) return { action: Action.END, widgetId: data.widgetId };
		return null;
	}

	Object.defineProperty(globalThis, "TurnstileProtocol", {
		value: Object.freeze({
			Action,
			isChallengeUrl,
			isTerminalEvent,
			isValidWidgetId,
			parseChallengeMessage,
			widgetFrameId,
		}),
	});
}
