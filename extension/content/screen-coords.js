"use strict";

{
	const nativeScreenX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "screenX");
	const nativeScreenY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, "screenY");
	const nativeToString = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
	const positions = new WeakMap();

	const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

	function frameElementOf(view) {
		try {
			return view.frameElement;
		} catch {
			return null;
		}
	}

	function topViewportOffset() {
		try {
			const { visualViewport } = window.top;
			return { x: visualViewport?.offsetLeft ?? 0, y: visualViewport?.offsetTop ?? 0 };
		} catch {
			return { x: 0, y: 0 };
		}
	}

	function clientToScreen(clientX, clientY) {
		let x = clientX;
		let y = clientY;
		let view = window;
		let owner = frameElementOf(view);

		while (owner) {
			const rect = owner.getBoundingClientRect();
			x += rect.left + owner.clientLeft;
			y += rect.top + owner.clientTop;
			view = view.parent;
			owner = frameElementOf(view);
		}

		const offset = topViewportOffset();
		return {
			x: x + offset.x + finiteOr(window.screenX, finiteOr(screen.availLeft, 0)),
			y: y + offset.y + finiteOr(window.screenY, finiteOr(screen.availTop, 0)),
		};
	}

	function screenPosition(event) {
		let position = positions.get(event);
		if (!position) {
			position = clientToScreen(event.clientX, event.clientY);
			positions.set(event, position);
		}
		return position;
	}

	function isPlausible(screenValue, clientValue) {
		return (
			Number.isFinite(screenValue) && screenValue !== 0 && Math.abs(screenValue - clientValue) > 1
		);
	}

	function resolve(event, nativeGetter, axis, clientKey) {
		const nativeValue = Reflect.apply(nativeGetter, event, []);
		if (event.isTrusted !== true || isPlausible(nativeValue, event[clientKey])) return nativeValue;
		return screenPosition(event)[axis];
	}

	function patch() {
		const { screenX: patchedX, screenY: patchedY } = Object.getOwnPropertyDescriptors({
			get screenX() {
				return resolve(this, nativeScreenX.get, "x", "clientX");
			},
			get screenY() {
				return resolve(this, nativeScreenY.get, "y", "clientY");
			},
		});

		const sourceOf = (fn) => Reflect.apply(nativeToString.value, fn, []);
		const nativeSources = new WeakMap([
			[patchedX.get, sourceOf(nativeScreenX.get)],
			[patchedY.get, sourceOf(nativeScreenY.get)],
		]);
		const maskedToString = function toString() {
			return nativeSources.get(this) ?? Reflect.apply(nativeToString.value, this, []);
		};
		nativeSources.set(maskedToString, sourceOf(nativeToString.value));

		Object.defineProperty(MouseEvent.prototype, "screenX", { ...nativeScreenX, get: patchedX.get });
		Object.defineProperty(MouseEvent.prototype, "screenY", { ...nativeScreenY, get: patchedY.get });
		Object.defineProperty(Function.prototype, "toString", {
			...nativeToString,
			value: maskedToString,
		});
	}

	const natives = [nativeScreenX, nativeScreenY, nativeToString];
	if (natives.every((descriptor) => descriptor?.configurable)) patch();
}
