import { expect, type BrowserContext, type Page } from "@playwright/test";
import { waitForEditor, waitForHydration } from "./helpers";
import { CARD_FRAME_HOSTS } from "../src/editor/markdown/link-cards";

/**
 * Shared by the link card specs (#2317). No test touches the network: every request that leaves the app
 * is handled in the browser by `standInForOtherSites`.
 *
 * - A card's frame (a navigation to one of the two frame hosts) is answered by a local stand-in page
 *   and written down in `frames`.
 * - A video frame's reachability check (HEAD) gets a local empty response.
 * - A person's avatar image from GitHub, the one request the app has always made to another site, is
 *   answered with a local 1 pixel image.
 * - Everything else is refused and written down in `refused`, which must stay empty.
 */
export const TWEET = "https://x.com/jack/status/20";
export const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
export const TWEET_FRAME = "https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true";
export const VIDEO_FRAME = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
export const FRAME_HOSTS = ["https://www.youtube-nocookie.com", "https://platform.twitter.com"];
export const CARD_FRAME_SOURCES = `frame-src ${CARD_FRAME_HOSTS.join(" ")}; media-src 'self' blob:`;
export const SANDBOX = "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * The stand-in for a provider's embed page. It is a hostile page on purpose: it tries what a frame must
 * not be able to do and writes down, in itself, how each attempt ended. A test reads that through the
 * frame. It also sends the page a message, which the page must ignore.
 */
