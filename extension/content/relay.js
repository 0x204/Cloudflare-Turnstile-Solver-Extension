"use strict";

{
	const { Action, parseChallengeMessage } = globalThis.TurnstileProtocol;
	const pending = new Set();

	function send(message) {
		if (chrome.runtime?.id) chrome.runtime.sendMessage(message).catch(() => {});
	}

	window.addEventListener("message", (event) => {
		const message = parseChallengeMessage(event, window);
		if (!message) return;

		if (message.action === Action.BEGIN) pending.add(message.widgetId);
		else pending.delete(message.widgetId);
		send(message);
	});

	// Widgets of a document that goes away never report back, so end them here.
	window.addEventListener("pagehide", () => {
		for (const widgetId of pending) send({ action: Action.END, widgetId });
		pending.clear();
	});
}
