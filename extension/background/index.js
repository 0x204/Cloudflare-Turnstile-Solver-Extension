import { DeclinedTabs } from "./declined.js";
import { warn } from "./log.js";
import { Action, isValidWidgetId } from "./protocol.js";
import { Tab } from "./tab.js";

const tabs = new Map();
const declined = new DeclinedTabs(chrome.storage.session);
const loaded = declined.load().finally(syncTabListener);

// Handlers that touch tab state wait for the declined tabs. They all wait on the same promise,
// so events are still handled in the order they arrived.
function afterLoad(handler) {
	return (...args) => {
		loaded.then(() => handler(...args));
	};
}

const forgetTab = afterLoad((tabId) => {
	cancelTab(tabId);
	declined.delete(tabId);
	syncTabListener();
});

// Added on every start, so a tab closing that woke the worker reaches it. Once the declined tabs
// are loaded, the listener stays only while some tab has state, so closing tabs does not wake
// the worker otherwise.
chrome.tabs.onRemoved.addListener(forgetTab);

function syncTabListener() {
	const needed = tabs.size > 0 || declined.size > 0;
	const registered = chrome.tabs.onRemoved.hasListener(forgetTab);
	if (needed && !registered) chrome.tabs.onRemoved.addListener(forgetTab);
	else if (!needed && registered) chrome.tabs.onRemoved.removeListener(forgetTab);
}

function release(tab) {
	if (tabs.get(tab.id) === tab) tabs.delete(tab.id);
	tab.cancel();
	syncTabListener();
}

function tabFor(tabId) {
	let tab = tabs.get(tabId);
	if (!tab) {
		tab = new Tab(tabId, release);
		tabs.set(tabId, tab);
		syncTabListener();
	}
	return tab;
}

function cancelTab(tabId) {
	const tab = tabs.get(tabId);
	if (tab) release(tab);
}

function widgetKey(sender, widgetId) {
	const documentKey = sender.documentId ?? `frame:${sender.frameId ?? 0}`;
	return `${documentKey}:${widgetId}`;
}

function replacesTopDocument(source, method, params) {
	return method === "Page.frameNavigated" && !source.sessionId && !params.frame?.parentId;
}

function handleMessage(message, sender) {
	const tabId = sender.tab?.id;
	if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId)) return;
	if (!isValidWidgetId(message?.widgetId)) return;

	const key = widgetKey(sender, message.widgetId);
	if (message.action === Action.END) {
		tabs.get(tabId)?.end(key);
	} else if (message.action === Action.BEGIN) {
		if (declined.has(tabId)) return;
		tabFor(tabId).begin(key, message.widgetId);
	}
}

function handleDetach({ tabId }, reason) {
	if (reason === "canceled_by_user") {
		warn(`Debugging was cancelled by the user; tab ${tabId} will be left alone.`);
		// Declined before the tab is let go, so the listener for its closing is never dropped.
		declined.add(tabId);
		cancelTab(tabId);
		syncTabListener();
	} else if (tabs.get(tabId)?.ownsDebugger) {
		cancelTab(tabId);
	}
}

chrome.runtime.onMessage.addListener(afterLoad(handleMessage));
chrome.debugger.onDetach.addListener(afterLoad(handleDetach));

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
	if (replacesTopDocument(source, method, params)) cancelTab(source.tabId);
	else tabs.get(source.tabId)?.handleDebuggerEvent(source, method, params);
});
