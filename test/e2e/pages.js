export const HOST_URL = "https://host.test/";
export const WIDGET_ID = "e2e-widget";
export const CHECKBOX = { left: 16, top: 20, size: 28 };

const CHALLENGE_URL = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/e2e";

function challengeFrame(layout) {
	const frame = `<iframe id="cf-chl-widget-${WIDGET_ID}" src="${CHALLENGE_URL}"
		style="width:${layout.widgetWidth}px;height:65px;border:0;margin-left:${layout.widgetOffset}px"></iframe>`;
	if (!layout.widgetWrapper) return frame;
	return `<div style="${layout.widgetWrapper}">${frame}</div>`;
}

function mount(html, shadowMode) {
	if (!shadowMode) return html;
	return `<div></div>
	<script>
		document.currentScript.previousElementSibling
			.attachShadow({ mode: "${shadowMode}" })
			.innerHTML = ${JSON.stringify(html)};
	</script>`;
}

function frameAt(level, layout) {
	if (level === layout.depth) return mount(challengeFrame(layout), layout.shadowMode);
	const width = layout.embedWidth ?? 480 - level * 60;
	const height = 280 - level * 80;
	const frame = `<iframe src="https://embed${level + 1}.test/"
		style="width:${width}px;height:${height}px;border:3px solid #999"></iframe>`;
	if (level > 0 || !layout.embedWrapper) return frame;
	return `<div style="${layout.embedWrapper}">${frame}</div>`;
}

function hostPage(layout) {
	return `<!doctype html>
<body style="margin:40px;font:16px sans-serif">
	<h1>Host page</h1>
	<p style="height:${layout.spacer}px">Content above the widget</p>
	${frameAt(0, layout)}
	<p style="height:800px">Content below the widget</p>
	<script>
		window.__clicks = [];
		window.__overlayClicks = 0;
		addEventListener("message", ({ data }) => {
			if (data?.source === "e2e-report") window.__clicks.push(data.click);
			if (data?.event !== "interactiveBegin" || location.pathname !== "/") return;
			if (${layout.changeUrl}) {
				history.pushState({}, "", "/step-2");
				location.hash = "done";
			}
			if (${layout.navigate}) setTimeout(() => location.assign("/next"), 50);
			if (${layout.removeWidget}) {
				document.querySelector("iframe[id^='cf-chl-widget-']").remove();
			}
		});
		if (${layout.overlayMs} > 0) {
			const overlay = document.createElement("div");
			overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1";
			overlay.addEventListener("mousedown", () => (window.__overlayClicks += 1));
			document.body.append(overlay);
			setTimeout(() => overlay.remove(), ${layout.overlayMs});
		}
	</script>
</body>`;
}

function embedPage(level, layout) {
	return `<!doctype html>
<body style="margin:20px;background:#eef;font:14px sans-serif">
	<p style="height:${layout.innerSpacer}px">Cross-origin embed ${level}</p>
	${frameAt(level, layout)}
	<p style="height:${layout.innerTail}px"></p>
</body>`;
}

function widgetPage({ clicksToSolve, endEarly }) {
	const { left, top, size } = CHECKBOX;
	return `<!doctype html>
<body style="margin:0;font:14px sans-serif">
	<div style="position:absolute;inset:0;background:#fafafa;border:1px solid #ddd">
		<div style="position:absolute;left:${left}px;top:${top}px;width:${size}px;height:${size}px;
			box-sizing:border-box;border:2px solid #666"></div>
		<span style="position:absolute;left:56px;top:23px">Verify you are human</span>
	</div>
	<script>
		const post = (event) => parent.postMessage(
			{ source: "cloudflare-challenge", widgetId: ${JSON.stringify(WIDGET_ID)}, event },
			"*",
		);
		let clicks = 0;
		addEventListener("click", (event) => {
			clicks += 1;
			const click = { trusted: event.isTrusted, x: event.clientX, y: event.clientY, at: Date.now() };
			top.postMessage({ source: "e2e-report", click }, "*");
			if (clicks >= ${clicksToSolve}) post("complete");
		});
		setTimeout(() => {
			post("interactiveBegin");
			if (${endEarly}) setTimeout(() => post("interactiveEnd"), 30);
		}, 300);
	</script>
</body>`;
}

export function scenarioRoutes({
	depth = 0,
	spacer = 200,
	innerSpacer = 0,
	innerTail = 600,
	embedWidth = null,
	embedWrapper = null,
	widgetWidth = 300,
	widgetOffset = 0,
	widgetWrapper = null,
	shadowMode = null,
	changeUrl = false,
	navigate = false,
	removeWidget = false,
	overlayMs = 0,
	clicksToSolve = 1,
	endEarly = false,
}) {
	const layout = {
		depth,
		spacer,
		innerSpacer,
		innerTail,
		embedWidth,
		embedWrapper,
		widgetWidth,
		widgetOffset,
		widgetWrapper,
		shadowMode,
		changeUrl,
		navigate,
		removeWidget,
		overlayMs,
	};
	return {
		"https://host.test/**": hostPage(layout),
		"https://embed1.test/**": embedPage(1, layout),
		"https://embed2.test/**": embedPage(2, layout),
		"https://challenges.cloudflare.com/**": widgetPage({ clicksToSolve, endEarly }),
	};
}
