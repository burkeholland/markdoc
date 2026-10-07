import { test, expect } from "./fixtures";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import { GIF, JPEG, PNG, SVG, WEBP } from "../src/server/assets.fixtures";
import { codeText, createDocument, focusRichEnd, mintToken, openDocument, signIn, uniqueLogin } from "./helpers";

/**
 * #2287: nothing in the app uses Next's image optimisation endpoint, so it is switched off, and an
 * uploaded file must be the image type it is sent as. This spec runs on the dev server and, with
 * PROD_BASE_URL, on a production build (`PROD_BASE_URL=http://localhost:<port> npx playwright test
 * e2e/image-endpoint-closed.spec.ts`).
 *
 * What a browser test can see of "the endpoint did nothing" is the answer itself: 404 with the app's
 * not-found page, never an image and never the optimiser's own headers. (A 400 with a `"url" parameter`
 * text would mean the optimiser is on again and only its allow-lists refused the request.)
 */
const bytes = (data: Uint8Array) => Buffer.from(data);
const MISMATCH = "This file was sent as PNG but its content is JPEG. Give it the matching file extension (.jpg) and upload it again";
const NOT_AN_IMAGE = "This file is not a PNG image: its content does not match its type. Save it again as PNG, JPEG, GIF, WebP or SVG and upload that file";

const optimise = (url: string, w = 640, q = 75) => `/_next/image?url=${encodeURIComponent(url)}&w=${w}&q=${q}`;

/** The endpoint's answer to anything: the not-found page, no image, none of the optimiser's headers. */
async function expectClosed(res: APIResponse, label: string) {
  const headers = res.headers();
  expect(res.status(), `${label}: status`).toBe(404);
  expect(headers["content-type"] ?? "", `${label}: content-type`).not.toMatch(/^image\//);
  expect(headers["content-disposition"], `${label}: content-disposition`).toBeUndefined();
  expect(headers["x-nextjs-cache"] ?? "", `${label}: optimiser cache header`).not.toMatch(/^(MISS|STALE)$/);
  const body = await res.body();
  if (body.length > 0) {
    const text = body.subarray(0, 20_000).toString("latin1");
    expect(text, `${label}: body`).not.toContain("parameter");
    expect(text, `${label}: body`).toMatch(/Page not found|NEXT_HTTP_ERROR_FALLBACK;404|not-found/);
  }
}

async function upload(request: APIRequestContext, documentId: string, name: string, mime: string, data: Uint8Array) {
  const res = await request.post(`/api/documents/${documentId}/assets?name=${encodeURIComponent(name)}`, { headers: { "Content-Type": mime }, data: bytes(data) });
  expect(res.status(), `upload ${name}`).toBe(201);
  return (await res.json()) as { id: string; url: string; mime: string };
}

/**
 * Paste or drop one file on a pane with synthetic events: the same editor handlers run as for a real gesture.
 * A paste lands at the selection; a drop lands at the start of the line of the pane that reads `dropOn`.
 */
async function giveFile(page: Page, how: "paste" | "drop", selector: string, file: { name: string; type: string; data: Uint8Array; dropOn?: string }) {
  await page.evaluate(
    ({ how, selector, name, type, data, dropOn }) => {
      const pane = document.querySelector(selector) as HTMLElement | null;
      if (!pane) throw new Error(`${selector} not found`);
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data)], name, { type }));
      if (how === "paste") {
        pane.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        return;
      }
      const line = Array.from(pane.querySelectorAll<HTMLElement>("*")).reverse().find((el) => el.textContent?.trim() === dropOn);
      if (!line) throw new Error(`no line "${dropOn}" in ${selector}`);
      const rect = line.getBoundingClientRect();
      const clientX = rect.left + 1;
      const clientY = rect.top + rect.height / 2;
      for (const event of ["dragenter", "dragover", "drop"] as const) {
        line.dispatchEvent(new DragEvent(event, { dataTransfer: transfer, bubbles: true, cancelable: true, clientX, clientY }));
      }
    },
    { how, selector, name: file.name, type: file.type, data: Array.from(file.data), dropOn: file.dropOn },
  );
}

/** The image is in the rich pane under its own `/api/assets/<id>` URL and the browser decoded it. */
async function expectShown(page: Page, scope: string, url: string) {
  const image = page.locator(`${scope} img[src="${url}"]`).first();
  await expect(image, `${url} in ${scope}`).toHaveCount(1);
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { message: `${url} decoded in ${scope}` }).toBe(true);
}

