"use strict";

importScripts("shared.js");

const shared = globalThis.TurnstileShared;
const PROTOCOL_VERSION = "1.3";
const MAX_WIDGET_LIFETIME_MS = 30000;
const MAX_CLICK_ATTEMPTS = 2;
const CLICK_RETRY_MS = 4500;
const CLICK_RETRY_STEP_MS = 1000;
const CDP_COMMAND_TIMEOUT_MS = 5000;
const FRAME_SEARCH_PAGE_SIZE = 16;
const FRAME_SEARCH_MAX_RESULTS = 64;
const FRAME_REVISION_SOFT_LIMIT = 256;
const FRAME_REVISION_KEEP = 128;
const AUTO_ATTACH_PARAMS = Object.freeze({
	autoAttach: true,
	waitForDebuggerOnStart: false,
	flatten: true,
	filter: [{ type: "iframe", exclude: false }]
});
const tabStates = new Map();
const tabLifecycles = new Map();
let nextStateId = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const randInt = (min, max) => Math.floor(Math.random() * (max - min) + min);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function gaussian(mean, deviation) {
	const u = Math.random() || Number.MIN_VALUE;
	const v = Math.random();
	return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function humanDelay(mean, deviation, min, max) {
	return Math.round(clamp(gaussian(mean, deviation), min, max));
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isFatalProtocolError(error) {
	return /CDP command timed out|Mouse release failed|No tab|not attached|Detached while handling|target closed/i.test(errorMessage(error));
}

function isClosedSessionError(error) {
	return /No session with given id|Session with given id (?:not found|does not exist)|session closed/i.test(errorMessage(error));
}

function makeSender(debuggee) {
	return async (method, params = {}) => {
		let timer;
		// Keep a handle on the real CDP promise so a late settle after timeout does not
		// surface as an unhandled rejection (sendCommand cannot be cancelled).
		const command = chrome.debugger.sendCommand(debuggee, method, params);
		try {
			return await Promise.race([
				command,
				new Promise((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`CDP command timed out: ${method}`));
					}, CDP_COMMAND_TIMEOUT_MS);
				})
			]);
		} finally {
			clearTimeout(timer);
			void command.then(() => {}, () => {});
		}
	};
}

function serializeTabLifecycle(tabId, task) {
	const previous = tabLifecycles.get(tabId) || Promise.resolve();
	const current = previous.catch(() => {}).then(task);
	let tail;
	tail = current.finally(() => {
		if (tabLifecycles.get(tabId) === tail) tabLifecycles.delete(tabId);
	});
	tabLifecycles.set(tabId, tail);
	return current;
}

function attribute(node, name) {
	const attributes = node?.attributes || [];
	for (let index = 0; index < attributes.length; index += 2) {
		if (attributes[index] === name) return attributes[index + 1];
	}
	return null;
}

function widgetKey(sender, widgetId) {
	const documentKey = typeof sender.documentId === "string"
		? sender.documentId
		: `frame:${Number.isInteger(sender.frameId) ? sender.frameId : 0}`;
	return `${documentKey}:${widgetId}`;
}

function isCurrentState(tabId, state) {
	return tabStates.get(tabId) === state && !state.cancelled;
}

function isActiveJob(tabId, state, job) {
	return isCurrentState(tabId, state) && state.widgets.get(job.key) === job;
}

function watchFrameRevision(state, revisions, frameId) {
	if (!revisions.has(frameId)) revisions.set(frameId, state.frameRevisions.get(frameId) || 0);
}

function frameRevisionsMatch(state, revisions) {
	for (const [frameId, revision] of revisions) {
		if ((state.frameRevisions.get(frameId) || 0) !== revision) return false;
	}
	return true;
}

function bumpFrameRevision(state, frameId) {
	state.frameRevisions.set(frameId, (state.frameRevisions.get(frameId) || 0) + 1);
	if (state.frameRevisions.size <= FRAME_REVISION_SOFT_LIMIT) return;
	for (const key of state.frameRevisions.keys()) {
		state.frameRevisions.delete(key);
		if (state.frameRevisions.size <= FRAME_REVISION_KEEP) break;
	}
}

