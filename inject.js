(() => {
	"use strict";

	const mousePrototype = globalThis.MouseEvent?.prototype;
	if (!mousePrototype) return;

	const screenXDescriptor = Object.getOwnPropertyDescriptor(mousePrototype, "screenX");
	const screenYDescriptor = Object.getOwnPropertyDescriptor(mousePrototype, "screenY");
	const toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
	if (!screenXDescriptor?.get || !screenYDescriptor?.get || !toStringDescriptor?.value) return;
	if (!screenXDescriptor.configurable || !screenYDescriptor.configurable || !toStringDescriptor.configurable) return;

	function topScreenOrigin() {
		return {
			x: Number.isFinite(globalThis.screenX)
				? globalThis.screenX
				: Number.isFinite(screen.availLeft) ? screen.availLeft : 0,
			y: Number.isFinite(globalThis.screenY)
				? globalThis.screenY
				: Number.isFinite(screen.availTop) ? screen.availTop : 0
		};
	}

	// Convert client coordinates in this frame to approximate screen coordinates by walking
	// frameElement offsets up to the top window, then adding the browser window origin.
	function clientToScreen(clientX, clientY) {
		let x = clientX;
		let y = clientY;
		let current = globalThis;
		const seen = new Set();

		while (current && !seen.has(current)) {
			seen.add(current);
			let frameElement = null;
			try {
				frameElement = current.frameElement;
			} catch {
				break;
			}
			if (!frameElement) break;

			try {
				const rect = frameElement.getBoundingClientRect();
				x += rect.left + (frameElement.clientLeft || 0);
				y += rect.top + (frameElement.clientTop || 0);
			} catch {
				break;
			}

			try {
				if (current === current.top) break;
				current = current.parent;
			} catch {
				break;
			}
		}

		try {
			const topWin = globalThis.top || globalThis;
			if (topWin.visualViewport) {
				x += topWin.visualViewport.offsetLeft || 0;
				y += topWin.visualViewport.offsetTop || 0;
			}
		} catch {
			// Cross-origin top: skip visualViewport adjustment.
		}

		const origin = topScreenOrigin();
		return { x: x + origin.x, y: y + origin.y };
	}

	function looksLikeRealScreenCoord(nativeValue, clientValue) {
		return Number.isFinite(nativeValue)
			&& nativeValue !== 0
			&& Math.abs(nativeValue - clientValue) > 1;
	}

	const cache = new WeakMap();

	function getScreen(event) {
		let point = cache.get(event);
		if (!point) {
			point = clientToScreen(event.clientX, event.clientY);
			cache.set(event, point);
		}
		return point;
	}

	const screenXHolder = {
		get screenX() {
			const nativeValue = Reflect.apply(screenXDescriptor.get, this, []);
			if (this.isTrusted !== true) return nativeValue;
			// Prefer the browser's own screen coord when CDP/OS already filled a plausible value.
			if (looksLikeRealScreenCoord(nativeValue, this.clientX)) return nativeValue;
			return getScreen(this).x;
		}
	};
	const screenYHolder = {
		get screenY() {
			const nativeValue = Reflect.apply(screenYDescriptor.get, this, []);
			if (this.isTrusted !== true) return nativeValue;
			if (looksLikeRealScreenCoord(nativeValue, this.clientY)) return nativeValue;
			return getScreen(this).y;
		}
	};
	const screenXGetter = Object.getOwnPropertyDescriptor(screenXHolder, "screenX").get;
	const screenYGetter = Object.getOwnPropertyDescriptor(screenYHolder, "screenY").get;
	const originalToString = toStringDescriptor.value;
	const nativeSources = new WeakMap([
		[screenXGetter, Reflect.apply(originalToString, screenXDescriptor.get, [])],
		[screenYGetter, Reflect.apply(originalToString, screenYDescriptor.get, [])]
	]);
	const maskedToString = function toString() {
		const source = nativeSources.get(this);
		return source === undefined ? Reflect.apply(originalToString, this, []) : source;
	};
	nativeSources.set(maskedToString, Reflect.apply(originalToString, originalToString, []));

	let patchedX = false;
	let patchedY = false;
	try {
		Object.defineProperty(mousePrototype, "screenX", {
			...screenXDescriptor,
			get: screenXGetter
		});
		patchedX = true;
		Object.defineProperty(mousePrototype, "screenY", {
			...screenYDescriptor,
			get: screenYGetter
		});
		patchedY = true;
		Object.defineProperty(Function.prototype, "toString", {
			...toStringDescriptor,
			value: maskedToString
		});
	} catch {
		try {
			if (patchedX) Object.defineProperty(mousePrototype, "screenX", screenXDescriptor);
			if (patchedY) Object.defineProperty(mousePrototype, "screenY", screenYDescriptor);
		} catch {
			// A hostile page can race descriptor changes; never break the challenge.
		}
	}
})();