test.describe("image optimisation endpoint is closed (#2287)", () => {
  test("every request is the not-found page: local files, uploads, remote hosts, any method, size or format, signed in or out", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("img-closed"));
    const anonymous = await browser.newContext();
    const shared = await createDocument(owner.page, "Shared\n", "Shared pictures");
    const hidden = await createDocument(owner.page, "Private\n", "Private pictures");
    const sharedAsset = await upload(owner.page.request, shared, "shared.png", "image/png", PNG);
    const hiddenAsset = await upload(owner.page.request, hidden, "private.png", "image/png", PNG);
    expect((await owner.page.request.patch(`/api/documents/${shared}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    // The upload itself stays readable without a session: that is the door the endpoint used to walk through.
    expect((await anonymous.request.get(sharedAsset.url)).status()).toBe(200);

    const targets: [name: string, url: string][] = [
      ["a public PNG", "/brand/og.png"],
      ["a public SVG", "/icon.svg"],
      ["an upload of a link-shared document", sharedAsset.url],
      ["an upload of a private document", hiddenAsset.url],
      ["the avatar host", "https://avatars.githubusercontent.com/u/9919?s=80"],
      ["another host", "https://example.com/a.png"],
    ];
    const callers: [who: string, request: APIRequestContext][] = [
      ["signed out", anonymous.request],
      ["signed in", owner.page.request],
    ];
    let checked = 0;
    for (const [who, request] of callers) {
      for (const [name, url] of targets) {
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
          await expectClosed(await request.fetch(optimise(url), { method, maxRedirects: 0 }), `${method} ${name}, ${who}`);
          checked++;
        }
        for (const [w, q] of [[16, 75], [3840, 75], [640, 100], [640, 1]]) {
          await expectClosed(await request.get(optimise(url, w, q), { maxRedirects: 0 }), `w=${w} q=${q} ${name}, ${who}`);
          checked++;
        }
        for (const accept of ["image/avif,image/webp,*/*", "image/webp", "image/png"]) {
          await expectClosed(await request.get(optimise(url), { headers: { accept }, maxRedirects: 0 }), `Accept ${accept} ${name}, ${who}`);
          checked++;
        }
      }
      // No parameters, a repeated parameter, an absolute URL to this server: nothing is read, so nothing differs.
      const base = new URL(owner.page.url()).origin;
      for (const path of ["/_next/image", `${optimise(sharedAsset.url)}&url=%2Fbrand%2Fog.png`, optimise(`${base}${sharedAsset.url}`), optimise(`//localhost${sharedAsset.url}`)]) {
        await expectClosed(await request.get(path, { maxRedirects: 0 }), `${path}, ${who}`);
        checked++;
      }
    }
    expect(checked).toBe(2 * (6 * 14 + 4));
    await anonymous.close();
    await owner.context.close();
  });

  test("other spellings of the path never reach an image: 308 to the plain path (then 404), or 404", async ({ browser, baseURL }) => {
    const owner = await signIn(browser, uniqueLogin("img-doors"));
    const id = await createDocument(owner.page, "Doors\n", "Doors");
    const asset = await upload(owner.page.request, id, "door.png", "image/png", PNG);
    expect((await owner.page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    const anonymous = await browser.newContext();
    const request = anonymous.request;
    const query = `?url=${encodeURIComponent(asset.url)}&w=640&q=75`;

    // Next normalises these two to the plain path with a redirect; the redirect carries nothing and its target is closed.
    for (const path of ["/_next/image/", "//_next/image"]) {
      const redirect = await request.get(`${baseURL}${path}${query}`, { maxRedirects: 0 });
      expect(redirect.status(), `${path}: status`).toBe(308);
      expect(redirect.headers()["location"], `${path}: location`).toBe(`/_next/image${query}`);
      expect(redirect.headers()["content-type"] ?? "", `${path}: content-type`).not.toMatch(/^image\//);
      await expectClosed(await request.get(`${baseURL}${path}${query}`), `${path} followed`);
    }
    for (const path of ["/_NEXT/IMAGE", "/_next/Image", "/_next/%69mage", "/_next%2Fimage", "/%5Fnext/image", "/_next/image/x", "/_next/imagex", "/_next/image;x", "/_next/image%20", "/_next/image."]) {
      await expectClosed(await request.get(`${baseURL}${path}${query}`, { maxRedirects: 0 }), path);
    }
    await anonymous.close();
    await owner.context.close();
  });

  test("nothing needed it: uploads by button, paste and drop show in both panes and the reader; brand image, icon and social cards answer", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("img-works"));
    const { page } = owner;
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    const id = await createDocument(page, "Gallery\n\nRich drop line\n\nCode drop line\n\nLast line\n", "Gallery");
    await openDocument(page, id);

    // Button: the Insert image dialog.
    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    await page.getByTestId("tb-image").click();
    await page.getByTestId("image-file").setInputFiles({ name: "By button.png", mimeType: "image/png", buffer: bytes(PNG) });
    await expect(page.getByTestId("image-url")).toHaveValue(/^\/api\/assets\/[a-z0-9]+$/);
    const byButton = await page.getByTestId("image-url").inputValue();
    await page.getByTestId("image-submit").click();
    await expect.poll(() => codeText(page)).toContain(`![By button](${byButton})`);

    // Paste and drop, each pane once, each with a real file of another allowed type.
    const gestures: { how: "paste" | "drop"; pane: string; name: string; type: string; data: Uint8Array; dropOn?: string }[] = [
      { how: "paste", pane: ".md-rich", name: "pasted rich.jpg", type: "image/jpeg", data: JPEG },
      { how: "paste", pane: ".cm-content", name: "pasted code.gif", type: "image/gif", data: GIF },
      { how: "drop", pane: ".md-rich", name: "dropped rich.webp", type: "image/webp", data: WEBP, dropOn: "Rich drop line" },
      { how: "drop", pane: ".cm-content", name: "dropped code.svg", type: "image/svg+xml", data: SVG, dropOn: "Code drop line" },
    ];
    const urls = [byButton];
    for (const gesture of gestures) {
      if (gesture.pane === ".md-rich") await focusRichEnd(page);
      else {
        await page.locator(".cm-content").click();
        await page.keyboard.press("Control+End");
      }
      await giveFile(page, gesture.how, gesture.pane, gesture);
      const alt = gesture.name.replace(/\.[a-z]+$/, "");
      const pattern = new RegExp(`!\\[${alt}\\]\\((/api/assets/[a-z0-9]+)\\)`);
      await expect.poll(() => codeText(page), { message: `${gesture.how} on ${gesture.pane}` }).toMatch(pattern);
      urls.push(pattern.exec(await codeText(page))![1]);
    }
    await expect(page.getByTestId("image-upload-placeholder")).toHaveCount(0);
    expect(new Set(urls).size).toBe(5);
    for (const url of urls) await expectShown(page, ".md-rich", url);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    // Each upload is served under the type its bytes are.
    const served = await Promise.all(urls.map(async (url) => (await page.request.get(url)).headers()["content-type"]));
    expect(served).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

    // The reader view shows the same images by the same URLs, to a visitor without a session too.
    expect((await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } })).ok()).toBeTruthy();
    const visitor = await browser.newContext();
    const reader = await visitor.newPage();
    reader.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await reader.goto(`/p/${id}`);
    for (const url of urls) await expectShown(reader, "body", url);

    // Avatars are plain images from GitHub's own host; the brand image, the icon and both social cards answer.
    const avatars = await page.locator('img[src*="avatars.githubusercontent.com"]').evaluateAll((images) => images.map((image) => image.getAttribute("src") ?? ""));
    for (const src of avatars) expect(src).toMatch(/^https:\/\/avatars\.githubusercontent\.com\//);
    for (const [path, type] of [["/brand/og.png", "image/png"], ["/icon.svg", "image/svg+xml"], [`/d/${id}/opengraph-image`, "image/png"], [`/p/${id}/opengraph-image`, "image/png"]]) {
      const res = await visitor.request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-type"], path).toBe(type);
      expect((await res.body()).length, path).toBeGreaterThan(100);
    }
    // No page of this test asked the browser for an optimised image.
    expect(requested.length).toBeGreaterThan(10);
    expect(requested.filter((path) => path.startsWith("/_next/image"))).toEqual([]);
    await visitor.close();
    await owner.context.close();
  });

  test("an upload whose bytes are not its type is refused with a message, by button, paste, drop, import and API token; the document stays usable", async ({ browser }) => {
    const owner = await signIn(browser, uniqueLogin("img-refused"));
    const { page } = owner;
    const id = await createDocument(page, "Refusals\n\nCode drop line\n", "Refusals");
    await openDocument(page, id);
    const notAnImage = new TextEncoder().encode("meeting notes, renamed to .png by mistake");

    // Button: the dialog names the problem and keeps its URL field empty.
    await focusRichEnd(page);
    await page.getByTestId("tb-image").click();
    await page.getByTestId("image-file").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: bytes(JPEG) });
    await expect(page.getByTestId("image-upload-error")).toHaveText(MISMATCH);
    await expect(page.getByTestId("image-url")).toHaveValue("");
    // The same dialog takes the right file straight away.
    await page.getByTestId("image-file").setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: bytes(JPEG) });
    await expect(page.getByTestId("image-url")).toHaveValue(/^\/api\/assets\/[a-z0-9]+$/);
    await expect(page.getByTestId("image-upload-error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Insert image" })).toHaveCount(0);

    // Paste (rich pane) and drop (code pane): a toast with the reason, no placeholder left, no Markdown written.
    await focusRichEnd(page);
    await giveFile(page, "paste", ".md-rich", { name: "notes.png", type: "image/png", data: notAnImage });
    await expect(page.getByTestId("toast").filter({ hasText: `Image upload failed: ${NOT_AN_IMAGE}` })).toBeVisible();
    await expect(page.getByTestId("image-upload-placeholder")).toHaveCount(0);
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await giveFile(page, "drop", ".cm-content", { name: "photo.png", type: "image/png", data: JPEG, dropOn: "Code drop line" });
    await expect(page.getByTestId("toast").filter({ hasText: `Image upload failed: ${MISMATCH}` })).toBeVisible();
    expect(await codeText(page)).not.toContain("/api/assets/");

    // The document still takes typing and a real image.
    await focusRichEnd(page);
    await page.keyboard.type(" still editable");
    await expect.poll(() => codeText(page)).toContain("Code drop line still editable");
    await giveFile(page, "paste", ".md-rich", { name: "real.gif", type: "image/gif", data: GIF });
    await expect.poll(() => codeText(page)).toMatch(/!\[real\]\(\/api\/assets\/[a-z0-9]+\)/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });

    // API, as a script or an agent sends it: session and token get the same JSON error, and nothing is stored.
    const token = await mintToken(page, uniqueLogin("img-refused-agent"));
    const anonymous = await browser.newContext();
    try {
      const before = (await codeText(page)).length;
      const attempts: [label: string, res: APIResponse, error: string][] = [
        ["raw body, session", await page.request.post(`/api/documents/${id}/assets?name=a.png`, { headers: { "Content-Type": "image/png" }, data: bytes(JPEG) }), MISMATCH],
        ["multipart, session", await page.request.post(`/api/documents/${id}/assets`, { multipart: { file: { name: "a.png", mimeType: "image/png", buffer: bytes(JPEG) } } }), MISMATCH],
        ["raw body, token", await anonymous.request.post(`/api/documents/${id}/assets?name=a.png`, { headers: { "Content-Type": "image/png", Authorization: `Bearer ${token.token}` }, data: bytes(JPEG) }), MISMATCH],
        ["text as PNG, token", await anonymous.request.post(`/api/documents/${id}/assets?name=n.png`, { headers: { "Content-Type": "image/png", Authorization: `Bearer ${token.token}` }, data: Buffer.from(notAnImage) }), NOT_AN_IMAGE],
      ];
      for (const [label, res, error] of attempts) {
        expect(res.status(), label).toBe(415);
        expect(await res.json(), label).toEqual({ error });
      }
      const scripted = await anonymous.request.post(`/api/documents/${id}/assets?name=s.png`, {
        headers: { "Content-Type": "image/png", Authorization: `Bearer ${token.token}` },
        data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      });
      expect(scripted.status()).toBe(400);
      expect(await scripted.json()).toEqual({ error: "SVG images may not contain scripts or event handlers" });
      const ok = await anonymous.request.post(`/api/documents/${id}/assets?name=ok.webp`, { headers: { "Content-Type": "image/webp", Authorization: `Bearer ${token.token}` }, data: bytes(WEBP) });
      expect(ok.status()).toBe(201);
      expect((await codeText(page)).length).toBe(before);
    } finally {
      await token.revoke();
      await anonymous.close();
    }

    // Import: the documents are created, the refused image is named with the reason and its link is left as written.
    await page.goto("/");
    await expect(page.getByTestId("open-file")).toBeVisible();
    await page.getByTestId("import-file-input").setInputFiles([
      { name: "trip.md", mimeType: "text/markdown", buffer: Buffer.from("# Trip\n\n![Beach](beach.png)\n\n![Hill](hill.png)\n") },
      { name: "packing.md", mimeType: "text/markdown", buffer: Buffer.from("# Packing\n\nSocks.\n") },
      { name: "beach.png", mimeType: "image/png", buffer: bytes(JPEG) },
      { name: "hill.png", mimeType: "image/png", buffer: bytes(PNG) },
    ]);
    // The import route compiles on its first use on the dev server.
    await expect(page.getByTestId("import-item")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("import-item").first()).toHaveAttribute("data-status", "done", { timeout: 60_000 });
    await expect(page.getByTestId("import-warning")).toHaveText([`“beach.png”: ${MISMATCH}`, "1 image not found: beach.png"]);
    await page.getByTestId("import-open").first().click();
    await page.waitForURL(/\/d\/[a-z0-9]+$/);
    await expect(page.getByTestId("save-state")).toHaveAttribute("data-state", "saved", { timeout: 30_000 });
    const imported = await codeText(page);
    expect(imported).toContain("![Beach](beach.png)");
    expect(imported).toMatch(/!\[Hill\]\(\/api\/assets\/[a-z0-9]+\)/);
    await owner.context.close();
  });
});