function createWidgetJob(key, widgetId, now = Date.now()) {
	return {
		key,
		widgetId,
		attempts: 0,
		deadline: now + MAX_WIDGET_LIFETIME_MS,
		misses: 0,
		nextAttemptAt: now
	};
}

function refreshWidgetJob(job, now = Date.now()) {
	job.attempts = 0;
	job.deadline = now + MAX_WIDGET_LIFETIME_MS;
	job.misses = 0;
	job.nextAttemptAt = now;
}

function cancelTab(tabId) {
	const state = tabStates.get(tabId);
	if (!state) return;
	state.cancelled = true;
	state.widgets.clear();
	tabStates.delete(tabId);
}

function ensureRunner(tabId, state) {
	if (state.running || state.cancelled) return;
	state.running = true;

	void serializeTabLifecycle(tabId, () => processTab(tabId, state))
		.catch((error) => {
			if (isCurrentState(tabId, state)) {
				console.warn(`[Turnstile Solver] Tab worker stopped (state #${state.id}):`, errorMessage(error));
				state.widgets.clear();
			}
		})
		.finally(() => {
			state.running = false;
			if (!isCurrentState(tabId, state)) return;
			if (state.widgets.size > 0) ensureRunner(tabId, state);
			else tabStates.delete(tabId);
		});
}

chrome.runtime.onMessage.addListener((message, sender) => {
	if (sender.id !== chrome.runtime.id || !sender.tab || !Number.isInteger(sender.tab.id)) return;
	if (!message || !shared.isValidWidgetId(message.widgetId)) return;
	if (message.action !== shared.BEGIN_ACTION && message.action !== shared.END_ACTION) return;

	const tabId = sender.tab.id;
	const key = widgetKey(sender, message.widgetId);
	let state = tabStates.get(tabId);

	if (message.action === shared.END_ACTION) {
		state?.widgets.delete(key);
		return;
	}

	if (!state) {
		state = {
			id: ++nextStateId,
			attached: false,
			cancelled: false,
			detaching: false,
			frameRevisions: new Map(),
			running: false,
			sessions: new Map(),
			widgets: new Map()
		};
		tabStates.set(tabId, state);
	}

	const now = Date.now();
	const existing = state.widgets.get(key);
	if (!existing) {
		state.widgets.set(key, createWidgetJob(key, message.widgetId, now));
	} else if (existing.attempts >= MAX_CLICK_ATTEMPTS || now >= existing.deadline) {
		// Cloudflare re-prompted after we gave up or timed out — start a fresh cycle.
		refreshWidgetJob(existing, now);
	} else {
		// In-flight solve: do not reset attempts/nextAttemptAt (that would re-click mid-wait).
		existing.deadline = Math.max(existing.deadline, now + MAX_WIDGET_LIFETIME_MS);
	}

	ensureRunner(tabId, state);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status === "loading") cancelTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
	cancelTab(tabId);
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
	if (!Number.isInteger(tabId)) return;
	const state = tabStates.get(tabId);
	// Only cancel a state that currently holds the debugger. A previous state's
	// own cleanup fires this event too: navigation cancels the old state, the
	// new page's BEGIN already created a fresh state, and the old detach lands
	// after — cancelling that fresh (never-attached) state silently dropped the
	// widget's only interactiveBegin and it was never solved.
	if (state && state.attached && !state.detaching) cancelTab(tabId);
});

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
	if (!Number.isInteger(source.tabId)) return;
	const state = tabStates.get(source.tabId);
	if (!state) return;

	const changedFrameId = method === "Page.frameNavigated"
		? params.frame?.id
		: method === "Page.frameStartedLoading"
			? params.frameId
			: method === "Target.targetInfoChanged"
				? params.targetInfo?.targetId
				: null;
	if (typeof changedFrameId === "string") {
		bumpFrameRevision(state, changedFrameId);
	}
	if (method === "Target.targetInfoChanged" && params.targetInfo?.targetId) {
		for (const context of state.sessions.values()) {
			if (context.targetInfo?.targetId === params.targetInfo.targetId) {
				context.targetInfo = params.targetInfo;
				break;
			}
		}
	}

	if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
		const context = state.sessions.get(params.sessionId);
		if (context) context.failed = true;
		state.sessions.delete(params.sessionId);
		return;
	}
	if (method !== "Target.attachedToTarget" || state.detaching) return;
	if (typeof params.sessionId !== "string" || state.sessions.has(params.sessionId)) return;

	const debuggee = { tabId: source.tabId, sessionId: params.sessionId };
	const send = makeSender(debuggee);
	const context = {
		debuggee,
		failed: false,
		parentSessionId: typeof source.sessionId === "string" ? source.sessionId : null,
		send,
		sessionId: params.sessionId,
		targetInfo: params.targetInfo
	};
	state.sessions.set(params.sessionId, context);
	context.ready = initializeChildSession(send).catch(() => {
		context.failed = true;
		if (state.sessions.get(context.sessionId) === context) state.sessions.delete(context.sessionId);
	});
});

