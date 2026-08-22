import { test, expect, type Page } from "@playwright/test";
import { signIn, createDocument, openDocument, codeText, focusRichEnd } from "./helpers";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function uploadThroughDialog(page: Page, name: string) {
  await page.getByTestId("tb-image").click();
  await page.getByTestId("image-file").setInputFiles({ name, mimeType: "image/png", buffer: PNG });
  await expect(page.getByTestId("image-url")).toHaveValue(/^\/api\/assets\/[a-z0-9]+$/);
  const url = await page.getByTestId("image-url").inputValue();
  await page.getByTestId("image-submit").click();
  return url;
}

test.describe("image upload", () => {
  test("uploads through the Insert image dialog and serves the asset only to people with access", async ({ browser }) => {
    const user = await signIn(browser, "painter");
    const id = await createDocument(user.page, "Gallery\n");
    await openDocument(user.page, id);
    const { page } = user;

    await focusRichEnd(page);
    await page.keyboard.press("Enter");
    const url = await uploadThroughDialog(page, "Sunset Photo.png");

    // The rich pane shows the image and the source has the Markdown for it, with alt from the file name.
    // (A 1x1 image is too small for toBeVisible; presence in the DOM is what matters.)
    await expect(page.locator(`.md-rich img[src="${url}"]`)).toHaveCount(1);
    await expect.poll(() => codeText(page)).toContain(`![Sunset Photo](${url})`);

    // (b) The owner can fetch the bytes with the right type and long private caching.
    const res = await page.request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["cache-control"]).toContain("private");
    expect(res.headers()["cache-control"]).toContain("immutable");
    expect((await res.body()).equals(PNG)).toBeTruthy();

    // (c) Nobody else: a fresh context with no login is refused.
    const anon = await browser.newContext();
    const anonRes = await anon.request.get(url);
    expect([401, 403]).toContain(anonRes.status());

    // Shared by link: anonymous visitors can load the image.
    const share = await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } });
    expect(share.ok()).toBeTruthy();
    const sharedRes = await anon.request.get(url);
    expect(sharedRes.status()).toBe(200);
    expect(sharedRes.headers()["content-type"]).toBe("image/png");
    await anon.close();

    // A signed-in user without access gets 404 (the document is not revealed).
    await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "private" } });
    const stranger = await signIn(browser, "stranger");
    const strangerRes = await stranger.page.request.get(url);
    expect([401, 403, 404]).toContain(strangerRes.status());
    await stranger.context.close();

    await user.context.close();
  });

  test("accepts raw image bodies, dedupes identical uploads and rejects bad input", async ({ browser }) => {
    const user = await signIn(browser, "uploader");
    const id = await createDocument(user.page, "Raw\n");
    const { page } = user;

    const first = await page.request.post(`/api/documents/${id}/assets?name=pixel.png`, { headers: { "Content-Type": "image/png" }, data: PNG });
    expect(first.status()).toBe(201);
    const a = (await first.json()) as { id: string; url: string; name: string; mime: string; size: number; alt: string };
    expect(a).toMatchObject({ url: `/api/assets/${a.id}`, name: "pixel.png", mime: "image/png", size: PNG.length, alt: "pixel" });

    const again = await page.request.post(`/api/documents/${id}/assets`, { multipart: { file: { name: "other-name.png", mimeType: "image/png", buffer: PNG } } });
    expect(again.status()).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(a.id);

    const pdf = await page.request.post(`/api/documents/${id}/assets`, { multipart: { file: { name: "doc.pdf", mimeType: "application/pdf", buffer: PNG } } });
    expect(pdf.status()).toBe(415);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const badSvg = await page.request.post(`/api/documents/${id}/assets`, { multipart: { file: { name: "evil.svg", mimeType: "image/svg+xml", buffer: svg } } });
    expect(badSvg.status()).toBe(400);

    const missing = await page.request.get("/api/assets/doesnotexist");
    expect(missing.status()).toBe(404);

    // Viewers cannot upload.
    await page.request.patch(`/api/documents/${id}`, { data: { linkAccess: "view" } });
    const viewer = await signIn(browser, "viewer-only");
    const denied = await viewer.page.request.post(`/api/documents/${id}/assets`, { multipart: { file: { name: "p.png", mimeType: "image/png", buffer: PNG } } });
    expect(denied.status()).toBe(403);
    await viewer.context.close();

    await user.context.close();
  });

  test("pasting an image file into the rich pane inserts it after upload", async ({ browser }) => {
    const user = await signIn(browser, "paster");
    const id = await createDocument(user.page, "Paste here\n");
    await openDocument(user.page, id);
    const { page } = user;
    await focusRichEnd(page);

    await page.evaluate((bytes) => {
      const file = new File([new Uint8Array(bytes)], "clip board.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector(".md-rich")!.dispatchEvent(event);
    }, Array.from(PNG));

    await expect(page.locator('.md-rich img[src^="/api/assets/"]')).toHaveCount(1);
    await expect.poll(() => codeText(page)).toMatch(/!\[clip board\]\(\/api\/assets\/[a-z0-9]+\)/);
    await expect(page.getByTestId("image-upload-placeholder")).toHaveCount(0);
    await user.context.close();
  });

  test("pasting an image file into the code pane inserts Markdown", async ({ browser }) => {
    const user = await signIn(browser, "coder");
    const id = await createDocument(user.page, "Source\n");
    await openDocument(user.page, id);
    const { page } = user;
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");

    await page.evaluate((bytes) => {
      const file = new File([new Uint8Array(bytes)], "diagram.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector(".cm-content")!.dispatchEvent(event);
    }, Array.from(PNG));

    await expect.poll(() => codeText(page)).toMatch(/!\[diagram\]\(\/api\/assets\/[a-z0-9]+\)/);
    await expect(page.locator('.md-rich img[src^="/api/assets/"]')).toHaveCount(1);
    await user.context.close();
  });
});
