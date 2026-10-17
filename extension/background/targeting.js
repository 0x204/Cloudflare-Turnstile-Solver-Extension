import { tolerate } from "./cdp.js";
import {
	clamp,
	isInViewport,
	isParallelogram,
	quadPoint,
	quadSize,
	sameQuad,
	samePoint,
	sameSize,
	visibleBounds,
} from "./geometry.js";
import { hostsChallenge } from "./locator.js";
import { jitter } from "./random.js";

const MIN_WIDGET_WIDTH = 80;
const MIN_WIDGET_HEIGHT = 30;
const MIN_OPACITY = 0.05;
const HIDDEN_VISIBILITY = new Set(["hidden", "collapse"]);

const CHECKBOX_OFFSET = {
	maxPx: 35,
	ratio: 0.15,
	missStep: 0.02,
	maxMissShift: 0.08,
	min: 0.08,
	max: 0.3,
};

function isRendered(computedStyle) {
	const style = Object.fromEntries(computedStyle.map(({ name, value }) => [name, value]));
	return (
		style.display !== "none" &&
		!HIDDEN_VISIBILITY.has(style.visibility) &&
		style["pointer-events"] !== "none" &&
		style["content-visibility"] !== "hidden" &&
		Number.parseFloat(style.opacity ?? "1") > MIN_OPACITY
	);
}

function viewportOf(metrics, session) {
	const viewport = session.isRoot
		? (metrics.cssVisualViewport ?? metrics.cssLayoutViewport)
		: metrics.cssLayoutViewport;
	const { clientWidth: width, clientHeight: height, pageX = 0, pageY = 0 } = viewport ?? {};
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
	return { width, height, scrollX: pageX, scrollY: pageY };
}

async function measureFrame(session, nodeId) {
	const [{ model }, { computedStyle = [] }, metrics] = await Promise.all([
		session.send("DOM.getBoxModel", { nodeId }),
		session.send("CSS.getComputedStyleForNode", { nodeId }),
		session.send("Page.getLayoutMetrics"),
	]);
	const quad = model?.content;
	const viewport = viewportOf(metrics, session);
	if (!isParallelogram(quad) || !viewport || !isRendered(computedStyle)) return null;
	return { quad, viewport };
}

async function isForeignFrameOwner(session, backendNodeId, frameId) {
	const described = await tolerate(
		session.send("DOM.describeNode", { backendNodeId, depth: 0, pierce: false }),
		null,
	);
	const node = described?.node;
	return node?.nodeName === "IFRAME" && Boolean(node.frameId) && node.frameId !== frameId;
}

async function hitsFrame(session, point, viewport, frame) {
	const hit = await tolerate(
		session.send("DOM.getNodeForLocation", {
			x: Math.round(point.x + viewport.scrollX),
			y: Math.round(point.y + viewport.scrollY),
			includeUserAgentShadowDOM: true,
			ignorePointerEventsNone: false,
		}),
		null,
	);
	if (!hit) return false;
	if (hit.backendNodeId === frame.backendNodeId) return true;
	if (hit.frameId !== frame.frameId || !hit.backendNodeId) return false;
	return !(await isForeignFrameOwner(session, hit.backendNodeId, frame.frameId));
}

async function frameOwner(session, frameId) {
	await session.send("DOM.getDocument", { depth: 0, pierce: true });
	const { backendNodeId, nodeId } = await session.send("DOM.getFrameOwner", { frameId });
	if (nodeId) return { frameId, backendNodeId, nodeId };
	if (!backendNodeId) return null;

	const { nodeIds = [] } = await session.send("DOM.pushNodesByBackendIdsToFrontend", {
		backendNodeIds: [backendNodeId],
	});
	return nodeIds[0] ? { frameId, backendNodeId, nodeId: nodeIds[0] } : null;
}

function checkboxPoint(quad, width, misses) {
	const { maxPx, ratio, missStep, maxMissShift, min, max } = CHECKBOX_OFFSET;
	const shift = Math.min(misses * missStep, maxMissShift);
	const u = clamp(Math.min(maxPx / width, ratio + shift), min, max);
	const v = misses % 2 === 0 ? 0.5 : 0.54;
	return quadPoint(quad, u, v);
}

async function chooseTarget({ session, frame }, misses) {
	const geometry = await measureFrame(session, frame.nodeId);
	if (!geometry) return null;

	const { width, height } = quadSize(geometry.quad);
	if (width < MIN_WIDGET_WIDTH || height < MIN_WIDGET_HEIGHT) return null;

	const anchor = checkboxPoint(geometry.quad, width, misses);
	const point = { x: anchor.x + jitter(2), y: anchor.y + jitter(3) };
	if (!isInViewport(point, geometry.viewport)) return null;
	if (!(await hitsFrame(session, point, geometry.viewport, frame))) return null;
	return { ...geometry, point };
}

async function projectToRoot(connection, located, leaf, watch) {
	watch.add(located.frame.frameId);
	let current = leaf;
	let session = located.session;

	while (session !== connection.root) {
		const parent = await connection.parentOf(session);
		if (!parent) return null;
		watch.add(session.targetId);

		const owner = await frameOwner(parent, session.targetId);
		const geometry = owner && (await measureFrame(parent, owner.nodeId));
		if (!geometry) return null;

		const point = quadPoint(
			geometry.quad,
			current.point.x / current.viewport.width,
			current.point.y / current.viewport.height,
		);
		if (!isInViewport(point, geometry.viewport)) return null;
		if (!(await hitsFrame(parent, point, geometry.viewport, owner))) return null;

		current = { ...geometry, point };
		session = parent;
	}

	return {
		point: current.point,
		bounds: visibleBounds(current.quad, current.viewport),
		viewport: current.viewport,
	};
}

async function isTargetCurrent(connection, located, leaf, target, watch) {
	const geometry = await measureFrame(located.session, located.frame.nodeId);
	if (!geometry || !sameQuad(geometry.quad, leaf.quad)) return false;
	if (!sameSize(geometry.viewport, leaf.viewport)) return false;
	if (!(await hitsFrame(located.session, leaf.point, geometry.viewport, located.frame))) {
		return false;
	}

	const projected = await projectToRoot(connection, located, leaf, watch);
	if (!projected || !samePoint(projected.point, target.point)) return false;
	return tolerate(hostsChallenge(connection, located.session, located.frame.frameId), false);
}

export async function planClick(connection, located, misses, watch) {
	const leaf = await chooseTarget(located, misses);
	if (!leaf) return null;

	const target = await projectToRoot(connection, located, leaf, watch);
	if (!target) return null;

	return {
		target,
		confirm: () => isTargetCurrent(connection, located, leaf, target, watch),
	};
}