async function initializeChildSession(send) {
	await send("Target.setAutoAttach", AUTO_ATTACH_PARAMS);
	await send("DOM.enable");
	await send("CSS.enable");
	await send("Page.enable");
	await send("Emulation.setFocusEmulationEnabled", { enabled: true });
}

async function processTab(tabId, state) {
	if (!isCurrentState(tabId, state)) return;
	const debuggee = { tabId };
	const send = makeSender(debuggee);
	let forceDetach = false;
	state.detaching = false;
	state.sessions.clear();
	state.frameRevisions.clear();

	try {
		try {
			await chrome.debugger.attach(debuggee, PROTOCOL_VERSION);
		} catch (error) {
			console.warn(`[Turnstile Solver] Cannot attach to tab (state #${state.id}):`, errorMessage(error));
			state.widgets.clear();
			return;
		}

		state.attached = true;
		if (!isCurrentState(tabId, state)) return;

		await send("Target.setAutoAttach", AUTO_ATTACH_PARAMS);
		await send("DOM.enable");
		await send("CSS.enable");
		await send("Page.enable");
		await send("Emulation.setFocusEmulationEnabled", { enabled: true });

		while (isCurrentState(tabId, state) && state.widgets.size > 0) {
			const jobs = Array.from(state.widgets.values());
			let nextWakeAt = Date.now() + 1000;

			for (const job of jobs) {
				if (!isActiveJob(tabId, state, job)) continue;

				const now = Date.now();
				if (now >= job.deadline) {
					console.warn(`[Turnstile Solver] Widget timed out (state #${state.id}):`, job.widgetId);
					state.widgets.delete(job.key);
					continue;
				}
				if (job.attempts >= MAX_CLICK_ATTEMPTS) {
					console.warn(`[Turnstile Solver] Widget did not finish after safe retries (state #${state.id}):`, job.widgetId);
					state.widgets.delete(job.key);
					continue;
				}
				if (job.nextAttemptAt > now) {
					nextWakeAt = Math.min(nextWakeAt, job.nextAttemptAt);
					continue;
				}

				let result;
				try {
					result = await trySolveWidget(send, tabId, state, job);
				} catch (error) {
					if (!isCurrentState(tabId, state)) break;
					const message = errorMessage(error);
					if (isFatalProtocolError(error)) throw error;
					console.warn("[Turnstile Solver] Widget attempt failed:", message);
					result = "retry";
				}

				if (!isActiveJob(tabId, state, job)) continue;
				if (result === "clicked") {
					job.attempts++;
					job.misses = 0;
					// Give Cloudflare progressively more time to acknowledge each click before
					// risking a second one on the same (possibly now-transitioning) widget.
					job.nextAttemptAt = Date.now() + CLICK_RETRY_MS + job.attempts * CLICK_RETRY_STEP_MS + randInt(-250, 251);
				} else if (result === "retry") {
					job.misses++;
					const backoff = Math.min(400 + job.misses * 200, 2000);
					job.nextAttemptAt = Date.now() + backoff + randInt(-75, 76);
				}
				nextWakeAt = Math.min(nextWakeAt, job.nextAttemptAt);
			}

			if (!isCurrentState(tabId, state) || state.widgets.size === 0) break;
			const waitMs = clamp(nextWakeAt - Date.now(), 50, 1000);
			await waitWhile(waitMs, () => isCurrentState(tabId, state) && state.widgets.size > 0);
		}
	} catch (error) {
		forceDetach = isFatalProtocolError(error);
		throw error;
	} finally {
		if (state.attached) {
			state.detaching = true;
			if (!forceDetach) {
				try {
					await send("Emulation.setFocusEmulationEnabled", { enabled: false });
				} catch {}
				try {
					await send("Target.setAutoAttach", {
						autoAttach: false,
						waitForDebuggerOnStart: false,
						flatten: true
					});
				} catch {}
				try {
					await send("CSS.disable");
				} catch {}
				try {
					await send("DOM.disable");
				} catch {}
				try {
					await send("Page.disable");
				} catch {}
			}

			state.attached = false;
			try {
				await chrome.debugger.detach(debuggee);
			} catch {}
			state.sessions.clear();
		}
	}
}

