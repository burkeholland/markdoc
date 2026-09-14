// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const response = new Response(PDF_BYTES, {
      headers: {
        "Content-Type": "application/pdf",
        ...(header === null ? {} : { "Content-Disposition": header }),
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    const downloads: { filename: string; href: string; connected: boolean }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, href: this.href, connected: this.isConnected });
    });
    await act(async () => {
      render(<EditorShell doc={DOC} role="owner" user={USER} githubAvailable={false} githubConfigured={false} />);
    });
    await act(async () => { await headerProps.onDownload("pdf", true); });

    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/documents/${DOC.id}/export?format=pdf&download=1&suggestions=1`);
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0];
    if (!("arrayBuffer" in blob)) throw new Error("Expected the response blob");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF_BYTES);
    expect(blob.type).toBe("application/pdf");
    expect(click).toHaveBeenCalledOnce();
    expect(downloads).toEqual([{ filename, href: OBJECT_URL, connected: true }]);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(OBJECT_URL);
    expect(fetch).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });
});
