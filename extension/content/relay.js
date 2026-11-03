"use strict";

{
	const { Action, parseChallengeMessage } = globalThis.TurnstileProtocol;
	const pending = new Set();

	function send(message) {
		if (chrome.runtime?.id) chrome.runtime.sendMessage(message).catch(() => {});
	}

	function announcePending(action) {
		for (const widgetId of pending) send({ action, widgetId });
	}

	window.addEventListener("message", (event) => {
		const message = parseChallengeMessage(event, window);
		if (!message) return;

		if (message.action === Action.BEGIN) pending.add(message.widgetId);
		else pending.delete(message.widgetId);
		send(message);
	});

	window.addEventListener("pagehide", ({ persisted }) => {
		announcePending(Action.END);
		if (!persisted) pending.clear();
	});

	window.addEventListener("pageshow", ({ persisted }) => {
		if (persisted) announcePending(Action.BEGIN);
	});
}