async function waitWhile(ms, predicate) {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		if (!predicate()) return false;
		await delay(Math.min(50, end - performance.now()));
	}
	return predicate();
}

function escapeCssIdentifier(value) {
	if (typeof globalThis.CSS?.escape === "function") return globalThis.CSS.escape(value);
	return value.replace(/[^A-Za-z0-9_-]/g, (character) => {
		return `\\${character.codePointAt(0).toString(16)} `;
	});
}

function findFrame(frameTree, frameId) {
	if (frameTree?.frame?.id === frameId) return frameTree.frame;
	for (const child of frameTree?.childFrames || []) {
		const frame = findFrame(child, frameId);
		if (frame) return frame;
	}
	return null;
}

async function frameHasAllowedChallengeUrl(state, fallbackSend, frameId) {
	const context = Array.from(state.sessions.values()).find((entry) => {
		return entry.targetInfo?.targetId === frameId;
	});
	if (context) {
		try {
			await context.ready;
			if (context.failed || !shared.isAllowedChallengeUrl(context.targetInfo?.url)) return false;
			const { frameTree } = await context.send("Page.getFrameTree");
			const frame = findFrame(frameTree, frameId) || frameTree?.frame;
			return Boolean(frame?.id === frameId && shared.isAllowedChallengeUrl(frame.url));
		} catch (error) {
			if (!isClosedSessionError(error)) throw error;
			context.failed = true;
			if (state.sessions.get(context.sessionId) === context) state.sessions.delete(context.sessionId);
			return false;
		}
	}

	const { frameTree } = await fallbackSend("Page.getFrameTree");
	const frame = findFrame(frameTree, frameId);
	return Boolean(frame && shared.isAllowedChallengeUrl(frame.url));
}

async function findWidgetFrame(state, rootSend, widgetId) {
	try {
		const frame = await findWidgetFrameInContext(state, rootSend, widgetId);
		if (frame) return { context: null, frame, send: rootSend };
	} catch (error) {
		if (isFatalProtocolError(error)) throw error;
	}

	for (const context of Array.from(state.sessions.values())) {
		await context.ready;
		if (context.failed || state.detaching) continue;
		try {
			const frame = await findWidgetFrameInContext(state, context.send, widgetId);
			if (frame) return { context, frame, send: context.send };
		} catch (error) {
			if (isClosedSessionError(error)) {
				context.failed = true;
				if (state.sessions.get(context.sessionId) === context) state.sessions.delete(context.sessionId);
				continue;
			}
			if (isFatalProtocolError(error)) throw error;
		}
	}

	return null;
}

