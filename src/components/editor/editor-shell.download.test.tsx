// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("@hocuspocus/provider", async () => {
  const { Awareness } = await import("y-protocols/awareness");
  return {
    HocuspocusProvider: class {
      awareness: InstanceType<typeof Awareness>;
      constructor(opts: { document: Y.Doc }) { this.awareness = new Awareness(opts.document); }
      destroy() { this.awareness.destroy(); }
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("./lazy-on-first-use", () => ({ lazyOnFirstUse: () => () => null }));
vi.mock("./use-session", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-session")>(),
  useCollabSession: () => session,
}));
vi.mock("@/lib/viewport-hooks", () => ({ useBreakpoint: () => "desktop" }));
vi.mock("./use-sync-polling", async (importOriginal) => ({
  ...await importOriginal<typeof import("./use-sync-polling")>(),
  useSyncPolling: () => {},
}));
vi.mock("./header", () => ({
  Header: (props: ComponentProps<typeof import("./header").Header>) => {
    headerProps = props;
    return null;
  },
}));
vi.mock("./toolbar", () => ({ Toolbar: () => null }));
vi.mock("./status-bar", () => ({ StatusBar: () => null }));
vi.mock("./outline", () => ({ OutlinePanel: () => null }));
vi.mock("./rich-pane", () => ({ RichPane: () => null }));
vi.mock("./selection-bubble", () => ({ SelectionBubble: () => null }));
vi.mock("./table-menu", () => ({ TableMenu: () => null }));
vi.mock("./slash-menu", () => ({ SlashMenu: () => null, useSlashMenuController: () => ({ handlers: undefined }) }));
vi.mock("./hint-bar", () => ({ HintBar: () => null }));
vi.mock("./follow-banner", () => ({ FollowBanner: () => null }));
vi.mock("./scroll-sync", () => ({ useScrollSync: () => {} }));
vi.mock("./panel-resize-handle", async (importOriginal) => ({
  ...await importOriginal<typeof import("./panel-resize-handle")>(),
  PanelResizeHandle: () => null,
}));
vi.mock("./agent-requests", () => ({
  claimerName: () => "Agent",
  describeResult: () => "done",
  useAgentRequests: () => [],
  useAgentRequestsDone: () => {},
}));

import { CollabSession } from "@/editor/collab/session";
import { makeCollabUser } from "@/editor/collab/shared";
import { exportContentDisposition } from "@/lib/download-filename";
import type { DocumentDto } from "@/server/dto";
import type { EditorUser } from "./use-session";
import { EditorShell } from "./editor-shell";

const USER: EditorUser = { id: "download-owner", name: "Owner", login: "owner", image: null };
const DOC: DocumentDto = {
  id: "download-document",
  title: "Previous title",
  storage: "local",
  linkAccess: "private",
  linkPreview: false,
  ownerId: USER.id,
  gistId: null,
  gistFile: null,
  repoOwner: null,
  repoName: null,
  repoBranch: null,
  repoPath: null,
  publishedAt: null,
  hasUnpublishedChanges: false,
  githubUrl: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const OBJECT_URL = "blob:http://localhost/download-test";
const SECOND_OBJECT_URL = "blob:http://localhost/download-test-2";
let session: CollabSession;
let headerProps: ComponentProps<typeof import("./header").Header>;
const createObjectURL = vi.fn<typeof URL.createObjectURL>();
const revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();

beforeEach(() => {
  vi.useFakeTimers();
  createObjectURL.mockReset().mockReturnValue(OBJECT_URL);
  revokeObjectURL.mockReset();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  session = new CollabSession({
    docId: DOC.id,
    user: makeCollabUser(USER.id, USER.name, USER.image, USER.login),
    role: "owner",
    autoConnect: false,
    getToken: async () => { throw new Error("No provider connection permitted"); },
  });
  session.keepAlive();
  session.localLoaded = true;
  session.ytext.insert(0, "Download body");
});

afterEach(() => {
  cleanup();
  session.destroy();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pdfResponse(header: string | null = exportContentDisposition(DOC.title, "pdf")) {
  return new Response(PDF_BYTES, {
    headers: {
      "Content-Type": "application/pdf",
      ...(header === null ? {} : { "Content-Disposition": header }),
    },
  });
}

async function setupDownload(response = pdfResponse()) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    render(<EditorShell doc={DOC} role="owner" user={USER} githubAvailable={false} githubConfigured={false} />);
  });
  const downloads: { filename: string; href: string; connected: boolean }[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ filename: this.download, href: this.href, connected: this.isConnected });
  });
  const createElement = vi.spyOn(document, "createElement");
  const append = vi.spyOn(document.body, "appendChild");
  const remove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
  const timers = vi.spyOn(globalThis, "setTimeout");
  const anchorCreations = () => createElement.mock.calls.filter(([tag]) => tag === "a");
  const releaseTimers = () => timers.mock.calls.filter(([, delay]) => delay === 10_000);
  return { fetch, downloads, click, createElement, append, remove, anchorCreations, releaseTimers };
}

