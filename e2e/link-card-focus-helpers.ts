import { expect, type BrowserContext, type Page } from "@playwright/test";
import { waitForEditor, waitForHydration } from "./helpers";
import { FRAME_HOSTS } from "./link-card-helpers";

/**
 * Stand-ins for a provider's embed page that deal with the keyboard (#2338). Like the other card specs,
 * no test touches the network: a card's frame is answered here, a person's avatar image by a local pixel,
 * and every other request that leaves the app is refused and written down.
 *
 * - The page that takes focus calls `window.focus()` and focuses a field of its own every so many
 *   milliseconds, with no click anywhere. No sandbox token forbids that.
 * - The quiet page does nothing by itself, like a real player. A test can still make it take focus once,
 *   at a moment the test chooses (`takeFocusOnce`).
 * Both count the keys and clicks they receive and show the counts, so a test can read them through the
 * frame. Each key is also sent to the frame's own site, as a page that wants the keys would do, and the
 * test writes those down: they are still known after the frame is gone.
 */
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const standIn = (grabEveryMs: number) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stand-in embed page${grabEveryMs ? " that takes focus" : ""}</title></head>
<body style="margin:0;font:14px sans-serif;background:#fff;color:#111">
<main>
<p id="address" style="margin:8px;overflow-wrap:anywhere"></p>
<input id="field" aria-label="Field in the frame" style="margin:8px;width:60%">
<button id="play" type="button" style="display:block;margin:8px;width:60%;height:64px">Play</button>
<p id="counts" style="margin:8px"></p>
</main>
<script>
document.getElementById("address").textContent = location.href;
var counts = { keys: 0, text: "", clicks: 0, grabs: 0, ticksWithFocus: 0, beforeinputs: 0, inputs: 0, compositions: 0, pastes: 0 };
function show() { document.getElementById("counts").textContent = JSON.stringify(counts); }
function report(kind, data, inputType) {
  try {
    fetch("/__input-event?kind=" + encodeURIComponent(kind) + "&data=" + encodeURIComponent(data || "") + "&inputType=" + encodeURIComponent(inputType || ""), {
      keepalive: true
    }).catch(function () {});
  } catch (error) {}
}
document.addEventListener("keydown", function (event) {
  counts.keys++;
  if (event.key.length === 1) counts.text += event.key;
  show();
  try { fetch("/__key?k=" + encodeURIComponent(event.key), { keepalive: true }).catch(function () {}); } catch (error) {}
}, true);
document.addEventListener("beforeinput", function (event) {
  counts.beforeinputs++;
  report("beforeinput", event.data, event.inputType);
  show();
}, true);
document.addEventListener("input", function (event) {
  counts.inputs++;
  report("input", event.data, event.inputType);
  show();
}, true);
for (const kind of ["compositionstart", "compositionupdate", "compositionend"]) {
  document.addEventListener(kind, function (event) {
    counts.compositions++;
    report(kind, event.data, "");
    show();
  }, true);
}
document.addEventListener("paste", function (event) {
  counts.pastes++;
  report("paste", event.clipboardData ? event.clipboardData.getData("text/plain") : "", "");
  show();
}, true);
document.addEventListener("click", function () { counts.clicks++; show(); }, true);
window.grab = function () {
  counts.grabs++;
  try { fetch("/__grab?frame=" + encodeURIComponent(location.href), { keepalive: true }).catch(function () {}); } catch (error) {}
  try { window.focus(); document.getElementById("field").focus(); } catch (error) {}
  show();
};
${grabEveryMs ? `setInterval(window.grab, ${grabEveryMs});` : ""}
setInterval(function () { if (document.hasFocus()) counts.ticksWithFocus++; show(); }, 50);
show();
</script>
</body>
</html>`;

export interface FocusSites {
  /** Addresses of the card frames the browser asked for, in order (a frame that is loaded again is listed again). */
  frames: string[];
  /** The keys the stand-in pages received, in order. */
  keys: string[];
  /** Every provider-initiated focus attempt, including attempts before a quarantine reload. */
  grabs: string[];
  /** beforeinput, input, composition, and paste payloads received by any stand-in frame. */
  inputEvents: Array<{ kind: string; data: string; inputType: string }>;
  /** Every other request that tried to leave the app. Must stay empty. */
  refused: string[];
}

export interface FrameCounts {
  keys: number;
  text: string;
  clicks: number;
  grabs: number;
  ticksWithFocus: number;
  beforeinputs: number;
  inputs: number;
  compositions: number;
  pastes: number;
}

/** `grabEveryMs` says, per frame address, how often that frame's page takes the keyboard by itself (0: never). */
export async function standInWithKeyboard(context: BrowserContext, baseURL: string, grabEveryMs: (frameUrl: string) => number = () => 0): Promise<FocusSites> {
  const origin = new URL(baseURL).origin;
  const sites: FocusSites = { frames: [], keys: [], grabs: [], inputEvents: [], refused: [] };
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin,
    (route) => {
      const request = route.request();
      const url = request.url();
      if (url.startsWith("https://avatars.githubusercontent.com/")) return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      if (request.isNavigationRequest() && request.frame().parentFrame() !== null && FRAME_HOSTS.some((host) => url.startsWith(`${host}/`))) {
        sites.frames.push(url);
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: standIn(grabEveryMs(url)) });
      }
      const sent = new URL(url);
      if (sent.pathname === "/__key" && FRAME_HOSTS.includes(sent.origin)) {
        sites.keys.push(sent.searchParams.get("k") ?? "");
        return route.fulfill({ status: 204, body: "" });
      }
      if (sent.pathname === "/__grab" && FRAME_HOSTS.includes(sent.origin)) {
        sites.grabs.push(sent.searchParams.get("frame") ?? "");
        return route.fulfill({ status: 204, body: "" });
      }
      if (sent.pathname === "/__input-event" && FRAME_HOSTS.includes(sent.origin)) {
        sites.inputEvents.push({
          kind: sent.searchParams.get("kind") ?? "",
          data: sent.searchParams.get("data") ?? "",
          inputType: sent.searchParams.get("inputType") ?? "",
        });
        return route.fulfill({ status: 204, body: "" });
      }
      sites.refused.push(url);
      return route.abort("blockedbyclient");
    },
  );
  return sites;
}

/** What the stand-in in the frame with this address has counted so far. */
export async function frameCounts(page: Page, scope: string, frameUrl: string): Promise<FrameCounts> {
  const text = await page.frameLocator(`${scope} iframe[src="${frameUrl}"]`).locator("#counts").textContent({ timeout: 15_000 });
  return JSON.parse(text ?? "{}") as FrameCounts;
}

/** The stand-in in this frame takes the keyboard now, by its own script: nobody clicked or pressed anything. */
export async function takeFocusOnce(page: Page, scope: string, frameUrl: string) {
  try {
    await page.frameLocator(`${scope} iframe[src="${frameUrl}"]`).locator("body").evaluate(() => (window as Window & { grab?: () => void }).grab?.());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    // The security response deliberately destroys this execution context by detaching the frame.
    if (!lower.includes("execution context was destroyed") && !lower.includes("frame was detached")) throw error;
  }
}

/** Which part of the page has the keyboard: the preview, the Markdown pane, a card's frame, or something else. */
export const keyboardPlace = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active) return "nothing";
    if (active.tagName === "IFRAME") return `frame ${active.getAttribute("src")}`;
    if (active.hasAttribute("data-card-cover")) return "cover";
    if (active.closest(".md-rich")) return active.classList.contains("md-rich") ? "preview" : `preview: ${active.tagName.toLowerCase()}`;
    if (active.closest(".cm-editor")) return "markdown";
    return active.getAttribute("data-testid") ?? active.tagName.toLowerCase();
  });

/**
 * Open a document the way people mostly do: a click on its card on the dashboard, which loads no new page.
 * (The same helper is in e2e/link-card-helpers.ts once the setting step is merged; this copy goes then.)
 */
export async function openByDashboardClick(page: Page, id: string) {
  await page.goto("/");
  await waitForHydration(page);
  await page.evaluate(() => {
    (window as Window & { __sameLoad?: boolean }).__sameLoad = true;
  });
  await page.locator(`a[href="/d/${id}"]`).first().click();
  await page.waitForURL(new RegExp(`/d/${id}$`));
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  expect(await page.evaluate(() => (window as Window & { __sameLoad?: boolean }).__sameLoad === true), "the document was reached without a page load").toBe(true);
}
