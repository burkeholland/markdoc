import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/documents";
import type { GistFile } from "@/server/github";
import type { GistAutoUpdateDestination, GistAutoUpdatePreview, GistAutoUpdateStatus } from "@/lib/gist-auto-update";
import { SuggestionsModel } from "@/editor/collab/suggestions";
import { createCollabServer } from "@/server/collab/hocuspocus";
import { documentStoreSnapshot, type DocumentStoreSnapshot } from "@/server/collab/autosave";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = randomUUID();
delete process.env.DATABASE_URL;
delete process.env.GITHUB_MOCK;

vi.mock("@/auth", () => ({ auth: async () => actor ? { user: actor } : null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/github", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/github")>();
  return {
    ...original,
    githubClient: vi.fn(),
    currentGitHubLogin: vi.fn(),
    readGistFile: vi.fn(),
    readRepoFile: vi.fn(),
    createGist: vi.fn(),
    updateGist: vi.fn(original.updateGist),
    commitRepoFile: vi.fn(),
  };
});
vi.mock("@/server/documents", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents")>(),
  getGitHubToken: vi.fn(),
}));
vi.mock("@/server/livedoc", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/livedoc")>();
  return { ...original, readLiveText: vi.fn(original.readLiveText) };
});

const { getDb, closeDb, schema, withGistSettingsLock } = await import("@/server/db");
const {
  createDocument, updateDocument, setDocumentText, deleteDocument, getDocumentAccess,
  getPublishedContent, getGitHubToken,
} = await import("@/server/documents");
const {
  githubClient, readGistFile, readRepoFile, currentGitHubLogin, createGist, updateGist, commitRepoFile,
} = await import("@/server/github");
const { readLiveText, replaceLiveText } = await import("@/server/livedoc");
const { hydrateDoc, encodeSeedState, TEXT_KEY } = await import("@/server/collab/seed");
const { previewGistAutoUpdate, publishDocument, clearSyncCache } = await import("@/server/publish");
const {
  configureGistAutoUpdate, retryGistAutoUpdate, gistAutoUpdateStatus, runGistAutoUpdateQueue,
  startGistAutoUpdateWorker, stopGistAutoUpdateWorker,
} = await import("@/server/gist-auto-update");
const { GET, PATCH, POST } = await import("@/app/api/documents/[id]/gist-auto-update/route");
const { POST: link } = await import("@/app/api/documents/[id]/link/route");
const { apiLimiter } = await import("@/server/rate-limit");

const BASE = "# Local fixture\n\nSaved paragraph.\n";
const SAVED = "# Local fixture\n\nSaved new paragraph.\n";
const OTHER_FILE = "# Separate file\n\nDo not change this file.\n";
const DESTINATION: GistAutoUpdateDestination = {
  gistId: "linked-gist", filename: "notes.md", url: "https://gist.github.com/linked-gist",
  visibility: "secret", owner: "ann",
};
const OFF = { enabled: false, status: "off", syncedAt: null, message: null, pending: false, destination: null };
let owner: SessionUser;
let other: SessionUser;
let actor: SessionUser | null;
let remote: GistFile;
let files: Record<string, string>;
let createdIds: string[];
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (id: string, method = "GET", body?: unknown, preview = false) =>
  new Request(`http://localhost:3411/api/documents/${id}/gist-auto-update${preview ? "?preview=1" : ""}`, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
const consent = (destination = DESTINATION) => ({ enabled: true, acknowledgeRisk: true, destination });
const fail = (status: number) => Object.assign(new Error("Mock GitHub failure"), { status });
const blockedFetch = vi.fn(async () => { throw new Error("Unexpected network request"); });

type GistPatch = { gist_id: string; files?: Record<string, { content?: string; filename?: string } | null>; description?: string };
async function applyRemotePatch(input: GistPatch) {
  expect(input.gist_id).toBe(remote.gistId);
  for (const [filename, change] of Object.entries(input.files ?? {})) {
    if (change === null) delete files[filename];
    else if (change.content !== undefined) files[filename] = change.content;
  }
  remote.revision = `${remote.revision}-next`;
  return { data: { html_url: remote.htmlUrl, updated_at: new Date().toISOString(), history: [{ version: remote.revision }] } };
}
const githubPatch = vi.fn(applyRemotePatch);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function linkedDoc() {
  const doc = await createDocument({ ownerId: owner.id, content: BASE });
  createdIds.push(doc.id);
  return (await updateDocument(doc.id, {
    storage: "gist", gistId: DESTINATION.gistId, gistFile: DESTINATION.filename,
    publishedAt: new Date(), publishedContent: BASE, githubSha: "revision-1",
  }))!;
}

async function savedDoc(id: string) {
  const db = await getDb();
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  return doc;
}

async function getDocumentContent(id: string) {
  return (await savedDoc(id)).content;
}

async function receipt(id: string) {
  const db = await getDb();
  const [job] = await db.select().from(schema.gistAutoUpdates).where(eq(schema.gistAutoUpdates.documentId, id));
  return job;
}

async function status(id: string) {
  const res = await GET(request(id), params(id));
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return await res.json() as GistAutoUpdateStatus;
}

async function enable(id: string, destination = DESTINATION) {
  const res = await PATCH(request(id, "PATCH", consent(destination)), params(id));
  expect(res.status).toBe(200);
  const body = await res.json() as GistAutoUpdateStatus;
  expect(body).toMatchObject({ enabled: true, status: "pending", pending: true, destination });
  vi.mocked(readLiveText).mockClear();
  return body;
}

async function disable(id: string) {
  const res = await PATCH(request(id, "PATCH", { enabled: false }), params(id));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ enabled: false, status: "off", pending: false });
}

async function retry(id: string) {
  const res = await POST(request(id, "POST"), params(id));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ enabled: true, status: "pending", pending: true });
}

const relink = (id: string, body: unknown) => link(new Request(`http://localhost:3411/api/documents/${id}/link`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), params(id));

async function idle(ms = 2000) {
  await vi.advanceTimersByTimeAsync(ms);
  await runGistAutoUpdateQueue();
}

function clearRemoteCalls() {
  for (const mock of [getGitHubToken, githubClient, currentGitHubLogin, readGistFile, updateGist, readLiveText]) {
    vi.mocked(mock).mockClear();
  }
  githubPatch.mockClear();
}

beforeAll(async () => {
  const db = await getDb();
  const [a, b] = await db.insert(schema.users).values([
    { name: "Ann", login: "ann", email: "ann-auto-update@example.test" },
    { name: "Other", login: "other", email: "other-auto-update@example.test" },
  ]).returning();
  owner = { id: a.id, login: a.login, name: a.name, image: null };
  other = { id: b.id, login: b.login, name: b.name, image: null };
});

