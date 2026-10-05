"use strict";

addEventListener("message", (event) => {
	const message = TurnstileShared.parseChallengeMessage(event, window);
	if (!message) return;

	try {
		chrome.runtime.sendMessage(message).catch(() => {});
	} catch {
		// The extension was reloaded and this page still runs the old content script.
	}
});