async function findWidgetFrameInContext(state, send, widgetId) {
	const iframeId = shared.iframeIdFor(widgetId);
	if (!iframeId) return null;

	await send("DOM.getDocument", { depth: 0, pierce: true });
	// Search shadow DOM too: a host site may render the Turnstile container
	// inside a shadow root; every candidate still passes the same validation
	// (nodeName/id/src/frameId checks) below, so the broader search can only
	// find more valid targets, never a wrong one.
	const { searchId, resultCount } = await send("DOM.performSearch", {
		query: `iframe#${escapeCssIdentifier(iframeId)}`,
		includeUserAgentShadowDOM: true
	});

	try {
		if (!resultCount) return null;
		const scanLimit = Math.min(resultCount, FRAME_SEARCH_MAX_RESULTS);

		for (let fromIndex = 0; fromIndex < scanLimit; fromIndex += FRAME_SEARCH_PAGE_SIZE) {
			const toIndex = Math.min(fromIndex + FRAME_SEARCH_PAGE_SIZE, scanLimit);
			const { nodeIds = [] } = await send("DOM.getSearchResults", { searchId, fromIndex, toIndex });

			for (const nodeId of nodeIds) {
				if (!nodeId) continue;
				const { node } = await send("DOM.describeNode", { nodeId, depth: 0, pierce: true });
				if (node?.nodeName !== "IFRAME") continue;
				if (attribute(node, "id") !== iframeId) continue;
				if (!shared.isAllowedChallengeUrl(attribute(node, "src"))) continue;
				if (!node.backendNodeId || !node.frameId) continue;
				if (!await frameHasAllowedChallengeUrl(state, send, node.frameId)) continue;
				return {
					backendNodeId: node.backendNodeId,
					frameId: node.frameId,
					nodeId: node.nodeId || nodeId
				};
			}
		}
		return null;
	} finally {
		try {
			await send("DOM.discardSearchResults", { searchId });
		} catch (error) {
			if (isFatalProtocolError(error)) throw error;
		}
	}
}

async function trySolveWidget(send, tabId, state, job) {
	const active = () => isActiveJob(tabId, state, job) && Date.now() < job.deadline;
	if (!active()) return "cancelled";

	const located = await findWidgetFrame(state, send, job.widgetId);
	if (!located || !active()) return active() ? "retry" : "cancelled";
	const { frame, send: frameSend } = located;

	try {
		await frameSend("DOM.scrollIntoViewIfNeeded", { nodeId: frame.nodeId });
	} catch (error) {
		if (isFatalProtocolError(error)) throw error;
		return "retry";
	}
	if (!active()) return "cancelled";

	const target = await chooseSafeClickTarget(frameSend, frame, job);
	if (!target || !active()) return active() ? "retry" : "cancelled";

	const clickPlan = await buildClickPlan(state, send, located, target);
	if (!clickPlan || !active()) return active() ? "retry" : "cancelled";
	const clickActive = () => active() && frameRevisionsMatch(state, clickPlan.revisions);

	const clicked = await moveAndClick(
		clickPlan.send,
		clickPlan.target,
		clickActive,
		() => verifyClickPlan(clickPlan)
	);
	if (!active()) return "cancelled";
	return clicked ? "clicked" : "retry";
}

async function chooseSafeClickTarget(send, frame, job = null) {
	const [{ model }, { computedStyle = [] }, metrics] = await Promise.all([
		send("DOM.getBoxModel", { nodeId: frame.nodeId }),
		send("CSS.getComputedStyleForNode", { nodeId: frame.nodeId }),
		send("Page.getLayoutMetrics")
	]);

	const content = model?.content;
	if (!Array.isArray(content) || content.length !== 8) return null;
	if (!isAffineQuad(content)) return null;
	if (!isFrameStyleVisible(computedStyle)) return null;

	const width = distance(content[0], content[1], content[2], content[3]);
	const height = distance(content[0], content[1], content[6], content[7]);
	if (width < 80 || height < 30) return null;

	// Nudge the checkbox heuristic slightly on misses (compact / atypical widgets).
	const missShift = Math.min(0.08, (job?.misses || 0) * 0.02);
	const xFraction = clamp(Math.min(35, width * (0.15 + missShift)) / width, 0.08, 0.30);
	const yFraction = clamp(0.5 + ((job?.misses || 0) % 2 === 1 ? 0.04 : 0), 0.42, 0.58);
	const localPoint = pointInQuad(content, xFraction, yFraction);
	localPoint.x += randInt(-2, 3);
	localPoint.y += randInt(-3, 4);

	const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
	const viewportWidth = viewport?.clientWidth;
	const viewportHeight = viewport?.clientHeight;
	if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) return null;

	const localBounds = quadBounds(content);
	if (localPoint.x < 1 || localPoint.y < 1
		|| localPoint.x >= viewportWidth - 1 || localPoint.y >= viewportHeight - 1) return null;
	if (!await hitMatchesFrame(send, localPoint, frame)) return null;

	return {
		point: localPoint,
		quad: content.slice(),
		bounds: {
			left: Math.max(0, localBounds.left),
			top: Math.max(0, localBounds.top),
			right: Math.min(viewportWidth - 1, localBounds.right),
			bottom: Math.min(viewportHeight - 1, localBounds.bottom)
		},
		viewport: { width: viewportWidth, height: viewportHeight }
	};
}