beforeEach(() => {
  apiLimiter.reset();
  actor = owner;
  createdIds = [];
  clearSyncCache();
  // Keep the fake save clock ahead of PGlite's native clock_timestamp().
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
  remote = {
    gistId: DESTINATION.gistId, filename: DESTINATION.filename, content: BASE, description: null,
    htmlUrl: DESTINATION.url, isPublic: false, owner: "ann", revision: "revision-1", updatedAt: null,
    truncated: false, contentKnown: true, visibilityKnown: true,
  };
  files = { "notes.md": BASE, "unrelated.md": OTHER_FILE };
  vi.mocked(getGitHubToken).mockReset().mockResolvedValue(randomUUID());
  vi.mocked(githubClient).mockReset().mockReturnValue({ gists: { update: githubPatch } } as unknown as ReturnType<typeof githubClient>);
  vi.mocked(readGistFile).mockReset().mockImplementation(async (_client, gistId, filename) => {
    if (gistId !== remote.gistId || !filename || !(filename in files)) throw fail(404);
    return { ...remote, content: files[filename] };
  });
  vi.mocked(currentGitHubLogin).mockReset().mockResolvedValue("ANN");
  vi.mocked(readRepoFile).mockReset();
  vi.mocked(createGist).mockReset();
  vi.mocked(updateGist).mockReset();
  vi.mocked(commitRepoFile).mockReset();
  vi.mocked(readLiveText).mockReset();
  githubPatch.mockReset();
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  try {
    expect(createGist).not.toHaveBeenCalled();
    expect(commitRepoFile).not.toHaveBeenCalled();
    expect(readRepoFile).not.toHaveBeenCalled();
    expect(blockedFetch).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const db = await getDb();
    if (createdIds.length) await db.delete(schema.documents).where(inArray(schema.documents.id, createdIds));
  }
});

afterAll(async () => { await closeDb(); });