const STAND_IN = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stand-in embed page</title></head>
<body style="margin:0;font:14px sans-serif;background:#fff;color:#111">
<main>
<h1 style="font-size:16px;margin:8px">Stand-in embed page</h1>
<p id="address" style="margin:8px;overflow-wrap:anywhere"></p>
<p id="referrer" style="margin:8px"></p>
<p id="tried" style="margin:8px"></p>
</main>
<script>
document.getElementById("address").textContent = location.href;
document.getElementById("referrer").textContent = "referrer: " + document.referrer;
var tried = {};
try { tried.readTop = String(window.top.location.href).length > 0 ? "read" : "empty"; } catch (e) { tried.readTop = "blocked"; }
try { tried.readParentDocument = window.parent.document.body ? "read" : "empty"; } catch (e) { tried.readParentDocument = "blocked"; }
try { window.top.location = "https://evil.example/moved-the-page"; tried.moveTop = "not thrown"; } catch (e) { tried.moveTop = "blocked"; }
try { window.parent.postMessage({ type: "markdoc", action: "show-as-text", html: "<img src=x onerror=alert(1)>" }, "*"); tried.message = "sent"; } catch (e) { tried.message = "blocked"; }
try { tried.dialog = window.alert("from the frame") === undefined ? "returned" : "other"; } catch (e) { tried.dialog = "blocked"; }
tried.origin = self.origin;
document.getElementById("tried").textContent = JSON.stringify(tried);
</script>
</body>
</html>`;

export interface OtherSites {
  /** Addresses of the card frames the browser asked for, in order. */
  frames: string[];
  /** Every other request that tried to leave the app. Must stay empty. */
  refused: string[];
}

/** `local` names other origins of this machine that the test itself serves (the Copilot canvas's loopback page). */
export async function standInForOtherSites(context: BrowserContext, baseURL: string, local: string[] = []): Promise<OtherSites> {
  const origin = new URL(baseURL).origin;
  const sites: OtherSites = { frames: [], refused: [] };
  await context.route(
    (url) => (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin && !local.includes(url.origin),
    (route) => {
      const request = route.request();
      const url = request.url();
      if (url.startsWith("https://avatars.githubusercontent.com/")) return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
      if (request.method() === "HEAD" && FRAME_HOSTS.some((host) => url.startsWith(`${host}/`))) return route.fulfill({ status: 200, body: "" });
      if (request.isNavigationRequest() && request.frame().parentFrame() !== null && FRAME_HOSTS.some((host) => url.startsWith(`${host}/`))) {
        sites.frames.push(url);
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: STAND_IN });
      }
      sites.refused.push(url);
      return route.abort("blockedbyclient");
    },
  );
  return sites;
}

/** What the stand-in page wrote down about its attempts, read through the frame. */
export async function frameAttempts(page: Page, frameSelector: string): Promise<Record<string, string>> {
  const text = await page.frameLocator(frameSelector).locator("#tried").textContent({ timeout: 15_000 });
  return JSON.parse(text ?? "{}") as Record<string, string>;
}

/** Every frame element of the page with what limits it. */
export const frameElements = (page: Page, scope = "body") =>
  page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(`${selector} iframe`), (frame) => ({
        src: frame.getAttribute("src"),
        sandbox: frame.getAttribute("sandbox"),
        allow: frame.getAttribute("allow"),
        referrerpolicy: frame.getAttribute("referrerpolicy"),
        loading: frame.getAttribute("loading"),
        title: frame.getAttribute("title"),
      })),
    scope,
  );

/**
 * Nothing from another site is in the page except card frames: no script with an address on another
 * site, no frame that is not one of `expected` (in order), no style sheet or plug-in from elsewhere.
 */
export async function expectOnlyCardFrames(page: Page, expected: string[]) {
  await expect.poll(async () => (await frameElements(page)).map((frame) => frame.src), { timeout: 15_000 }).toEqual(expected);
  await expect(page.locator(".md-link-card-frame[data-checking]")).toHaveCount(0);
  for (const frame of await frameElements(page)) {
    expect(frame.sandbox, frame.src!).toBe(SANDBOX);
    expect(frame.allow, frame.src!).toBe("fullscreen; picture-in-picture; encrypted-media");
    expect(frame.referrerpolicy, frame.src!).toBe("strict-origin-when-cross-origin");
    expect(frame.loading, frame.src!).toBe("lazy");
    expect(frame.title, frame.src!).toMatch(/^(Post on X|YouTube video): /);
  }
  const foreign = await page.evaluate(() => {
    const here = location.origin;
    const elsewhere = (value: string | null) => !!value && /^(https?:)?\/\//i.test(value) && new URL(value, location.href).origin !== here;
    return {
      scripts: Array.from(document.scripts, (script) => script.getAttribute("src")).filter(elsewhere),
      // (An image preload for a person's avatar is the one link to another site the app has always had.)
      others: Array.from(document.querySelectorAll('object, embed, frame, [srcdoc], link[rel~="stylesheet"], link[rel~="modulepreload"], link[as="script"]'), (el) => el.getAttribute("href") ?? el.getAttribute("data") ?? el.tagName).filter(
        (value) => elsewhere(value) || /^(OBJECT|EMBED|FRAME|IFRAME)$/.test(value),
      ),
    };
  });
  expect(foreign).toEqual({ scripts: [], others: [] });
}

/** Paste plain text into the preview, as the clipboard would hand it over. */
export async function pasteInRich(page: Page, text: string) {
  await page.evaluate((value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    document.querySelector(".md-rich")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/**
 * Open a document the way people mostly do: a click on its card on the dashboard. The app then changes
 * the page without loading a new one, so the document keeps the response headers of the dashboard. A
 * test that only ever uses `page.goto` cannot see what that does to a card's frame.
 */
export async function openFromDashboard(page: Page, id: string) {
  await page.goto("/");
  await waitForHydration(page);
  await page.evaluate(() => {
    (window as Window & { __sameLoad?: boolean }).__sameLoad = true;
  });
  await page.locator(`[data-testid="document-card"][href="/d/${id}"]`).click();
  await page.waitForURL(new RegExp(`/d/${id}$`));
  await waitForEditor(page);
  await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
  // Still the page that was loaded for the dashboard: no new page load happened.
  expect(await page.evaluate(() => (window as Window & { __sameLoad?: boolean }).__sameLoad === true), "the document was reached without a page load").toBe(true);
}

/** The stand-in page inside a card's frame really loaded: it shows its own address. */
export async function expectFrameLoaded(page: Page, scope: string, frameUrl: string) {
  await expect(page.frameLocator(`${scope} iframe[src="${frameUrl}"]`).locator("#address")).toHaveText(frameUrl, { timeout: 15_000 });
}
