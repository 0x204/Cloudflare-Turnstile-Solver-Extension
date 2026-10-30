import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { CHECKBOX, HOST_URL, scenarioRoutes } from "./pages.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../extension", import.meta.url));
const TEST = { timeout: 60_000 };

async function openScenario(t, { showScrollbars = false, ...options } = {}) {
	const profile = await mkdtemp(path.join(tmpdir(), "turnstile-e2e-"));
	const context = await chromium.launchPersistentContext(profile, {
		channel: "chromium",
		executablePath: process.env.CHROMIUM_PATH,
		headless: true,
		viewport: { width: 1280, height: 720 },
		ignoreDefaultArgs: showScrollbars ? ["--hide-scrollbars"] : [],
		args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
	});
	t.after(async () => {
		await context.close();
		await rm(profile, { recursive: true, force: true });
	});

	await context.route("**/*", (route) => route.abort());
	for (const [pattern, body] of Object.entries(scenarioRoutes(options))) {
		await context.route(pattern, (route) => route.fulfill({ contentType: "text/html", body }));
	}

	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
	const page = await context.newPage();
	await page.goto(HOST_URL);

	// Playwright keeps its own session on the page, so ask through the extension's session.
	const debuggerAttached = () =>
		worker.evaluate(async (host) => {
			const targets = await chrome.debugger.getTargets();
			const target = targets.find((candidate) => candidate.url?.startsWith(host));
			if (!target?.tabId) return false;
			return chrome.debugger
				.sendCommand({ tabId: target.tabId }, "Runtime.evaluate", { expression: "1" })
				.then(
					() => true,
					() => false,
				);
		}, HOST_URL);

	return {
		url: () => page.url(),
		clicks: () => page.evaluate(() => window.__clicks),
		overlayClicks: () => page.evaluate(() => window.__overlayClicks),
		async waitForClicks(count, timeout = 15_000) {
			await page.waitForFunction((expected) => window.__clicks.length >= expected, count, {
				timeout,
				polling: 100,
			});
			return page.evaluate(() => window.__clicks);
		},
		async clicksAfter(ms) {
			await page.waitForTimeout(ms);
			return page.evaluate(() => window.__clicks);
		},
		async waitForAttach(timeout = 5000) {
			const deadline = Date.now() + timeout;
			while (!(await debuggerAttached())) {
				if (Date.now() > deadline) throw new Error("The debugger was never attached");
				await page.waitForTimeout(100);
			}
		},
		async waitForDetach(timeout = 15_000) {
			const started = Date.now();
			while (await debuggerAttached()) {
				if (Date.now() - started > timeout) throw new Error("The debugger is still attached");
				await page.waitForTimeout(200);
			}
			return Date.now() - started;
		},
	};
}

function assertCheckboxClick(click) {
	const { left, top, size } = CHECKBOX;
	assert.equal(click.trusted, true);
	assert.ok(click.x >= left && click.x < left + size, `x=${click.x}`);
	assert.ok(click.y >= top && click.y < top + size, `y=${click.y}`);
}

async function assertSolvedOnce(scenario) {
	const [click] = await scenario.waitForClicks(1);
	assertCheckboxClick(click);
	await scenario.waitForDetach();
	assert.equal((await scenario.clicks()).length, 1);
}

describe("solver against a local Turnstile mock", { concurrency: 3 }, () => {
	it("clicks a widget embedded in the page and lets go", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t));
	});

	it("scrolls to a widget below the fold", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t, { spacer: 1600 }));
	});

	for (const depth of [1, 2]) {
		it(`clicks a widget nested ${depth} cross-origin frame(s) deep`, TEST, async (t) => {
			await assertSolvedOnce(await openScenario(t, { depth }));
		});

		it(`scrolls through ${depth} cross-origin frame(s) to reach the widget`, TEST, async (t) => {
			await assertSolvedOnce(await openScenario(t, { depth, spacer: 1600, innerSpacer: 400 }));
		});
	}

	for (const shadowMode of ["open", "closed"]) {
		it(`finds a widget in ${shadowMode} shadow DOM`, TEST, async (t) => {
			await assertSolvedOnce(await openScenario(t, { shadowMode }));
		});
	}

	it("finds a widget in closed shadow DOM of a cross-origin frame", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t, { depth: 1, shadowMode: "closed" }));
	});

	it("keeps going when the page changes its URL right away", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t, { changeUrl: true }));
	});

	it("starts over on the next page after a full navigation", TEST, async (t) => {
		const scenario = await openScenario(t, { navigate: true });
		await assertSolvedOnce(scenario);
		assert.equal(new URL(scenario.url()).pathname, "/next");
	});

	it("clicks again when the first click does not complete the challenge", TEST, async (t) => {
		const scenario = await openScenario(t, { clicksToSolve: 2 });
		const [first, second] = await scenario.waitForClicks(2, 20_000);
		assertCheckboxClick(first);
		assertCheckboxClick(second);
		assert.ok(second.at - first.at >= 5000, `gap=${second.at - first.at}ms`);
	});

	it("gives up after two unanswered clicks", TEST, async (t) => {
		const scenario = await openScenario(t, { clicksToSolve: Infinity });
		await scenario.waitForClicks(2, 20_000);
		await scenario.waitForDetach();
		assert.equal((await scenario.clicks()).length, 2);
	});

	it("leaves the widget alone when the challenge ends first", TEST, async (t) => {
		const scenario = await openScenario(t, { endEarly: true });
		assert.deepEqual(await scenario.clicksAfter(4000), []);
	});

	it("lets go soon after the widget is removed from the page", TEST, async (t) => {
		const scenario = await openScenario(t, { removeWidget: true });
		await scenario.waitForAttach();
		const elapsed = await scenario.waitForDetach(15_000);
		assert.ok(elapsed < 10_000, `detached after ${elapsed}ms`);
		assert.deepEqual(await scenario.clicks(), []);
	});

	it("never clicks an overlay that covers the widget", TEST, async (t) => {
		const scenario = await openScenario(t, { overlayMs: 3000 });
		const [click] = await scenario.waitForClicks(1);
		assertCheckboxClick(click);
		assert.equal(await scenario.overlayClicks(), 0);
	});

	it("maps clicks through a scrolling frame with visible scrollbars", TEST, async (t) => {
		const scenario = await openScenario(t, {
			showScrollbars: true,
			depth: 1,
			embedWidth: 1000,
			widgetOffset: 600,
			innerTail: 1200,
		});
		await assertSolvedOnce(scenario);
	});

	it("clicks a wide flexible widget", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t, { widgetWidth: 800 }));
	});

	for (const wrapper of ["transform:scale(0.7);transform-origin:0 0", "zoom:0.7"]) {
		it(`clicks a widget scaled with ${wrapper.split(":")[0]}`, TEST, async (t) => {
			await assertSolvedOnce(await openScenario(t, { widgetWrapper: wrapper }));
		});
	}

	it("clicks a widget inside a zoomed cross-origin frame", TEST, async (t) => {
		await assertSolvedOnce(await openScenario(t, { depth: 1, embedWrapper: "zoom:1.5" }));
	});
});
