import { isRecoverable, tolerate } from "./cdp.js";
import { isChallengeUrl, widgetFrameId } from "./protocol.js";

const MAX_SEARCH_RESULTS = 64;

function attribute(node, name) {
	const attributes = node.attributes ?? [];
	for (let index = 0; index < attributes.length; index += 2) {
		if (attributes[index] === name) return attributes[index + 1];
	}
	return null;
}

function findFrame(tree, frameId) {
	if (!tree) return null;
	if (tree.frame.id === frameId) return tree.frame;
	for (const child of tree.childFrames ?? []) {
		const frame = findFrame(child, frameId);
		if (frame) return frame;
	}
	return null;
}

async function frameUrl(session, frameId) {
	const { frameTree } = await session.send("Page.getFrameTree");
	return findFrame(frameTree, frameId)?.url;
}

export async function hostsChallenge(connection, session, frameId) {
	const child = connection.sessionForTarget(frameId);
	if (!child) return isChallengeUrl(await frameUrl(session, frameId));

	await child.ready;
	return (
		!child.closed && isChallengeUrl(child.url) && isChallengeUrl(await frameUrl(child, frameId))
	);
}

async function describeWidgetFrame(session, nodeId, iframeId) {
	const { node } = await session.send("DOM.describeNode", { nodeId, depth: 0, pierce: true });
	const isWidget =
		node.nodeName === "IFRAME" &&
		Boolean(node.backendNodeId && node.frameId) &&
		attribute(node, "id") === iframeId &&
		isChallengeUrl(attribute(node, "src"));
	return isWidget ? { nodeId, backendNodeId: node.backendNodeId, frameId: node.frameId } : null;
}

async function findWidgetFrame(connection, session, iframeId) {
	await session.send("DOM.getDocument", { depth: 0, pierce: true });
	const { searchId, resultCount } = await session.send("DOM.performSearch", {
		query: `iframe[id="${iframeId}"]`,
	});

	try {
		if (resultCount === 0) return null;
		const { nodeIds } = await session.send("DOM.getSearchResults", {
			searchId,
			fromIndex: 0,
			toIndex: Math.min(resultCount, MAX_SEARCH_RESULTS),
		});

		for (const nodeId of nodeIds.filter(Boolean)) {
			const frame = await describeWidgetFrame(session, nodeId, iframeId);
			if (frame && (await hostsChallenge(connection, session, frame.frameId))) return frame;
		}
		return null;
	} finally {
		await tolerate(session.send("DOM.discardSearchResults", { searchId }));
	}
}

async function searchSession(connection, session, iframeId) {
	await session.ready;
	if (session.closed) return null;
	const frame = await findWidgetFrame(connection, session, iframeId);
	return frame && { session, frame };
}

// Searches all frames at once and settles on the first one holding the widget, so a frame that
// does not answer costs one command timeout at most. Resolves to null only when every frame was
// searched: a failed search rejects instead, since the widget may be in that frame.
export function locateWidget(connection, widgetId) {
	const iframeId = widgetFrameId(widgetId);
	const searches = connection
		.sessions()
		.map((session) => searchSession(connection, session, iframeId));

	return new Promise((resolve, reject) => {
		let pending = searches.length;
		let failure = null;

		const settle = () => {
			pending -= 1;
			if (pending > 0) return;
			if (failure) reject(failure);
			else resolve(null);
		};

		for (const search of searches) {
			search.then(
				(located) => {
					if (located) resolve(located);
					settle();
				},
				(error) => {
					if (!isRecoverable(error)) reject(error);
					failure ??= error;
					settle();
				},
			);
		}
	});
}