describe("EditorShell PDF download filename", () => {
  const cases = [
    ...[
      { title: "Current title", filename: "Current title.pdf" },
      { title: "Caf\u00e9 r\u00e9sum\u00e9", filename: "Caf\u00e9 r\u00e9sum\u00e9.pdf" },
      { title: "\u8a08\u753b \u6587\u66f8", filename: "\u8a08\u753b \u6587\u66f8.pdf" },
      { title: "\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb", filename: "\ud83d\ude80 \ud83d\udc69\ud83c\udffd\u200d\ud83d\udcbb.pdf" },
      { title: '  \u8a08\u753b "50%"; Bob\'s /\\\r\n ', filename: "\u8a08\u753b 50 Bobs.pdf" },
      { title: "\ud800Caf\u00e9\udfff", filename: "Caf\u00e9.pdf" },
      { title: " \t\r\n ", filename: "document.pdf" },
    ].map(({ title, filename }) => ({ header: exportContentDisposition(title, "pdf"), filename })),
    { header: 'attachment; filename*=UTF-8\'\'Caf%C3%A9.pdf; filename="legacy.pdf"', filename: "Caf\u00e9.pdf" },
    { header: 'attachment; filename="legacy.pdf"', filename: "legacy.pdf" },
    { header: 'attachment; filename="legacy.pdf"; filename*=UTF-8\'\'bad%GG', filename: "legacy.pdf" },
    { header: 'attachment; filename*=ISO-8859-1\'\'Caf%E9.pdf; filename="legacy.pdf"', filename: "legacy.pdf" },
    { header: 'attachment; filename*=UTF-8\'\'..%2Foutside.pdf; filename="legacy.pdf"', filename: "legacy.pdf" },
    { header: "attachment; filename*=UTF-8''Caf%C3%A9%20%3B%25%27%252F.pdf", filename: "Caf\u00e9 ;%'%2F.pdf" },
    { header: "attachment; filename*=UTF-8''bad%C3", filename: "Previous title.pdf" },
    { header: null, filename: "Previous title.pdf" },
  ];

  it.each(cases)("downloads the same bytes exactly once as $filename from $header", async ({ header, filename }) => {
    const { fetch, downloads, click, append, remove, anchorCreations, releaseTimers } = await setupDownload(pdfResponse(header));
    await act(async () => { await headerProps.onDownload("pdf", true); });

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`);
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0];
    if (!("arrayBuffer" in blob)) throw new Error("Expected the response blob");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF_BYTES);
    expect(blob.type).toBe("application/pdf");
    expect(click).toHaveBeenCalledOnce();
    expect(downloads).toEqual([{ filename, href: OBJECT_URL, connected: true }]);
    expect(anchorCreations()).toHaveLength(1);
    expect(append).toHaveBeenCalledOnce();
    const anchor = append.mock.calls[0][0];
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.contexts).toEqual([anchor]);
    expect(anchor.isConnected).toBe(false);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(screen.getByText("Preparing PDF\u2026")).toBeVisible();
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    expect(releaseTimers()).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(9_999); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(fetch).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(anchorCreations()).toHaveLength(1);
    expect(remove).toHaveBeenCalledOnce();
    expect(releaseTimers()).toHaveLength(1);
  });
});

describe("EditorShell PDF download errors", () => {
  function expectNoDownloadResources(download: Awaited<ReturnType<typeof setupDownload>>) {
    expect(download.downloads).toEqual([]);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(download.anchorCreations()).toHaveLength(0);
    expect(download.append).not.toHaveBeenCalled();
    expect(download.click).not.toHaveBeenCalled();
    expect(download.remove).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(download.releaseTimers()).toHaveLength(0);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  }

  function expectErrorToast(message: string) {
    const error = screen.getByText(message, { normalizer: (text) => text });
    expect(error).toBeVisible();
    expect(error.textContent).toBe(message);
    expect(error.closest('[role="status"]')).toHaveClass("bg-red-600");
    expect(screen.getByText("Preparing PDF\u2026")).toBeVisible();
    expect(screen.getAllByTestId("toast")).toHaveLength(2);
  }

  const cases: { label: string; status: number; body: string; contentType?: string; message?: string }[] = [
    { label: "server message with original whitespace", status: 422, body: '{"error":"  PDF export unavailable \\t"}', message: "  PDF export unavailable \t" },
    { label: "empty error", status: 400, body: '{"error":""}' },
    { label: "whitespace error", status: 500, body: '{"error":" \\t\\r\\n "}' },
    { label: "numeric error", status: 429, body: '{"error":42}' },
    { label: "object error", status: 500, body: '{"error":{"message":"Not a string"}}' },
    { label: "array error", status: 503, body: '{"error":["Not a string"]}' },
    { label: "missing error", status: 404, body: '{}' },
    { label: "null error", status: 500, body: '{"error":null}' },
    { label: "null JSON", status: 403, body: 'null' },
    { label: "array JSON", status: 500, body: '[{"error":"Not a top-level message"}]' },
    { label: "primitive JSON", status: 400, body: '"Not an error object"' },
    { label: "empty body", status: 502, body: '' },
    { label: "malformed JSON", status: 500, body: '{"error":"Incomplete message"' },
    { label: "HTML response", status: 502, body: '<html><body>Export gateway unavailable</body></html>', contentType: "text/html" },
    { label: "plain-text response", status: 503, body: 'Export service unavailable', contentType: "text/plain" },
  ];

  it.each(cases)("reports $label without downloading the failed response", async ({ status, body, contentType, message }) => {
    const response = new Response(body, {
      status,
      headers: new Headers({ "Content-Type": contentType ?? "application/json" }),
    });
    const text = vi.spyOn(response, "text");
    const blob = vi.spyOn(Response.prototype, "blob");
    const download = await setupDownload(response);

    await act(async () => { await headerProps.onDownload("pdf", true); });

    expectErrorToast(message ?? `PDF export failed (${status})`);
    for (const elapsed of [0, 20_000]) {
      await act(async () => { vi.advanceTimersByTime(elapsed); });
      expect(download.fetch).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`);
      expect(text).toHaveBeenCalledOnce();
      expect(blob).not.toHaveBeenCalled();
      expectNoDownloadResources(download);
    }
  });

  it.each(["fetch", "response body read"] as const)("preserves the original %s rejection without retrying", async (stage) => {
    const response = new Response('{"error":"Unread server message"}', { status: 502 });
    const text = vi.spyOn(response, "text");
    const blob = vi.spyOn(Response.prototype, "blob");
    const download = await setupDownload(response);
    const error = new Error(stage === "fetch" ? "Export connection interrupted" : "Export response stream interrupted");
    if (stage === "fetch") {
      download.fetch.mockReset().mockRejectedValueOnce(error);
    } else {
      text.mockRejectedValueOnce(error);
    }

    await act(async () => { await headerProps.onDownload("pdf", true); });

    expectErrorToast(error.message);
    for (const elapsed of [0, 20_000]) {
      await act(async () => { vi.advanceTimersByTime(elapsed); });
      expect(download.fetch).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`);
      expect(text).toHaveBeenCalledTimes(stage === "fetch" ? 0 : 1);
      expect(blob).not.toHaveBeenCalled();
      expectNoDownloadResources(download);
    }
  });

  it("allows a fresh intentional download after an HTTP failure with its own bytes, filename and grace", async () => {
    const failed = new Response('{"error":{}}', { status: 503 });
    const failedText = vi.spyOn(failed, "text");
    const failedBlob = vi.spyOn(failed, "blob");
    const success = pdfResponse(exportContentDisposition("Retry caf\u00e9", "pdf"));
    const successBlob = vi.spyOn(success, "blob");
    const successText = vi.spyOn(success, "text");
    const successJson = vi.spyOn(success, "json");
    const download = await setupDownload(failed);
    download.fetch.mockResolvedValueOnce(success);

    await act(async () => { await headerProps.onDownload("pdf", true); });
    expectErrorToast("PDF export failed (503)");
    expectNoDownloadResources(download);
    await act(async () => { vi.advanceTimersByTime(20_000); });
    expectNoDownloadResources(download);
    expect(download.fetch).toHaveBeenCalledOnce();
    expect(failedText).toHaveBeenCalledOnce();
    expect(failedBlob).not.toHaveBeenCalled();
    expect(successBlob).not.toHaveBeenCalled();

    await act(async () => { await headerProps.onDownload("pdf", false); });
    expect(download.fetch.mock.calls).toEqual([
      [`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`],
      [`/api/documents/${DOC.id}/export?format=pdf&download=1`],
    ]);
    expect(successBlob).toHaveBeenCalledOnce();
    expect(successText).not.toHaveBeenCalled();
    expect(successJson).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).toBe(await successBlob.mock.results[0].value);
    const blob = createObjectURL.mock.calls[0][0];
    if (!("arrayBuffer" in blob)) throw new Error("Expected the response blob");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF_BYTES);
    expect(blob.type).toBe("application/pdf");
    expect(download.downloads).toEqual([{ filename: "Retry caf\u00e9.pdf", href: OBJECT_URL, connected: true }]);
    expect(download.click).toHaveBeenCalledOnce();
    expect(download.anchorCreations()).toHaveLength(1);
    expect(download.append).toHaveBeenCalledOnce();
    expect(download.remove.mock.contexts).toEqual([download.append.mock.calls[0][0]]);
    expect(download.append.mock.calls[0][0].isConnected).toBe(false);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(download.releaseTimers()).toHaveLength(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(screen.getByText("Preparing PDF\u2026")).toBeVisible();
    expect(screen.getAllByTestId("toast")).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(9_999); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(download.fetch).toHaveBeenCalledTimes(2);
    expect(failedText).toHaveBeenCalledOnce();
    expect(failedBlob).not.toHaveBeenCalled();
    expect(successBlob).toHaveBeenCalledOnce();
    expect(successText).not.toHaveBeenCalled();
    expect(successJson).not.toHaveBeenCalled();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(download.click).toHaveBeenCalledOnce();
    expect(download.anchorCreations()).toHaveLength(1);
    expect(download.remove).toHaveBeenCalledOnce();
    expect(download.releaseTimers()).toHaveLength(1);
  });
});

describe("EditorShell PDF download cleanup", () => {
  it.each(["append", "click", "anchor creation", "blob read", "object URL creation"] as const)(
    "cleans up after failed %s without replacing the error or retrying",
    async (stage) => {
      const response = pdfResponse();
      const nativeCreateElement = document.createElement.bind(document);
      const { fetch, click, createElement, append, remove, anchorCreations, releaseTimers } = await setupDownload(response);
      const error = new Error(`PDF ${stage} failed`);
      switch (stage) {
        case "append":
          append.mockImplementationOnce(() => { throw error; });
          break;
        case "click":
          click.mockImplementationOnce(function (this: HTMLAnchorElement) {
            expect(this.isConnected).toBe(true);
            expect(this.href).toBe(OBJECT_URL);
            throw error;
          });
          break;
        case "anchor creation":
          createElement.mockImplementation((tag, options) => {
            if (tag === "a") throw error;
            return nativeCreateElement(tag, options);
          });
          break;
        case "blob read":
          vi.spyOn(response, "blob").mockRejectedValueOnce(error);
          break;
        case "object URL creation":
          createObjectURL.mockImplementationOnce(() => { throw error; });
          break;
      }
      await act(async () => { await headerProps.onDownload("pdf", true); });

      const allocated = stage !== "blob read" && stage !== "object URL creation";
      const createdAnchor = stage === "append" || stage === "click";
      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`);
      expect(createObjectURL).toHaveBeenCalledTimes(stage === "blob read" ? 0 : 1);
      expect(anchorCreations()).toHaveLength(allocated ? 1 : 0);
      expect(append).toHaveBeenCalledTimes(createdAnchor ? 1 : 0);
      expect(click).toHaveBeenCalledTimes(stage === "click" ? 1 : 0);
      expect(remove).toHaveBeenCalledTimes(createdAnchor ? 1 : 0);
      if (createdAnchor) {
        const anchor = append.mock.calls[0][0];
        expect(remove.mock.contexts).toEqual([anchor]);
        expect(anchor.isConnected).toBe(false);
      }
      expect(document.querySelectorAll("a[download]")).toHaveLength(0);
      expect(revokeObjectURL.mock.calls).toEqual(allocated ? [[OBJECT_URL]] : []);
      expect(releaseTimers()).toHaveLength(0);
      expect(screen.getByText(error.message)).toBeVisible();
      expect(screen.getByText(error.message).closest('[role="status"]')).toHaveClass("bg-red-600");
      expect(screen.getByText("Preparing PDF\u2026")).toBeVisible();
      expect(screen.getAllByTestId("toast")).toHaveLength(2);

      await act(async () => { vi.advanceTimersByTime(20_000); });
      expect(revokeObjectURL.mock.calls).toEqual(allocated ? [[OBJECT_URL]] : []);
      expect(releaseTimers()).toHaveLength(0);
      expect(fetch).toHaveBeenCalledOnce();
      expect(anchorCreations()).toHaveLength(allocated ? 1 : 0);
      expect(append).toHaveBeenCalledTimes(createdAnchor ? 1 : 0);
      expect(remove).toHaveBeenCalledTimes(createdAnchor ? 1 : 0);
      expect(click).toHaveBeenCalledTimes(stage === "click" ? 1 : 0);
    },
  );

  it("keeps a failed handoff's cleanup independent of a successful retry", async () => {
    const { fetch, downloads, click, append, remove, anchorCreations, releaseTimers } = await setupDownload();
    fetch.mockResolvedValueOnce(pdfResponse(exportContentDisposition("Retry caf\u00e9", "pdf")));
    createObjectURL.mockReturnValueOnce(OBJECT_URL).mockReturnValueOnce(SECOND_OBJECT_URL);
    click.mockImplementationOnce(() => { throw new Error("Save action failed"); });

    await act(async () => { await headerProps.onDownload("pdf", true); });
    expect(screen.getByText("Save action failed")).toBeVisible();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(remove).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(releaseTimers()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await headerProps.onDownload("pdf", false);
    });
    expect(fetch.mock.calls).toEqual([
      [`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`],
      [`/api/documents/${DOC.id}/export?format=pdf&download=1`],
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(downloads).toEqual([{ filename: "Retry caf\u00e9.pdf", href: SECOND_OBJECT_URL, connected: true }]);
    expect(anchorCreations()).toHaveLength(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(remove.mock.contexts).toEqual(append.mock.calls.map(([anchor]) => anchor));
    expect(append.mock.calls.every(([anchor]) => !anchor.isConnected)).toBe(true);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(releaseTimers()).toHaveLength(1);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(8_000); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(1_999); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(revokeObjectURL.mock.calls).toEqual([[OBJECT_URL], [SECOND_OBJECT_URL]]);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(revokeObjectURL.mock.calls).toEqual([[OBJECT_URL], [SECOND_OBJECT_URL]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(anchorCreations()).toHaveLength(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(releaseTimers()).toHaveLength(1);
  });

  it("gives two intentional successful downloads separate URLs and grace periods", async () => {
    const { fetch, downloads, click, append, remove, anchorCreations, releaseTimers } = await setupDownload();
    fetch.mockResolvedValueOnce(pdfResponse());
    createObjectURL.mockReturnValueOnce(OBJECT_URL).mockReturnValueOnce(SECOND_OBJECT_URL);

    await act(async () => { await headerProps.onDownload("pdf", true); });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await headerProps.onDownload("pdf", true);
    });
    expect(fetch.mock.calls).toEqual([
      [`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`],
      [`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`],
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(downloads).toEqual([
      { filename: "Previous title.pdf", href: OBJECT_URL, connected: true },
      { filename: "Previous title.pdf", href: SECOND_OBJECT_URL, connected: true },
    ]);
    expect(anchorCreations()).toHaveLength(2);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][0]).not.toBe(append.mock.calls[1][0]);
    expect(remove.mock.contexts).toEqual(append.mock.calls.map(([anchor]) => anchor));
    expect(append.mock.calls.every(([anchor]) => !anchor.isConnected)).toBe(true);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(releaseTimers()).toHaveLength(2);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(7_999); });
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(1_999); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(revokeObjectURL.mock.calls).toEqual([[OBJECT_URL], [SECOND_OBJECT_URL]]);
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(revokeObjectURL.mock.calls).toEqual([[OBJECT_URL], [SECOND_OBJECT_URL]]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(anchorCreations()).toHaveLength(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(releaseTimers()).toHaveLength(2);
  });
});