async function leafTargetIsCurrent(send, frame, target) {
	const [{ model }, { computedStyle = [] }, metrics] = await Promise.all([
		send("DOM.getBoxModel", { nodeId: frame.nodeId }),
		send("CSS.getComputedStyleForNode", { nodeId: frame.nodeId }),
		send("Page.getLayoutMetrics")
	]);
	const content = model?.content;
	if (!Array.isArray(content) || content.length !== 8 || !Array.isArray(target.quad)) return false;
	if (!isAffineQuad(content) || !isFrameStyleVisible(computedStyle)) return false;
	if (content.some((value, index) => Math.abs(value - target.quad[index]) > 0.0001)) return false;

	const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
	if (!Number.isFinite(viewport?.clientWidth) || !Number.isFinite(viewport?.clientHeight)) return false;
	if (Math.abs(viewport.clientWidth - target.viewport.width) > 0.0001
		|| Math.abs(viewport.clientHeight - target.viewport.height) > 0.0001) return false;
	return hitMatchesFrame(send, target.point, frame);
}

async function buildClickPlan(state, rootSend, located, initialTarget) {
	const revisions = new Map();
	watchFrameRevision(state, revisions, located.frame.frameId);
	if (!await leafTargetIsCurrent(located.send, located.frame, initialTarget)) return null;
	if (!frameRevisionsMatch(state, revisions)) return null;

	let target = initialTarget;
	let context = located.context;
	const checks = [{
		frame: located.frame,
		point: { ...target.point },
		send: located.send
	}];
	const visited = new Set();

	while (context) {
		if (state.detaching || !frameRevisionsMatch(state, revisions)
			|| context.failed || visited.has(context.sessionId)) return null;
		visited.add(context.sessionId);

		let parentContext = null;
		if (context.parentSessionId) {
			parentContext = state.sessions.get(context.parentSessionId);
			if (!parentContext) return null;
			await parentContext.ready;
			if (parentContext.failed) return null;
		}
		const parentSend = parentContext?.send || rootSend;
		const ownerFrameId = context.targetInfo?.targetId;
		if (typeof ownerFrameId !== "string" || ownerFrameId.length === 0) return null;
		watchFrameRevision(state, revisions, ownerFrameId);

		await parentSend("DOM.getDocument", { depth: 0, pierce: true });
		const owner = await parentSend("DOM.getFrameOwner", { frameId: ownerFrameId });
		if (!owner.backendNodeId && !owner.nodeId) return null;
		let ownerNodeId = owner.nodeId;
		if (!ownerNodeId && owner.backendNodeId) {
			const { nodeIds = [] } = await parentSend("DOM.pushNodesByBackendIdsToFrontend", {
				backendNodeIds: [owner.backendNodeId]
			});
			ownerNodeId = nodeIds[0];
		}
		if (!ownerNodeId) return null;
		const [{ model }, { computedStyle = [] }] = await Promise.all([
			parentSend("DOM.getBoxModel", { nodeId: ownerNodeId }),
			parentSend("CSS.getComputedStyleForNode", { nodeId: ownerNodeId })
		]);
		const content = model?.content;
		if (!Array.isArray(content) || content.length !== 8) return null;
		if (!isAffineQuad(content) || !isFrameStyleVisible(computedStyle)) return null;

		const horizontal = target.point.x / target.viewport.width;
		const vertical = target.point.y / target.viewport.height;
		if (horizontal < 0 || horizontal > 1 || vertical < 0 || vertical > 1) return null;
		const point = pointInQuad(content, horizontal, vertical);

		const metrics = await parentSend("Page.getLayoutMetrics");
		const parentViewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.layoutViewport;
		const width = parentViewport?.clientWidth;
		const height = parentViewport?.clientHeight;
		if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
		if (point.x < 1 || point.y < 1 || point.x >= width - 1 || point.y >= height - 1) return null;

		const ownerFrame = {
			backendNodeId: owner.backendNodeId,
			frameId: ownerFrameId,
			nodeId: ownerNodeId
		};
		if (!await hitMatchesFrame(parentSend, point, ownerFrame)) return null;

		const bounds = quadBounds(content);
		target = {
			point,
			bounds: {
				left: Math.max(0, bounds.left),
				top: Math.max(0, bounds.top),
				right: Math.min(width - 1, bounds.right),
				bottom: Math.min(height - 1, bounds.bottom)
			},
			viewport: { width, height }
		};
		checks.push({ frame: ownerFrame, point: { ...point }, send: parentSend });
		context = parentContext;
	}

	if (!frameRevisionsMatch(state, revisions)) return null;
	return {
		challenge: { frameId: located.frame.frameId, send: located.send },
		checks,
		revisions,
		send: rootSend,
		source: { initialTarget, located, rootSend },
		state,
		target
	};
}

