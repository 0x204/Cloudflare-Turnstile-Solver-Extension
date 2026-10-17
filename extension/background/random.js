import { clamp } from "./geometry.js";

export function randomInt(min, max) {
	return min + Math.floor(Math.random() * (max - min + 1));
}

export function jitter(amplitude) {
	return randomInt(-amplitude, amplitude);
}

function randomNormal(mean, deviation) {
	const u = 1 - Math.random();
	const v = Math.random();
	return mean + deviation * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function humanDelay({ mean, deviation, min, max }) {
	return Math.round(clamp(randomNormal(mean, deviation), min, max));
}
