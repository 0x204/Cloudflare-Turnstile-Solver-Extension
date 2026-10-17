import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { CHECKBOX, HOST_URL, scenarioRoutes } from "./pages.js";

const EXTENSION_PATH = fileURLToPath(new URL("../../extension", import.meta.url));

async function openScenario(t, options = {}) {
	const profile = await mkdtemp(path.join(tmpdir(), "turnstile-e2e-"));
	const context = await chromium.launchPersistentContext(profile, {
		channel: "chromium",
		executablePath: process.env.CHROMIUM_PATH,
		headless: true,
		viewport: { width: 1280, height: 720 },
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

	if (context.serviceWorkers().length === 0) await context.waitForEvent("serviceworker");
	const page = await context.newPage();
	await page.goto(HOST_URL);

	return {
		url: () => page.url(),
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
	};
}

function assertCheckboxClick(click) {
	const { left, top, size } = CHECKBOX;
	assert.equal(click.trusted, true);
	assert.ok(click.x >= left && click.x < left + size, `x=${click.x}`);
	assert.ok(click.y >= top && click.y < top + size, `y=${click.y}`);
}

describe("solver against a local Turnstile mock", { concurrency: 3, timeout: 60_000 }, () => {
	it("clicks a widget embedded in the page", async (t) => {
		const scenario = await openScenario(t);
		const [click] = await scenario.waitForClicks(1);
		assertCheckboxClick(click);
	});

	it("scrolls to a widget below the fold", async (t) => {
		const scenario = await openScenario(t, { spacer: 1600 });
		const [click] = await scenario.waitForClicks(1);
		assertCheckboxClick(click);
	});

	for (const depth of [1, 2]) {
		it(`clicks a widget nested ${depth} cross-origin frame(s) deep`, async (t) => {
			const scenario = await openScenario(t, { depth });
			const [click] = await scenario.waitForClicks(1);
			assertCheckboxClick(click);
		});

		it(`scrolls through ${depth} cross-origin frame(s) to reach the widget`, async (t) => {
			const scenario = await openScenario(t, { depth, spacer: 1600, innerSpacer: 400 });
			const [click] = await scenario.waitForClicks(1);
			assertCheckboxClick(click);
		});
	}

	it("keeps going when the page changes its URL without reloading", async (t) => {
		const scenario = await openScenario(t, { changeUrl: true });
		const [click] = await scenario.waitForClicks(1);
		assertCheckboxClick(click);
	});

	it("starts over on the next page after a full navigation", async (t) => {
		const scenario = await openScenario(t, { navigate: true });
		const [click] = await scenario.waitForClicks(1);
		assertCheckboxClick(click);
		assert.equal(new URL(scenario.url()).pathname, "/next");
	});

	it("clicks again when the first click does not complete the challenge", async (t) => {
		const scenario = await openScenario(t, { clicksToSolve: 2 });
		const [first, second] = await scenario.waitForClicks(2, 20_000);
		assertCheckboxClick(first);
		assertCheckboxClick(second);
		assert.ok(second.at - first.at >= 5000, `gap=${second.at - first.at}ms`);
	});

	it("gives up after two unanswered clicks", async (t) => {
		const scenario = await openScenario(t, { clicksToSolve: Infinity });
		await scenario.waitForClicks(2, 20_000);
		assert.equal((await scenario.clicksAfter(8000)).length, 2);
	});

	it("leaves the widget alone when the challenge ends first", async (t) => {
		const scenario = await openScenario(t, { endEarly: true });
		assert.deepEqual(await scenario.clicksAfter(4000), []);
	});
});