async function verifyClickPlan(plan) {
	if (!frameRevisionsMatch(plan.state, plan.revisions)) return false;
	const fresh = await buildClickPlan(
		plan.state,
		plan.source.rootSend,
		plan.source.located,
		plan.source.initialTarget
	);
	if (!fresh || !frameRevisionsMatch(plan.state, plan.revisions)) return false;
	if (distance(fresh.target.point.x, fresh.target.point.y, plan.target.point.x, plan.target.point.y) > 0.0001) {
		return false;
	}
	if (!await frameHasAllowedChallengeUrl(
		fresh.state,
		fresh.challenge.send,
		fresh.challenge.frameId
	)) return false;
	for (const check of fresh.checks) {
		if (!frameRevisionsMatch(fresh.state, fresh.revisions)) return false;
		if (!await hitMatchesFrame(check.send, check.point, check.frame)) return false;
	}
	return frameRevisionsMatch(plan.state, plan.revisions)
		&& frameRevisionsMatch(fresh.state, fresh.revisions);
}

function isFrameStyleVisible(computedStyle) {
	const styles = new Map(computedStyle.map(({ name, value }) => [name, value]));
	const opacity = Number.parseFloat(styles.get("opacity") ?? "1");
	return styles.get("display") !== "none"
		&& styles.get("visibility") !== "hidden"
		&& styles.get("visibility") !== "collapse"
		&& styles.get("pointer-events") !== "none"
		&& styles.get("content-visibility") !== "hidden"
		&& Number.isFinite(opacity)
		&& opacity > 0.05;
}

function distance(x1, y1, x2, y2) {
	return Math.hypot(x2 - x1, y2 - y1);
}

function pointInQuad(quad, horizontal, vertical) {
	const topX = quad[0] + (quad[2] - quad[0]) * horizontal;
	const topY = quad[1] + (quad[3] - quad[1]) * horizontal;
	const bottomX = quad[6] + (quad[4] - quad[6]) * horizontal;
	const bottomY = quad[7] + (quad[5] - quad[7]) * horizontal;
	return {
		x: topX + (bottomX - topX) * vertical,
		y: topY + (bottomY - topY) * vertical
	};
}

function quadBounds(quad) {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys)
	};
}

function isAffineQuad(quad, tolerance = 0.01) {
	return Math.abs((quad[0] + quad[4]) - (quad[2] + quad[6])) <= tolerance
		&& Math.abs((quad[1] + quad[5]) - (quad[3] + quad[7])) <= tolerance;
}

