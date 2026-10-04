(() => {
	"use strict";

	const shared = globalThis.TurnstileShared;
	if (!shared) return;

	window.addEventListener("message", (event) => {
		const message = shared.parseChallengeEvent(event, window);
		if (!message) return;

		try {
			void chrome.runtime.sendMessage(message).catch(() => {});
		} catch {
			// The extension may have been reloaded while this document stayed open.
		}
	});
})();
