import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "../extension/shared.js";

const { Action, isChallengeUrl, isTerminalEvent, isValidWidgetId, parseChallengeMessage } =
	globalThis.TurnstileProtocol;

const ownWindow = {};
const challengeWindow = {};

function challengeData(event, widgetId = "abc123") {
	return { source: "cloudflare-challenge", widgetId, event };
}

function parse(data, overrides = {}) {
	const event = {
		isTrusted: true,
		origin: "https://challenges.cloudflare.com",
		source: challengeWindow,
		data,
		...overrides,
	};
	return parseChallengeMessage(event, ownWindow);
}

describe("parseChallengeMessage", () => {
	it("turns interactiveBegin into a begin action", () => {
		const message = parse(challengeData("interactiveBegin"));
		assert.deepEqual(message, { action: Action.BEGIN, widgetId: "abc123" });
	});

	it("turns terminal events into an end action", () => {
		for (const event of ["complete", "interactiveEnd", "tokenExpired", "challengeFailed"]) {
			assert.deepEqual(parse(challengeData(event)), { action: Action.END, widgetId: "abc123" });
		}
	});

	it("ignores progress events", () => {
		for (const event of ["requestExtraParams", "translationInit", "overrunBegin"]) {
			assert.equal(parse(challengeData(event)), null, event);
		}
	});

	it("accepts every Cloudflare challenge origin", () => {
		const origins = [
			"https://challenges.cloudflare.com",
			"https://challenges.fed.cloudflare.com",
			"https://challenges-staging.cloudflare.com",
		];
		for (const origin of origins) {
			assert.notEqual(parse(challengeData("interactiveBegin"), { origin }), null, origin);
		}
	});

	it("rejects events that did not come from a trusted challenge frame", () => {
		const overrides = [
			{ isTrusted: false },
			{ origin: "https://example.com" },
			{ origin: "http://challenges.cloudflare.com" },
			{ source: null },
			{ source: ownWindow },
		];
		for (const override of overrides) {
			assert.equal(parse(challengeData("interactiveBegin"), override), null);
		}
	});

	it("rejects malformed payloads", () => {
		const payloads = [
			null,
			"interactiveBegin",
			{ ...challengeData("interactiveBegin"), source: "other" },
			{ ...challengeData("interactiveBegin"), widgetId: "bad id" },
			{ ...challengeData("interactiveBegin"), widgetId: undefined },
			{ ...challengeData("interactiveBegin"), event: 42 },
		];
		for (const data of payloads) assert.equal(parse(data), null, JSON.stringify(data));
	});
});

describe("isTerminalEvent", () => {
	it("recognizes known Cloudflare events", () => {
		const events = [
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
		];
		for (const event of events) assert.equal(isTerminalEvent(event), true, event);
	});

	it("recognizes unknown failures in camelCase, kebab-case and snake_case", () => {
		for (const event of ["challengeFailed", "widgetError", "renderTimeout", "turnstile-error"]) {
			assert.equal(isTerminalEvent(event), true, event);
		}
		assert.equal(isTerminalEvent("token_expired"), true);
	});

	it("ignores progress events and words that only contain a terminal word", () => {
		for (const event of ["interactiveBegin", "requestExtraParams", "errorless", "staleness"]) {
			assert.equal(isTerminalEvent(event), false, event);
		}
	});
});

describe("isTerminalEvent on the events Turnstile actually sends", () => {
	const terminal = [
		"complete",
		"fail",
		"interactiveEnd",
		"interactiveTimeout",
		"refreshRequest",
		"reject",
		"reloadRequest",
		"tokenExpired",
		"widgetStale",
	];
	const progress = [
		"closeFeedbackReportIframe",
		"feedbackActivity",
		"feedbackInit",
		"food",
		"init",
		"interactiveBegin",
		"languageUnsupported",
		"overrunBegin",
		"overrunEnd",
		"reloadApiJsRequest",
		"requestExtraParams",
		"requestFeedbackData",
		"translationInit",
		"turnstileResults",
	];

	it("ends the widget only on terminal events", () => {
		for (const event of terminal) assert.equal(isTerminalEvent(event), true, event);
		for (const event of progress) assert.equal(isTerminalEvent(event), false, event);
	});
});

describe("isChallengeUrl", () => {
	it("accepts URLs on challenge origins", () => {
		const url = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile";
		assert.equal(isChallengeUrl(url), true);
	});

	it("rejects other origins, schemes and malformed input", () => {
		const values = [
			"https://challenges.cloudflare.com.evil.test/",
			"http://challenges.cloudflare.com/",
			"https://example.com/",
			"not a url",
			"",
			undefined,
			null,
		];
		for (const value of values) assert.equal(isChallengeUrl(value), false, String(value));
	});
});

describe("isValidWidgetId", () => {
	it("accepts word characters, dots, colons and dashes", () => {
		for (const id of ["abc", "a1_b-2", "x.y:z", "a".repeat(128)]) {
			assert.equal(isValidWidgetId(id), true, id);
		}
	});

	it("rejects empty, oversized, non-string and unsafe values", () => {
		for (const id of ["", "a".repeat(129), "a b", 'a"b', "a]b", 42, null, undefined]) {
			assert.equal(isValidWidgetId(id), false, String(id));
		}
	});
});