describe("owner-only gist auto-update consent", () => {
  it("returns a DB-only off default without creating a receipt, checking credentials, or reading GitHub", async () => {
    const doc = await linkedDoc();
    vi.mocked(getGitHubToken).mockResolvedValue(null);
    expect(await status(doc.id)).toEqual(OFF);
    expect(await receipt(doc.id)).toBeUndefined();
    await setDocumentText(doc.id, SAVED);
    await idle(60_000);
    expect(await status(doc.id)).toEqual(OFF);
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
  });

  it.each([false, true])("previews the exact file and public=%s using the owner's token lookup ID", async (isPublic) => {
    const doc = await linkedDoc();
    remote.isPublic = isPublic;
    const res = await GET(request(doc.id, "GET", undefined, true), params(doc.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const preview = await res.json() as GistAutoUpdatePreview;
    expect(preview).toMatchObject({ destination: { ...DESTINATION, visibility: isPublic ? "public" : "secret" } });
    expect(preview).not.toHaveProperty("content");
    expect(preview).not.toHaveProperty("publishedContent");
    expect(getGitHubToken).toHaveBeenCalledExactlyOnceWith(owner.id);
    expect(currentGitHubLogin).toHaveBeenCalledTimes(1);
    expect(readGistFile).toHaveBeenCalledExactlyOnceWith(expect.anything(), "linked-gist", "notes.md");
    expect(await status(doc.id)).toEqual(OFF);
    expect(await receipt(doc.id)).toBeUndefined();
    expect(updateGist).not.toHaveBeenCalled();
  });

  it.each(["editor", "commenter", "viewer"] as const)("rejects a %s from status, preview, settings, and retry before credentials", async (role) => {
    const doc = await linkedDoc();
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: doc.id, login: other.login!, role });
    actor = other;
    expect((await GET(request(doc.id), params(doc.id))).status).toBe(403);
    expect((await GET(request(doc.id, "GET", undefined, true), params(doc.id))).status).toBe(403);
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(403);
    expect((await PATCH(request(doc.id, "PATCH", { enabled: false }), params(doc.id))).status).toBe(403);
    expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(403);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(await receipt(doc.id)).toBeUndefined();
  });

  it.each(["anonymous", "unrelated owner", "edit-link"] as const)("does not grant publishing authority to an %s", async (access) => {
    const doc = await linkedDoc();
    actor = access === "anonymous" ? null : other;
    if (access === "edit-link") await updateDocument(doc.id, { linkAccess: "edit" });
    const expected = access === "anonymous" ? 401 : access === "edit-link" ? 403 : 404;
    expect((await GET(request(doc.id), params(doc.id))).status).toBe(expected);
    expect((await GET(request(doc.id, "GET", undefined, true), params(doc.id))).status).toBe(expected);
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(expected);
    expect((await PATCH(request(doc.id, "PATCH", { enabled: false }), params(doc.id))).status).toBe(expected);
    expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(expected);
    expect(getGitHubToken).not.toHaveBeenCalled();
  });

  it("also checks document ownership on direct service calls", async () => {
    const doc = await linkedDoc();
    await expect(previewGistAutoUpdate(doc, other)).rejects.toMatchObject({ status: 403 });
    await expect(configureGistAutoUpdate(doc, other, { enabled: false })).rejects.toMatchObject({ status: 403 });
    await expect(configureGistAutoUpdate(doc, other, { enabled: true, acknowledgeRisk: true, destination: DESTINATION })).rejects.toMatchObject({ status: 403 });
    await expect(retryGistAutoUpdate(doc, other)).rejects.toMatchObject({ status: 403 });
    expect(getGitHubToken).not.toHaveBeenCalled();
  });

  it.each(["different-account", ""])("refuses the document owner when their token account %j does not own the gist", async (login) => {
    const doc = await linkedDoc();
    vi.mocked(currentGitHubLogin).mockResolvedValue(login);
    expect((await GET(request(doc.id, "GET", undefined, true), params(doc.id))).status).toBe(403);
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(403);
    expect(getGitHubToken).toHaveBeenCalledWith(owner.id);
    expect(await status(doc.id)).toEqual(OFF);
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("refuses missing authorization without a remote read", async () => {
    const doc = await linkedDoc();
    vi.mocked(getGitHubToken).mockResolvedValue(null);
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(400);
    expect(await status(doc.id)).toEqual(OFF);
    expect(readGistFile).not.toHaveBeenCalled();
  });

  it.each([
    {}, { enabled: "true" }, { enabled: true },
    { enabled: true, destination: DESTINATION },
    { enabled: true, acknowledgeRisk: false, destination: DESTINATION },
    { enabled: true, acknowledgeRisk: "true", destination: DESTINATION },
    { enabled: true, acknowledgeRisk: true },
    { ...consent(), force: true },
    { ...consent(), destination: { ...DESTINATION, visibility: "private" } },
    { ...consent(), destination: { ...DESTINATION, url: "not a URL" } },
    { ...consent(), destination: { ...DESTINATION, filename: "" } },
    { enabled: false, destination: DESTINATION },
  ])("rejects malformed or unacknowledged settings %# before consulting GitHub", async (body) => {
    const doc = await linkedDoc();
    expect((await PATCH(request(doc.id, "PATCH", body), params(doc.id))).status).toBe(400);
    expect(await status(doc.id)).toEqual(OFF);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
  });

  it.each([
    { gistId: "another-gist" }, { filename: "another.md" }, { url: "https://gist.github.com/another-gist" },
    { visibility: "public" as const }, { owner: "another-owner" },
  ])("requires consent to match the fresh destination: %j", async (change) => {
    const doc = await linkedDoc();
    const res = await PATCH(request(doc.id, "PATCH", consent({ ...DESTINATION, ...change })), params(doc.id));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "conflict" });
    expect(readGistFile).toHaveBeenCalledTimes(1);
    expect(await status(doc.id)).toEqual(OFF);
    expect(await receipt(doc.id)).toBeUndefined();
  });

  it("compares GitHub account names case-insensitively and stores the verified account", async () => {
    const doc = await linkedDoc();
    const res = await PATCH(request(doc.id, "PATCH", consent({ ...DESTINATION, owner: "ANN" })), params(doc.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: true, destination: DESTINATION });
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("pins the first verified revision so replacement of a freshly linked file is detected", async () => {
    const doc = await linkedDoc();
    await updateDocument(doc.id, { githubSha: null });
    await enable(doc.id);
    expect((await savedDoc(doc.id)).githubSha).toBe("revision-1");
    remote.revision = "replacement-revision";
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("rechecks preview-time visibility before accepting consent", async () => {
    const doc = await linkedDoc();
    const preview = await GET(request(doc.id, "GET", undefined, true), params(doc.id));
    const { destination } = await preview.json() as GistAutoUpdatePreview;
    remote.isPublic = true;
    expect((await PATCH(request(doc.id, "PATCH", consent(destination)), params(doc.id))).status).toBe(409);
    expect(readGistFile).toHaveBeenCalledTimes(2);
    expect(await receipt(doc.id)).toBeUndefined();
  });

  it("refuses activation after an off-mode unsaved manual publish instead of queueing an older snapshot", async () => {
    const doc = await linkedDoc();
    let liveContent = "# Manually published but not yet saved\n";
    vi.mocked(readLiveText).mockImplementation(async () => ({
      text: liveContent, clean: liveContent, title: doc.title, pendingSuggestions: 0, openComments: 0,
    }));
    await publishDocument(doc, owner);
    expect(await getDocumentContent(doc.id)).toBe(BASE);
    expect(files["notes.md"]).toBe(liveContent);
    clearRemoteCalls();
    const refused = await PATCH(request(doc.id, "PATCH", consent()), params(doc.id));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("finish saving") });
    expect(await status(doc.id)).toEqual(OFF);
    expect(await receipt(doc.id)).toBeUndefined();
    liveContent = "# Newest collaborator edits still unsaved\n";
    await idle(10_000);
    expect(updateGist).not.toHaveBeenCalled();
    expect(files["notes.md"]).toBe("# Manually published but not yet saved\n");
    await setDocumentText(doc.id, liveContent);
    await enable(doc.id);
    await idle(1999);
    expect(updateGist).not.toHaveBeenCalled();
    await idle(1);
    expect(files["notes.md"]).toBe(liveContent);
    expect(updateGist).toHaveBeenCalledTimes(1);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("still activates saved-ahead content against an older confirmed remote baseline", async () => {
    const doc = await linkedDoc();
    await setDocumentText(doc.id, SAVED);
    await enable(doc.id);
    expect(files["notes.md"]).toBe(BASE);
    await idle();
    expect(files["notes.md"]).toBe(SAVED);
    expect(updateGist).toHaveBeenCalledTimes(1);
  });

  it("rechecks the baseline after preview and refuses a newly observed outside edit", async () => {
    const doc = await linkedDoc();
    expect((await GET(request(doc.id, "GET", undefined, true), params(doc.id))).status).toBe(200);
    files["notes.md"] = "# Outside work after preview\n";
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(409);
    expect(await status(doc.id)).toEqual(OFF);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect(updateGist).not.toHaveBeenCalled();
  });

  it.each([
    { publishedAt: null }, { gistFile: null }, { storage: "local" as const },
  ])("refuses incomplete, unpublished, or unlinked connections %j", async (change) => {
    const doc = await linkedDoc();
    await updateDocument(doc.id, change);
    expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(409);
    expect(readGistFile).not.toHaveBeenCalled();
    expect(await status(doc.id)).toEqual(OFF);
  });

  it("persists a delayed opt-in for only the selected document", async () => {
    const selected = await linkedDoc();
    const unselected = await linkedDoc();
    await enable(selected.id);
    const job = await receipt(selected.id);
    expect(job).toMatchObject({
      publisherId: owner.id, gistId: DESTINATION.gistId, filename: DESTINATION.filename,
      accountLogin: DESTINATION.owner, isPublic: false, enabled: true, queuedVersion: 1, syncedVersion: 0, activeVersion: null,
    });
    expect(job.acknowledgedAt.toISOString()).toBe(new Date().toISOString());
    expect(job.dueAt.getTime()).toBe(Date.now() + 2000);
    expect(job.generation).toBeTruthy();
    await setDocumentText(selected.id, SAVED);
    await setDocumentText(unselected.id, "# Never opted in\n");
    await idle();
    expect(updateGist).toHaveBeenCalledTimes(1);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await status(unselected.id)).toEqual(OFF);
    expect(await receipt(unselected.id)).toBeUndefined();
  });

  it("refuses competing enable and disable requests while an enable holds the settings lock", async () => {
    const doc = await linkedDoc();
    const started = deferred();
    const release = deferred();
    vi.mocked(readGistFile).mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return { ...remote, content: files["notes.md"] };
    });
    const configuring = PATCH(request(doc.id, "PATCH", consent()), params(doc.id));
    try {
      await started.promise;
      expect((await PATCH(request(doc.id, "PATCH", consent()), params(doc.id))).status).toBe(409);
      expect((await PATCH(request(doc.id, "PATCH", { enabled: false }), params(doc.id))).status).toBe(409);
      expect(await receipt(doc.id)).toBeUndefined();
      expect(readGistFile).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await configuring;
    }
    expect((await configuring).status).toBe(200);
    expect(await status(doc.id)).toMatchObject({ enabled: true, status: "pending" });
    await disable(doc.id);
    await idle();
    expect(await status(doc.id)).toMatchObject({ enabled: false, status: "off" });
    expect(updateGist).not.toHaveBeenCalled();
  });
});

describe("durable debounced saved-version publishing", () => {
  it("publishes the immutable autosave transaction while newer live edits wait behind the same writer", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await idle();
    clearRemoteCalls();
    githubPatch.mockImplementation(applyRemotePatch);
    const initialReceipt = await receipt(doc.id);
    const server = createCollabServer();
    const connection = await server.openDirectConnection(doc.id, {
      docId: doc.id, userId: owner.id, name: owner.name ?? "Ann", login: owner.login, avatar: null, role: "owner",
    });
    const document = server.documents.get(doc.id)!;
    const text = document.getText(TEXT_KEY);
    const firstCommitted = deferred();
    const finishFirst = deferred();
    const secondCommitted = deferred();
    const snapshots: DocumentStoreSnapshot[] = [];
    server.configuration.extensions.push({
      async afterStoreDocument(payload) {
        snapshots.push(documentStoreSnapshot(payload));
        if (snapshots.length === 1) {
          firstCommitted.resolve();
          await finishFirst.promise;
        } else {
          secondCommitted.resolve();
        }
      },
    });
    let releaseMutex: (() => void) | undefined = await document.saveMutex.acquire();
    try {
      text.insert(0, "First saved edit.\n\n");
      await vi.advanceTimersByTimeAsync(999);
      expect(server.debouncer.isCurrentlyExecuting(`onStoreDocument-${doc.id}`)).toBe(false);
      expect((await receipt(doc.id)).queuedVersion).toBe(initialReceipt.queuedVersion);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.debouncer.isCurrentlyExecuting(`onStoreDocument-${doc.id}`)).toBe(true);
      const firstSavedAt = new Date();
      document.transact(() => {
        text.insert(0, "Newer live edit.\n\n");
        document.getMap("meta").set("title", "Newer live title");
      });
      const newestContent = text.toString();
      releaseMutex();
      releaseMutex = undefined;
      await firstCommitted.promise;
      const first = await savedDoc(doc.id);
      expect(first).toMatchObject({ content: "First saved edit.\n\n" + BASE, title: doc.title, updatedAt: firstSavedAt });
      expect(first.ystate).toEqual(snapshots[0].ystate);
      expect(snapshots[0]).toMatchObject({ content: first.content, title: first.title, savedAt: first.updatedAt });
      expect((await receipt(doc.id)).dueAt.getTime()).toBe(firstSavedAt.getTime() + 2000);
      const restored = new Y.Doc();
      try {
        Y.applyUpdate(restored, first.ystate!);
        expect(restored.getText(TEXT_KEY).toString()).toBe(first.content);
        expect(restored.getMap("meta").get("title")).toBe(first.title);
      } finally {
        restored.destroy();
      }
      await idle(1999);
      expect(updateGist).not.toHaveBeenCalled();
      await idle(1);
      expect(snapshots).toHaveLength(1);
      expect(files["notes.md"]).toBe(first.content);
      expect(updateGist).toHaveBeenCalledTimes(1);
      expect(readLiveText).not.toHaveBeenCalled();
      expect(text.toString()).toBe(newestContent);
      finishFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await secondCommitted.promise;
      expect(snapshots).toHaveLength(2);
      expect(await savedDoc(doc.id)).toMatchObject({
        content: newestContent, title: "Newer live title", updatedAt: snapshots[1].savedAt, ystate: snapshots[1].ystate,
      });
      await idle(1999);
      expect(updateGist).toHaveBeenCalledTimes(1);
      await idle(1);
      expect(updateGist).toHaveBeenCalledTimes(2);
      expect(files["notes.md"]).toBe(newestContent);
      expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
    } finally {
      releaseMutex?.();
      finishFirst.resolve();
      await connection.disconnect();
      await server.unloadDocument(document);
      expect(server.documents.size).toBe(0);
    }
  });

  it("coalesces ten saves within two seconds into one upload of the newest saved snapshot", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    clearRemoteCalls();
    const deadline = vi.spyOn(AbortSignal, "timeout");
    let latest = BASE;
    let latestSaved = doc;
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(100);
      latest = `# Saved burst ${i}\n`;
      latestSaved = (await setDocumentText(doc.id, latest))!;
      await runGistAutoUpdateQueue();
      expect(updateGist).not.toHaveBeenCalled();
    }
    const queued = await receipt(doc.id);
    expect(queued.queuedVersion).toBe(11);
    expect(queued.dueAt.getTime()).toBe(latestSaved.updatedAt.getTime() + 2000);
    await idle(1999);
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
    await idle(1);
    expect(updateGist).toHaveBeenCalledExactlyOnceWith(expect.anything(), "linked-gist", "notes.md", latest, undefined);
    expect(files["notes.md"]).toBe(latest);
    expect(await getPublishedContent(doc.id)).toBe(latest);
    expect(await status(doc.id)).toMatchObject({ enabled: true, status: "synced", pending: false, syncedAt: new Date().toISOString() });
    expect(await receipt(doc.id)).toMatchObject({ queuedVersion: 11, syncedVersion: 11, activeVersion: null });
    expect(readLiveText).not.toHaveBeenCalled();
    expect(vi.mocked(getGitHubToken).mock.calls.every(([id]) => id === owner.id)).toBe(true);
    expect(vi.mocked(githubClient).mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(deadline).toHaveBeenCalledWith(15_000);
  });

  it("lets concurrent processors perform at most one upload", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const first = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await Promise.all([runGistAutoUpdateQueue(), runGistAutoUpdateQueue()]);
      expect(updateGist).toHaveBeenCalledTimes(1);
      expect(await status(doc.id)).toMatchObject({ status: "syncing", pending: false });
    } finally {
      release.resolve();
      await first;
    }
    await runGistAutoUpdateQueue();
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("serializes different documents pinned to the same gist file", async () => {
    const first = await linkedDoc();
    const second = await linkedDoc();
    await enable(first.id);
    await enable(second.id);
    await setDocumentText(first.id, "# First document\n");
    await setDocumentText(second.id, "# Second document\n");
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await runGistAutoUpdateQueue();
      expect(updateGist).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await running;
    }
    await runGistAutoUpdateQueue();
    expect(updateGist).toHaveBeenCalledTimes(1);
    expect([(await status(first.id)).status, (await status(second.id)).status].sort()).toEqual(["conflict", "synced"]);
    expect(await getDocumentContent(first.id)).toBe("# First document\n");
    expect(await getDocumentContent(second.id)).toBe("# Second document\n");
  });

  it("publishes an authorized collaborator's saved edits using only the owner's opted-in identity", async () => {
    const doc = await linkedDoc();
    const db = await getDb();
    await db.insert(schema.collaborators).values({ documentId: doc.id, login: other.login!, role: "editor" });
    expect((await getDocumentAccess(doc.id, other))?.role).toBe("editor");
    await enable(doc.id);
    await replaceLiveText(doc.id, {
      userId: other.id, docId: doc.id, role: "editor", name: other.name!, login: other.login, avatar: null,
    }, SAVED);
    expect((await savedDoc(doc.id)).lastEditedBy).toBe(other.id);
    await idle();
    expect(files["notes.md"]).toBe(SAVED);
    expect(vi.mocked(getGitHubToken).mock.calls.every(([id]) => id === owner.id)).toBe(true);
  });

  it("retains saves made during an upload and sends the newest version only after its own idle deadline", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const running = runGistAutoUpdateQueue();
    const newest = "# Newest save during upload\n";
    try {
      await started.promise;
      const active = await receipt(doc.id);
      expect(active).toMatchObject({ status: "syncing", activeVersion: active.queuedVersion });
      await setDocumentText(doc.id, "# Intermediate save during upload\n");
      await vi.advanceTimersByTimeAsync(100);
      await setDocumentText(doc.id, newest);
      expect(await status(doc.id)).toMatchObject({ status: "syncing", pending: true });
      expect((await receipt(doc.id)).queuedVersion).toBe(active.queuedVersion + 2);
    } finally {
      release.resolve();
      await running;
    }
    expect(await getDocumentContent(doc.id)).toBe(newest);
    expect(await getPublishedContent(doc.id)).toBe(SAVED);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await status(doc.id)).toMatchObject({ status: "pending", pending: true });
    await idle(1999);
    expect(updateGist).toHaveBeenCalledTimes(1);
    await idle(1);
    expect(updateGist).toHaveBeenCalledTimes(2);
    expect(files["notes.md"]).toBe(newest);
    expect(await getPublishedContent(doc.id)).toBe(newest);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("skips identical text, including a new persisted CRDT seed with unchanged content", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
    expect(updateGist).not.toHaveBeenCalled();
    const before = await receipt(doc.id);
    await setDocumentText(doc.id, BASE);
    expect((await receipt(doc.id)).queuedVersion).toBe(before.queuedVersion + 1);
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
    expect(updateGist).not.toHaveBeenCalled();
    expect(githubPatch).not.toHaveBeenCalled();
  });

  it("recognizes GitHub's newline representation of an empty baseline and sends no identical update", async () => {
    const doc = await linkedDoc();
    await setDocumentText(doc.id, "");
    await updateDocument(doc.id, { publishedContent: "" });
    files["notes.md"] = "\n";
    await enable(doc.id);
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
    await setDocumentText(doc.id, "");
    await idle();
    expect(updateGist).not.toHaveBeenCalled();
    expect(githubPatch).not.toHaveBeenCalled();
    expect(files["notes.md"]).toBe("\n");
    expect(await getPublishedContent(doc.id)).toBe("");
    expect(await getDocumentContent(doc.id)).toBe("");
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
    await setDocumentText(doc.id, SAVED);
    await idle();
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getPublishedContent(doc.id)).toBe(SAVED);
  });

  it("publishes a newly empty saved document as a newline once, then skips another empty save", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, "");
    await idle();
    expect(githubPatch).toHaveBeenCalledExactlyOnceWith({
      gist_id: "linked-gist", description: undefined, files: { "notes.md": { content: "\n" } },
    });
    expect(await getPublishedContent(doc.id)).toBe("");
    await setDocumentText(doc.id, "");
    await idle();
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(files["notes.md"]).toBe("\n");
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("does not queue metadata-only document edits", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await idle();
    const before = await receipt(doc.id);
    clearRemoteCalls();
    await updateDocument(doc.id, { title: "New title", linkAccess: "comment", lastEditedBy: other.id });
    expect(await receipt(doc.id)).toEqual(before);
    await idle(60_000);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("uses the exact linked filename, preserves other files, and never supplies an invented conditional PATCH", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    clearRemoteCalls();
    await idle();
    expect(readGistFile).toHaveBeenCalledExactlyOnceWith(expect.anything(), "linked-gist", "notes.md");
    expect(githubPatch).toHaveBeenCalledExactlyOnceWith({
      gist_id: "linked-gist", description: undefined, files: { "notes.md": { content: SAVED } },
    });
    expect(files).toEqual({ "notes.md": SAVED, "unrelated.md": OTHER_FILE });
    expect(await status(doc.id)).toMatchObject({ status: "synced" });
  });

  it("coordinates the worker and safe manual publishing with the same destination lock", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await expect(publishDocument(await savedDoc(doc.id), owner)).rejects.toMatchObject({ status: 409 });
      expect(updateGist).toHaveBeenCalledTimes(1);
      expect(readLiveText).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await running;
    }
    await expect(publishDocument(await savedDoc(doc.id), owner)).resolves.toMatchObject({ skipped: true, status: "in-sync" });
    expect(updateGist).toHaveBeenCalledTimes(1);
  });

  it("requires an opted-in manual update to be saved so the queue cannot roll it back", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    const newest = "# Newer live manual content\n";
    vi.mocked(readLiveText).mockResolvedValueOnce({
      text: newest, clean: newest, title: doc.title, pendingSuggestions: 0, openComments: 0,
    });
    await expect(publishDocument(await savedDoc(doc.id), owner)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("finish saving"),
    });
    expect(updateGist).not.toHaveBeenCalled();
    expect(files["notes.md"]).toBe(BASE);
    await setDocumentText(doc.id, newest);
    await publishDocument(await savedDoc(doc.id), owner);
    expect(files["notes.md"]).toBe(newest);
    await idle();
    expect(updateGist).toHaveBeenCalledTimes(1);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("preserves newer saved work committed during a manual upload", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const manual = publishDocument(await savedDoc(doc.id), owner);
    const newest = "# Saved during the manual upload\n";
    try {
      await started.promise;
      await setDocumentText(doc.id, newest);
    } finally {
      release.resolve();
      await manual;
    }
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getDocumentContent(doc.id)).toBe(newest);
    await idle();
    expect(files["notes.md"]).toBe(newest);
    expect(updateGist).toHaveBeenCalledTimes(2);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("leaves manual live publishing unchanged when auto-update is off", async () => {
    const doc = await linkedDoc();
    vi.mocked(readLiveText).mockResolvedValueOnce({
      text: SAVED, clean: SAVED, title: doc.title, pendingSuggestions: 0, openComments: 0,
    });
    await publishDocument(doc, owner);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getDocumentContent(doc.id)).toBe(BASE);
    expect(await status(doc.id)).toEqual(OFF);
  });

  it("rolls the save receipt back with a failed document transaction", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await idle();
    const before = await receipt(doc.id);
    clearRemoteCalls();
    const db = await getDb();
    const rollback = new Error("Intentional rollback");
    await expect(db.transaction(async (tx) => {
      await setDocumentText(doc.id, SAVED, tx);
      const [queued] = await tx.select().from(schema.gistAutoUpdates).where(eq(schema.gistAutoUpdates.documentId, doc.id));
      expect(queued.queuedVersion).toBe(before.queuedVersion + 1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await receipt(doc.id)).toEqual(before);
    expect(await getDocumentContent(doc.id)).toBe(BASE);
    await idle(60_000);
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("does not queue a save rejected before persistence", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await idle();
    const before = await receipt(doc.id);
    clearRemoteCalls();
    await expect(updateDocument(doc.id, { content: SAVED })).rejects.toThrow("content");
    expect(await receipt(doc.id)).toEqual(before);
    expect(await getDocumentContent(doc.id)).toBe(BASE);
    await idle();
    expect(updateGist).not.toHaveBeenCalled();
  });
});

describe("known preflight conflicts and paused failures", () => {
  it.each([
    ["missing gist", { missing: true }],
    ["replaced file", { filename: "replacement.md" }],
    ["replaced gist", { gistId: "replacement-gist" }],
    ["outside content", { content: "# Outside work\n" }],
    ["outside revision", { revision: "outside-revision" }],
    ["unknown revision", { revision: null }],
    ["truncated content", { truncated: true }],
    ["unknown content", { contentKnown: false }],
    ["unknown visibility", { visibilityKnown: false }],
    ["changed visibility", { isPublic: true }],
  ] as const)("pauses on %s, retains saved text, and does not resume on later saves", async (_name, change) => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    clearRemoteCalls();
    if ("missing" in change) vi.mocked(readGistFile).mockRejectedValueOnce(fail(404));
    else vi.mocked(readGistFile).mockResolvedValueOnce({ ...remote, ...change });
    await idle();
    expect(await status(doc.id)).toMatchObject({ enabled: true, status: "conflict", pending: true });
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect(updateGist).not.toHaveBeenCalled();
    const latest = "# More saved work while paused\n";
    await setDocumentText(doc.id, latest);
    await idle(60_000);
    expect(await getDocumentContent(doc.id)).toBe(latest);
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    expect(readGistFile).toHaveBeenCalledTimes(1);
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("does not fall back to another file or recreate a deleted linked file", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    delete files["notes.md"];
    clearRemoteCalls();
    await idle();
    expect(readGistFile).toHaveBeenCalledExactlyOnceWith(expect.anything(), "linked-gist", "notes.md");
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    expect(files).toEqual({ "unrelated.md": OTHER_FILE });
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("refuses an unknown persisted baseline instead of treating it as permission to overwrite", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await updateDocument(doc.id, { publishedContent: null });
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    expect(updateGist).not.toHaveBeenCalled();
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
  });

  it.each(["missing token", "account changed", "owner changed", "unauthorized", "forbidden"] as const)(
    "pauses on %s without an automatic retry",
    async (change) => {
      const doc = await linkedDoc();
      await enable(doc.id);
      await setDocumentText(doc.id, SAVED);
      clearRemoteCalls();
      if (change === "missing token") vi.mocked(getGitHubToken).mockResolvedValue(null);
      if (change === "account changed") vi.mocked(currentGitHubLogin).mockResolvedValue("different-account");
      if (change === "owner changed") remote.owner = "different-owner";
      if (change === "unauthorized" || change === "forbidden") vi.mocked(readGistFile).mockRejectedValueOnce(fail(change === "unauthorized" ? 401 : 403));
      await idle();
      expect(await status(doc.id)).toMatchObject({ enabled: true, status: "failed", pending: true });
      expect(updateGist).not.toHaveBeenCalled();
      const lookups = vi.mocked(getGitHubToken).mock.calls.length;
      await setDocumentText(doc.id, "# Still safely saved\n");
      await idle(60_000);
      expect(getGitHubToken).toHaveBeenCalledTimes(lookups);
      expect(updateGist).not.toHaveBeenCalled();
      expect(await getDocumentContent(doc.id)).toBe("# Still safely saved\n");
    },
  );

  it("rechecks token identity after preflight before sending", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    const oldToken = randomUUID();
    const newToken = randomUUID();
    vi.mocked(getGitHubToken).mockReset().mockResolvedValueOnce(oldToken).mockResolvedValue(newToken);
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "failed" });
    expect(updateGist).not.toHaveBeenCalled();
  });

  it.each([429, 503])("pauses after a GitHub %i upload failure and retries only the latest saved version on POST", async (code) => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    githubPatch.mockRejectedValueOnce(fail(code));
    await idle();
    expect(await status(doc.id)).toMatchObject({ enabled: true, status: "failed", pending: true });
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect(files["notes.md"]).toBe(BASE);
    const latest = "# Latest saved version for explicit retry\n";
    await setDocumentText(doc.id, latest);
    await idle(60_000);
    expect(githubPatch).toHaveBeenCalledTimes(1);
    clearRemoteCalls();
    const previousGeneration = (await receipt(doc.id)).generation;
    await retry(doc.id);
    expect((await receipt(doc.id)).generation).not.toBe(previousGeneration);
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
    await runGistAutoUpdateQueue();
    expect(readGistFile).toHaveBeenCalledTimes(1);
    expect(updateGist).toHaveBeenCalledExactlyOnceWith(expect.anything(), "linked-gist", "notes.md", latest, undefined);
    expect(files["notes.md"]).toBe(latest);
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("does not turn explicit retry into force-overwrite when the conflict still exists", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    files["notes.md"] = "# Outside work\n";
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    await setDocumentText(doc.id, "# Latest unsent saved work\n");
    await retry(doc.id);
    await runGistAutoUpdateQueue();
    expect(await status(doc.id)).toMatchObject({ status: "conflict" });
    expect(files["notes.md"]).toBe("# Outside work\n");
    expect(updateGist).not.toHaveBeenCalled();
    files["notes.md"] = BASE;
    await retry(doc.id);
    await runGistAutoUpdateQueue();
    expect(files["notes.md"]).toBe("# Latest unsent saved work\n");
    expect(await status(doc.id)).toMatchObject({ status: "synced", pending: false });
  });

  it("rejects retry while off or when there is no paused failure", async () => {
    const doc = await linkedDoc();
    expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(409);
    await enable(doc.id);
    expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(409);
    await idle();
    expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(409);
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("sanitizes failed provider payloads in status and logs while retaining the document", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    const privateText = `# ${randomUUID()}\n`;
    const credential = randomUUID();
    await setDocumentText(doc.id, privateText);
    githubPatch.mockRejectedValueOnce(Object.assign(new Error(`${credential} ${privateText}`), {
      status: 503, request: { headers: { authorization: credential }, body: privateText },
    }));
    await idle();
    const report = await status(doc.id);
    expect(report).toMatchObject({ status: "failed", pending: true });
    const output = JSON.stringify({ report, errors: vi.mocked(console.error).mock.calls, warnings: vi.mocked(console.warn).mock.calls });
    expect(output.includes(credential)).toBe(false);
    expect(output.includes(privateText.trim())).toBe(false);
    expect(await getDocumentContent(doc.id)).toBe(privateText);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
  });

  it("pauses an interrupted syncing receipt rather than resending a write with an unknown result", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    const job = await receipt(doc.id);
    const db = await getDb();
    await db.update(schema.gistAutoUpdates).set({ status: "syncing", activeVersion: job.queuedVersion }).where(eq(schema.gistAutoUpdates.documentId, doc.id));
    clearRemoteCalls();
    await idle();
    expect(await status(doc.id)).toMatchObject({ enabled: true, status: "failed", pending: true, message: expect.stringContaining("interrupted") });
    expect(await receipt(doc.id)).toMatchObject({ activeVersion: null, queuedVersion: job.queuedVersion });
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("reports post-publish history failure without logging database content parameters", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    const privateText = `# ${randomUUID()}\n`;
    await setDocumentText(doc.id, privateText);
    const documents = await import("@/server/documents");
    vi.spyOn(documents, "addVersion").mockRejectedValueOnce(Object.assign(new Error(privateText), { params: [privateText] }));
    await idle();
    const report = await status(doc.id);
    expect(report).toMatchObject({ status: "synced", message: expect.stringContaining("version history") });
    expect(files["notes.md"]).toBe(privateText);
    expect(await getPublishedContent(doc.id)).toBe(privateText);
    const output = JSON.stringify({ report, errors: vi.mocked(console.error).mock.calls });
    expect(output.includes(privateText.trim())).toBe(false);
  });
});

