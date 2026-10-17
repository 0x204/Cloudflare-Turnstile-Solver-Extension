import { FatalProtocolError } from "./cdp.js";
import { clamp, clampToRect, insetRect } from "./geometry.js";
import { warn } from "./log.js";
import { humanDelay, jitter, randomInt } from "./random.js";
import { sleep } from "./timing.js";

const APPROACH_DELAY = { mean: 18, deviation: 6, min: 7, max: 42 };
const HOVER_DELAY = { mean: 25, deviation: 8, min: 8, max: 55 };

const MOVE = { type: "mouseMoved", buttons: 0 };
const PRESS = { type: "mousePressed", button: "left", buttons: 1, clickCount: 1 };
const RELEASE = { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1 };

function quadraticBezier(t, start, control, end) {
	const inverse = 1 - t;
	return inverse * inverse * start + 2 * inverse * t * control + t * t * end;
}

function easeInOut(t) {
	return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

export function pointerPath({ point, bounds, viewport }) {
	const area = insetRect(bounds, 2);
	const angle = Math.random() * 2 * Math.PI;
	const travel = randomInt(45, 80);
	const start = clampToRect(
		{ x: point.x + Math.cos(angle) * travel, y: point.y + Math.sin(angle) * travel },
		area,
	);
	const control = clampToRect(
		{ x: (start.x + point.x) / 2 + jitter(22), y: (start.y + point.y) / 2 + jitter(22) },
		area,
	);

	const path = [];
	const steps = randomInt(10, 15);
	for (let step = 0; step <= steps; step++) {
		const t = easeInOut(step / steps);
		path.push({
			x: clamp(quadraticBezier(t, start.x, control.x, point.x) + jitter(1), 0, viewport.width - 1),
			y: clamp(quadraticBezier(t, start.y, control.y, point.y) + jitter(1), 0, viewport.height - 1),
			delay: humanDelay(APPROACH_DELAY),
		});
	}

	const hovers = randomInt(3, 5);
	for (let hover = 0; hover < hovers; hover++) {
		const position = clampToRect({ x: point.x + jitter(2), y: point.y + jitter(2) }, area);
		path.push({ ...position, delay: humanDelay(HOVER_DELAY) });
	}

	path.push({ x: point.x, y: point.y, delay: randomInt(35, 70) });
	return path;
}

function dispatch(session, event, { x, y }) {
	return session.send("Input.dispatchMouseEvent", { ...event, x, y });
}

async function pressAndRelease(session, point) {
	let pressError = null;
	try {
		await dispatch(session, PRESS, point);
		await sleep(randomInt(45, 85));
	} catch (error) {
		pressError = error;
	}

	try {
		await dispatch(session, RELEASE, point);
	} catch (error) {
		throw new FatalProtocolError(`Mouse release failed: ${error.message}`, { cause: error });
	}

	if (pressError) warn("Mouse press was not acknowledged:", pressError);
}

export async function click(session, target, { signal, confirm }) {
	for (const { x, y, delay } of pointerPath(target)) {
		signal.throwIfAborted();
		await dispatch(session, MOVE, { x, y });
		await sleep(delay, signal);
	}

	if (!(await confirm())) return false;
	signal.throwIfAborted();

	await pressAndRelease(session, target.point);
	return true;
}
