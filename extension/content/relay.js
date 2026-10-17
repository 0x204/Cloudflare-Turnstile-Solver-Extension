"use strict";

{
	const { parseChallengeMessage } = globalThis.TurnstileProtocol;

	window.addEventListener("message", (event) => {
		const message = parseChallengeMessage(event, window);
		if (message && chrome.runtime?.id) chrome.runtime.sendMessage(message).catch(() => {});
	});
}