describe("one-way publishing boundaries and lifecycle", () => {
  it("honestly models the acknowledged GET/PATCH race: an external write in that gap can be overwritten", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    clearRemoteCalls();
    githubPatch.mockImplementationOnce(async (input) => {
      expect(readGistFile).toHaveBeenCalledTimes(1);
      files["notes.md"] = "# External edit after preflight GET, before PATCH\n";
      remote.revision = "outside-gap-revision";
      return applyRemotePatch(input);
    });
    await idle();
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await status(doc.id)).toMatchObject({ status: "synced" });
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
  });

  it("prevents PATCH when disabled during a deferred preflight", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    vi.mocked(readGistFile).mockImplementationOnce(async () => {
      const snapshot = { ...remote, content: files["notes.md"] };
      started.resolve();
      await release.promise;
      return snapshot;
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await disable(doc.id);
      await setDocumentText(doc.id, "# Saved after disabling\n");
    } finally {
      release.resolve();
      await running;
    }
    await idle(60_000);
    expect(updateGist).not.toHaveBeenCalled();
    expect(await status(doc.id)).toMatchObject({ enabled: false, status: "off", pending: false });
    expect(await getDocumentContent(doc.id)).toBe("# Saved after disabling\n");
    expect(files["notes.md"]).toBe(BASE);
  });

  it("fences a late preflight completion after queue cancellation", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    const cancellation = new AbortController();
    vi.mocked(readGistFile).mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return { ...remote, content: files["notes.md"] };
    });
    const running = runGistAutoUpdateQueue(cancellation.signal);
    const canceled = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    cancellation.abort();
    release.resolve();
    await canceled;
    expect(updateGist).not.toHaveBeenCalled();
    expect(await receipt(doc.id)).toMatchObject({ status: "syncing", syncedVersion: 0 });
    await runGistAutoUpdateQueue();
    expect(await status(doc.id)).toMatchObject({ status: "failed", message: expect.stringContaining("interrupted") });
    expect(updateGist).not.toHaveBeenCalled();
  });

  it("does not record or label a late successful HTTP response after cancellation", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    const cancellation = new AbortController();
    githubPatch.mockImplementationOnce(async (input) => {
      const result = await applyRemotePatch(input);
      started.resolve();
      await release.promise;
      return result;
    });
    const running = runGistAutoUpdateQueue(cancellation.signal);
    const canceled = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    cancellation.abort();
    await setDocumentText(doc.id, "# Saved during shutdown\n");
    release.resolve();
    await canceled;
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect(await getDocumentContent(doc.id)).toBe("# Saved during shutdown\n");
    expect(await receipt(doc.id)).toMatchObject({ status: "syncing", syncedVersion: 0 });
    expect(files["notes.md"]).toBe(SAVED);
    await idle();
    expect(await status(doc.id)).toMatchObject({ status: "failed" });
    expect(updateGist).toHaveBeenCalledTimes(1);
  });

  it("stopping the worker aborts an in-flight HTTP request and does not automatically retry its unknown outcome", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    let requestSignal: AbortSignal | undefined;
    githubPatch.mockImplementationOnce(async (input) => {
      await applyRemotePatch(input);
      const signal = vi.mocked(githubClient).mock.calls.at(-1)?.[1];
      if (!signal) throw new Error("Missing automatic publication request signal");
      requestSignal = signal;
      started.resolve();
      return new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    startGistAutoUpdateWorker();
    try {
      await vi.advanceTimersByTimeAsync(250);
      await started.promise;
      await stopGistAutoUpdateWorker();
      expect(requestSignal?.aborted).toBe(true);
      expect(await receipt(doc.id)).toMatchObject({ status: "syncing", syncedVersion: 0 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(updateGist).toHaveBeenCalledTimes(1);
      expect(await getPublishedContent(doc.id)).toBe(BASE);
      await runGistAutoUpdateQueue();
      expect(await status(doc.id)).toMatchObject({ status: "failed" });
    } finally {
      await stopGistAutoUpdateWorker();
    }
  });

  it("cannot initiate a send while a competing disable owns the settings lock", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const db = await getDb();
    await withGistSettingsLock(doc.id, async () => {
      await runGistAutoUpdateQueue();
      expect(updateGist).not.toHaveBeenCalled();
      await db.update(schema.gistAutoUpdates).set({ enabled: false, status: "off" })
        .where(eq(schema.gistAutoUpdates.documentId, doc.id));
    });
    expect(await status(doc.id)).toMatchObject({ enabled: false, status: "off" });
    await idle(60_000);
    expect(updateGist).not.toHaveBeenCalled();
    expect(files["notes.md"]).toBe(BASE);
  });

  it("keeps the destination locked until HTTP settles even if the dispatch lock fails after initiation", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    const settingsFailed = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const database = await import("@/server/db");
    vi.spyOn(database, "withGistSettingsLock").mockImplementationOnce(async (id, fn) => {
      const result = await withGistSettingsLock(id, fn);
      if (!result.acquired) return result;
      settingsFailed.resolve();
      throw new Error("Fixture dispatch coordination loss");
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await settingsFailed.promise;
      await runGistAutoUpdateQueue();
      expect(updateGist).toHaveBeenCalledTimes(1);
      expect(await status(doc.id)).toMatchObject({ status: "syncing" });
    } finally {
      release.resolve();
      await running;
    }
    expect(await status(doc.id)).toMatchObject({ status: "failed" });
    expect(updateGist).toHaveBeenCalledTimes(1);
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect(files["notes.md"]).toBe(SAVED);
  });

  it("allows an already-sent upload to finish after disable, but leaves no next queued send", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      const result = await applyRemotePatch(input);
      started.resolve();
      await release.promise;
      return result;
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      await disable(doc.id);
      expect(await status(doc.id)).toMatchObject({ status: "off", message: expect.stringContaining("may still finish") });
      await setDocumentText(doc.id, "# Next saved text stays local\n");
    } finally {
      release.resolve();
      await running;
    }
    await idle(60_000);
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getDocumentContent(doc.id)).toBe("# Next saved text stays local\n");
    expect(await status(doc.id)).toMatchObject({ enabled: false, status: "off", pending: false });
  });

  it("does not let an old completion change a replacement destination's baseline or generation", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      const result = await applyRemotePatch(input);
      started.resolve();
      await release.promise;
      return result;
    });
    const running = runGistAutoUpdateQueue();
    const db = await getDb();
    const generation = randomUUID();
    try {
      await started.promise;
      // Model a replacement grant after coordination loss while the old HTTP result is delayed.
      await db.transaction(async (tx) => {
        await tx.update(schema.documents).set({
          gistId: "new-gist", gistFile: "new.md", publishedContent: "# New destination\n", githubSha: "new-revision",
        }).where(eq(schema.documents.id, doc.id));
        await tx.update(schema.gistAutoUpdates).set({
          generation, gistId: "new-gist", filename: "new.md", enabled: true,
          status: "pending", queuedVersion: 1, syncedVersion: 0, activeVersion: null,
        }).where(eq(schema.gistAutoUpdates.documentId, doc.id));
      });
    } finally {
      release.resolve();
      await running;
    }
    expect((await savedDoc(doc.id)).githubSha).toBe("new-revision");
    expect(await getPublishedContent(doc.id)).toBe("# New destination\n");
    expect(await receipt(doc.id)).toMatchObject({ generation, status: "pending", syncedVersion: 0 });
    expect(updateGist).toHaveBeenCalledTimes(1);
  });

  it("keeps an interrupted claim paused even if its delayed provider response later arrives", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      const result = await applyRemotePatch(input);
      started.resolve();
      await release.promise;
      return result;
    });
    const running = runGistAutoUpdateQueue();
    const db = await getDb();
    try {
      await started.promise;
      await db.update(schema.gistAutoUpdates).set({
        status: "failed", activeVersion: null, message: "Interrupted claim requires review",
      }).where(eq(schema.gistAutoUpdates.documentId, doc.id));
    } finally {
      release.resolve();
      await running;
    }
    expect(await status(doc.id)).toMatchObject({ status: "failed", message: "Interrupted claim requires review" });
    expect(await getPublishedContent(doc.id)).toBe(BASE);
    expect((await receipt(doc.id)).syncedVersion).toBe(0);
    expect(files["notes.md"]).toBe(SAVED);
  });

  it("disables idempotently without credentials and never queues future saves", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    clearRemoteCalls();
    vi.mocked(getGitHubToken).mockResolvedValue(null);
    await disable(doc.id);
    await disable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await idle(60_000);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
  });

  it("requires unlink to wait for the destination lock, then stops the queue without losing saved text", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    await vi.advanceTimersByTimeAsync(2000);
    const started = deferred();
    const release = deferred();
    githubPatch.mockImplementationOnce(async (input) => {
      started.resolve();
      await release.promise;
      return applyRemotePatch(input);
    });
    const running = runGistAutoUpdateQueue();
    try {
      await started.promise;
      expect((await relink(doc.id, { storage: "local" })).status).toBe(409);
      expect((await savedDoc(doc.id)).storage).toBe("gist");
      await disable(doc.id);
    } finally {
      release.resolve();
      await running;
    }
    expect((await relink(doc.id, { storage: "local" })).status).toBe(200);
    expect((await getDocumentAccess(doc.id, owner))?.doc.storage).toBe("local");
    expect(await status(doc.id)).toEqual(OFF);
    await setDocumentText(doc.id, "# Saved after unlink\n");
    await idle(60_000);
    expect(githubPatch).toHaveBeenCalledTimes(1);
    expect(await getDocumentContent(doc.id)).toBe("# Saved after unlink\n");
  });

  it("disables a queued update when linked to a different existing destination", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    vi.mocked(readGistFile).mockResolvedValueOnce({ ...remote, gistId: "new-gist", filename: "new.md", htmlUrl: "https://gist.github.com/new-gist" });
    expect((await relink(doc.id, { storage: "gist", gistId: "new-gist", filename: "new.md" })).status).toBe(200);
    expect(await status(doc.id)).toEqual(OFF);
    expect(await receipt(doc.id)).toMatchObject({ enabled: false, status: "off" });
    await idle(60_000);
    expect(updateGist).not.toHaveBeenCalled();
    expect(await getDocumentContent(doc.id)).toBe(SAVED);
  });

  it.each(["storage", "gist", "filename", "owner", "trash"] as const)("the save trigger disables consent after a %s change", async (change) => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    clearRemoteCalls();
    if (change === "storage") await updateDocument(doc.id, { storage: "local" });
    if (change === "gist") await updateDocument(doc.id, { gistId: "new-gist" });
    if (change === "filename") await updateDocument(doc.id, { gistFile: "new.md" });
    if (change === "owner") await updateDocument(doc.id, { ownerId: other.id });
    if (change === "trash") await deleteDocument(doc.id);
    expect(await receipt(doc.id)).toMatchObject({ enabled: false, status: "off" });
    expect(await gistAutoUpdateStatus(await savedDoc(doc.id))).toMatchObject({ enabled: false, status: "off", pending: false });
    if (change === "owner") {
      expect((await receipt(doc.id)).publisherId).toBe(owner.id);
      actor = other;
      expect(await status(doc.id)).toEqual(OFF);
      expect((await POST(request(doc.id, "POST"), params(doc.id))).status).toBe(409);
    }
    await idle(60_000);
    expect(getGitHubToken).not.toHaveBeenCalled();
    expect(readGistFile).not.toHaveBeenCalled();
    expect(updateGist).not.toHaveBeenCalled();
    expect((await savedDoc(doc.id)).content).toBe(SAVED);
  });
});

