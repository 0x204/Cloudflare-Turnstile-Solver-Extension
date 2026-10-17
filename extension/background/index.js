import { Action, isValidWidgetId } from "./protocol.js";
import { Tab } from "./tab.js";

const tabs = new Map();

function release(tab) {
	if (tabs.get(tab.id) === tab) tabs.delete(tab.id);
	tab.cancel();
}

function tabFor(tabId) {
	let tab = tabs.get(tabId);
	if (!tab) {
		tab = new Tab(tabId, release);
		tabs.set(tabId, tab);
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

chrome.runtime.onMessage.addListener((message, sender) => {
	const tabId = sender.tab?.id;
	if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId)) return;
	if (!isValidWidgetId(message?.widgetId)) return;

	const key = widgetKey(sender, message.widgetId);
	if (message.action === Action.BEGIN) tabFor(tabId).begin(key, message.widgetId);
	else if (message.action === Action.END) tabs.get(tabId)?.end(key);
});

chrome.tabs.onUpdated.addListener((tabId, { status }) => {
	if (status === "loading" && !tabs.get(tabId)?.ownsDebugger) cancelTab(tabId);
});

chrome.tabs.onRemoved.addListener(cancelTab);

chrome.debugger.onDetach.addListener(({ tabId }) => {
	if (tabs.get(tabId)?.ownsDebugger) cancelTab(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
	if (replacesTopDocument(source, method, params)) cancelTab(source.tabId);
	else tabs.get(source.tabId)?.handleDebuggerEvent(source, method, params);
});
