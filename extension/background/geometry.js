const EPSILON = 1e-4;

export function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

export function isParallelogram(quad, tolerance = 0.01) {
	return (
		Array.isArray(quad) &&
		quad.length === 8 &&
		Math.abs(quad[0] + quad[4] - (quad[2] + quad[6])) <= tolerance &&
		Math.abs(quad[1] + quad[5] - (quad[3] + quad[7])) <= tolerance
	);
}

export function quadPoint(quad, u, v) {
	const topX = quad[0] + (quad[2] - quad[0]) * u;
	const topY = quad[1] + (quad[3] - quad[1]) * u;
	const bottomX = quad[6] + (quad[4] - quad[6]) * u;
	const bottomY = quad[7] + (quad[5] - quad[7]) * u;
	return { x: topX + (bottomX - topX) * v, y: topY + (bottomY - topY) * v };
}

export function quadSize(quad) {
	return {
		width: Math.hypot(quad[2] - quad[0], quad[3] - quad[1]),
		height: Math.hypot(quad[6] - quad[0], quad[7] - quad[1]),
	};
}

export function quadBounds(quad) {
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return {
		left: Math.min(...xs),
		top: Math.min(...ys),
		right: Math.max(...xs),
		bottom: Math.max(...ys),
	};
}

export function visibleBounds(quad, viewport) {
	const { left, top, right, bottom } = quadBounds(quad);
	return {
		left: Math.max(0, left),
		top: Math.max(0, top),
		right: Math.min(viewport.width - 1, right),
		bottom: Math.min(viewport.height - 1, bottom),
	};
}

export function insetRect(rect, amount) {
	return {
		left: Math.min(rect.right, rect.left + amount),
		top: Math.min(rect.bottom, rect.top + amount),
		right: Math.max(rect.left, rect.right - amount),
		bottom: Math.max(rect.top, rect.bottom - amount),
	};
}

export function clampToRect({ x, y }, rect) {
	return { x: clamp(x, rect.left, rect.right), y: clamp(y, rect.top, rect.bottom) };
}

export function isInViewport({ x, y }, { width, height }, margin = 1) {
	return x >= margin && y >= margin && x < width - margin && y < height - margin;
}

export function sameQuad(a, b) {
	return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= EPSILON);
}

export function samePoint(a, b) {
	return Math.hypot(a.x - b.x, a.y - b.y) <= EPSILON;
}

export function sameSize(a, b) {
	return Math.abs(a.width - b.width) <= EPSILON && Math.abs(a.height - b.height) <= EPSILON;
}
