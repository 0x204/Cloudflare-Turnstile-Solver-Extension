import { tolerate } from "./cdp.js";
import { Outcome } from "./job.js";
import { locateWidget } from "./locator.js";
import { click } from "./mouse.js";
import { planClick } from "./targeting.js";

export async function solveWidget(connection, job, signal) {
	const watch = connection.watchFrames();
	const scope = AbortSignal.any([signal, watch.signal]);

	try {
		const located = await locateWidget(connection, job.widgetId);
		if (!located) return Outcome.NOT_FOUND;
		scope.throwIfAborted();

		const scroll = located.session.send("DOM.scrollIntoViewIfNeeded", {
			nodeId: located.frame.nodeId,
		});
		// Fails for a widget that has no layout box yet.
		if (!(await tolerate(scroll, null))) return Outcome.MISSED;
		scope.throwIfAborted();

		const plan = await planClick(connection, located, job.misses, watch);
		if (!plan) return Outcome.MISSED;

		const clicked = await click(connection.root, plan.target, {
			signal: scope,
			confirm: plan.confirm,
		});
		return clicked ? Outcome.CLICKED : Outcome.MISSED;
	} catch (error) {
		if (watch.signal.aborted && error === watch.signal.reason) return Outcome.MISSED;
		throw error;
	} finally {
		watch.dispose();
	}
}