describe("persisted clean snapshots rather than unsaved live memory", () => {
  it("never consults readLiveText for an automatic upload", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await setDocumentText(doc.id, SAVED);
    vi.mocked(readLiveText).mockResolvedValueOnce({
      text: "# Unsaved live content\n", clean: "# Unsaved live content\n", title: "Unsaved title", pendingSuggestions: 0, openComments: 0,
    });
    await idle();
    expect(readLiveText).not.toHaveBeenCalled();
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getPublishedContent(doc.id)).toBe(SAVED);
  });

  it.each([true, false])("selects the stored snapshot with authoritative ystate present=%s", async (hasState) => {
    const doc = await linkedDoc();
    await enable(doc.id);
    await updateDocument(doc.id, {
      content: hasState ? "# Stale denormalized text\n" : SAVED,
      ystate: hasState ? encodeSeedState(SAVED, doc.title) : null,
    });
    await idle();
    expect(files["notes.md"]).toBe(SAVED);
    expect(await getPublishedContent(doc.id)).toBe(SAVED);
    expect(readLiveText).not.toHaveBeenCalled();
  });

  it("excludes pending inserted suggestions and keeps pending deletions in the published clean text", async () => {
    const doc = await linkedDoc();
    await enable(doc.id);
    const accepted = "# Local fixture\n\nAccepted paragraph.\n";
    const snapshot = new Y.Doc();
    hydrateDoc(snapshot, null, accepted, doc.title);
    const ytext = snapshot.getText(TEXT_KEY);
    const suggestions = new SuggestionsModel(snapshot, ytext);
    try {
      const from = accepted.indexOf("Accepted");
      suggestions.applyEdit({ from, to: from + "Accepted".length, insert: "Unapproved" }, {
        id: other.id, name: "Other", color: "#123456", colorLight: "#abcdef",
      });
      expect(suggestions.list()).toHaveLength(2);
      expect(suggestions.cleanText()).toBe(accepted);
      await updateDocument(doc.id, { content: ytext.toString(), ystate: Y.encodeStateAsUpdate(snapshot) });
    } finally {
      suggestions.destroy();
      snapshot.destroy();
    }
    await idle();
    expect(files["notes.md"]).toBe(accepted);
    expect(await getPublishedContent(doc.id)).toBe(accepted);
    expect(await getDocumentContent(doc.id)).toContain("Unapproved");
    expect(readLiveText).not.toHaveBeenCalled();
  });
});
