# Cloudflare Turnstile Solver

A Chrome extension that clicks the checkbox of interactive Cloudflare Turnstile widgets.

## How it works

1. `content/relay.js` listens for `postMessage` events from Turnstile iframes and tells the service worker when a widget asks for interaction and when it is done. When the page goes away, it ends the widgets that are still open.
2. The service worker attaches `chrome.debugger` to the tab, finds the widget iframe (including inside cross-origin frames), scrolls it into view and maps the checkbox position to page coordinates.
3. The pointer moves along a curved path and clicks with input events dispatched through the debugger. The target is checked again right before the press.
4. If the widget does not finish, the extension clicks once more after a pause. Each time a widget asks for interaction it gets up to two clicks within 30 seconds. A widget that disappears from the page is dropped after 5 seconds, and the debugger is detached as soon as no widgets are pending.

## Install

1. Download or clone the repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder.

Requires Chrome or another Chromium-based browser, version 128 or newer.

While a widget is being handled, Chrome shows a banner saying that the extension started debugging the browser. Every extension with the `debugger` permission triggers it. If you press **Cancel** on the banner, the extension leaves that tab alone until the tab is closed.

While the debugger is attached, the extension emulates focus so that clicks also reach background tabs. A background page therefore reports itself visible for that time.

## Limitations

The extension finds and clicks the checkbox, including on full-page challenges, inside shadow DOM and inside nested cross-origin frames. Whether Cloudflare accepts the result is decided by its own checks of the browser and the network. Headless or automated browsers are usually rejected after the click.

Chrome does not let an extension debug a page that contains a frame of another extension, such as the inline menu of some password managers. While such a frame is on the page, the widget is not handled; the extension tries again the next time the widget asks for interaction.

## Development

```sh
npm install
npm test            # unit tests
npm run test:e2e    # end-to-end tests against a local Turnstile mock
npm run lint
npm run format
npm run check       # lint, formatting and unit tests
```

The end-to-end suite loads the extension into Chromium through Playwright. A mock widget is served under the Cloudflare challenge origin through request interception, so no request leaves the machine. Install a browser once with `npx playwright install chromium`, or set `CHROMIUM_PATH` to an existing Chromium binary.

### Project layout

```
extension/
  manifest.json
  shared.js            message protocol shared by the content scripts and the service worker
  content/
    relay.js           forwards Turnstile events to the service worker
    screen-coords.js   fills in screen coordinates of pointer events in challenge frames
  background/
    index.js           entry point, routes browser events to tabs
    tab.js             per-tab worker: debugger lifecycle and job scheduling
    declined.js        tabs where the user cancelled debugging
    job.js             retry and timeout policy for a single widget
    solver.js          one attempt: locate, scroll, plan and click
    connection.js      debugger sessions of the tab and its out-of-process frames
    cdp.js             CDP session wrapper, timeouts and error classification
    locator.js         finds the widget iframe
    targeting.js       picks the click point and maps it to page coordinates
    mouse.js           pointer path and click
    geometry.js, random.js, timing.js, log.js, protocol.js
test/
  *.test.js            unit tests
  e2e/                 end-to-end tests
```

## Disclaimer

Use the extension only where automating the challenge is allowed. You are responsible for following the terms of service of the sites you visit and of Cloudflare.