async function hitMatchesFrame(send, point, frame) {
	try {
		const hit = await send("DOM.getNodeForLocation", {
			x: Math.round(point.x),
			y: Math.round(point.y),
			includeUserAgentShadowDOM: true,
			ignorePointerEventsNone: false
		});
		if (hit.backendNodeId === frame.backendNodeId) return true;
		if (hit.frameId !== frame.frameId || !hit.backendNodeId) return false;

		// frameId match means the point entered this frame's content. Reject if the topmost
		// node is a different iframe (nested/wrong target) rather than content of ours.
		try {
			const { node } = await send("DOM.describeNode", {
				backendNodeId: hit.backendNodeId,
				depth: 0,
				pierce: false
			});
			if (node?.nodeName === "IFRAME" && node.frameId && node.frameId !== frame.frameId) {
				return false;
			}
		} catch (error) {
			if (isFatalProtocolError(error)) throw error;
		}
		return true;
	} catch (error) {
		if (isFatalProtocolError(error)) throw error;
		return false;
	}
}

function quadratic(t, start, control, end) {
	const inverse = 1 - t;
	return inverse * inverse * start + 2 * inverse * t * control + t * t * end;
}

function easeInOut(t) {
	return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

async function moveAndClick(send, target, active, verifyTarget) {
	const { point, bounds, viewport } = target;
	const insetBounds = {
		left: Math.min(bounds.right, bounds.left + 2),
		top: Math.min(bounds.bottom, bounds.top + 2),
		right: Math.max(bounds.left, bounds.right - 2),
		bottom: Math.max(bounds.top, bounds.bottom - 2)
	};
	const angle = Math.random() * Math.PI * 2;
	const travel = randInt(45, 81);
	const start = {
		x: clamp(point.x + Math.cos(angle) * travel, insetBounds.left, insetBounds.right),
		y: clamp(point.y + Math.sin(angle) * travel, insetBounds.top, insetBounds.bottom)
	};
	const control = {
		x: clamp((start.x + point.x) / 2 + randInt(-22, 23), insetBounds.left, insetBounds.right),
		y: clamp((start.y + point.y) / 2 + randInt(-22, 23), insetBounds.top, insetBounds.bottom)
	};
	const steps = randInt(10, 16);

	for (let index = 0; index <= steps; index++) {
		if (!active()) return false;
		const t = easeInOut(index / steps);
		await send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: clamp(quadratic(t, start.x, control.x, point.x) + randInt(-1, 2), 0, viewport.width - 1),
			y: clamp(quadratic(t, start.y, control.y, point.y) + randInt(-1, 2), 0, viewport.height - 1),
			buttons: 0
		});
		if (!await waitWhile(humanDelay(18, 6, 7, 42), active)) return false;
	}

	for (let index = 0; index < randInt(3, 6); index++) {
		if (!active()) return false;
		await send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: clamp(point.x + randInt(-2, 3), insetBounds.left, insetBounds.right),
			y: clamp(point.y + randInt(-2, 3), insetBounds.top, insetBounds.bottom),
			buttons: 0
		});
		if (!await waitWhile(humanDelay(25, 8, 8, 55), active)) return false;
	}

	await send("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: point.x,
		y: point.y,
		buttons: 0
	});
	if (!await waitWhile(randInt(35, 71), active)) return false;
	if (!active()) return false;
	if (!await verifyTarget()) return false;
	if (!active()) return false;

	let pressError = null;
	try {
		await send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: point.x,
			y: point.y,
			button: "left",
			buttons: 1,
			clickCount: 1
		});
		await waitWhile(randInt(45, 86), active);
	} catch (error) {
		pressError = error;
	}

	// Always attempt the release regardless of the press outcome: the press command may have
	// reached the renderer even if its CDP ack failed, so skipping the release risks a stuck button.
	let releaseError = null;
	try {
		await send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: point.x,
			y: point.y,
			button: "left",
			buttons: 0,
			clickCount: 1
		});
	} catch (error) {
		releaseError = new Error(`Mouse release failed: ${errorMessage(error)}`);
	}

	if (pressError && releaseError) {
		throw new Error(`${errorMessage(pressError)}; ${releaseError.message}`);
	}
	if (releaseError) throw releaseError;
	// Press ack failed but release succeeded: the click may already have landed in the
	// renderer. Treat as success so the runner waits for Cloudflare instead of clicking again.
	if (pressError) {
		console.warn("[Turnstile Solver] Mouse press ack failed after successful release:", errorMessage(pressError));
	}

	return true;
}
