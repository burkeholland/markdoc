import { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGist, currentGitHubLogin, readGistFile, updateGist } from "./index";
import { mockGetGist, mockReset, mockSetGistFile } from "./mock";

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

beforeEach(() => {
  vi.stubEnv("GITHUB_MOCK", "1");
  mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("gist destination contract", () => {
  it("shares mock destinations and revisions between route and worker module copies", async () => {
    mockSetGistFile("shared-gist", "notes.md", "Before");
    vi.resetModules();
    const workerMock = await import("./mock");
    expect(workerMock.mockGetGist("shared-gist")).toBe(mockGetGist("shared-gist"));
    await workerMock.mockGithub.updateGist("shared-gist", "notes.md", "After");
    expect(mockGetGist("shared-gist")?.files.get("notes.md")).toBe("After");
    const routeCreated = await createGist(new Octokit(), { filename: "route.md", content: "Route", isPublic: false });
    const workerCreated = await workerMock.mockGithub.createGist({ filename: "worker.md", content: "Worker", isPublic: false });
    expect(routeCreated.gistId).not.toBe(workerCreated.gistId);
    workerMock.mockReset();
    expect(mockGetGist("shared-gist")).toBeNull();
  });

  it("the mock refuses an exact filename that disappeared instead of selecting an unrelated file", async () => {
    mockSetGistFile("gist", "other.md", "Unrelated work");
    await expect(readGistFile(new Octokit(), "gist", "missing.md")).rejects.toMatchObject({ status: 404 });
    expect((await readGistFile(new Octokit(), "gist")).filename).toBe("other.md");
  });

  it.each([false, true])("the mock preserves public=%s and unrelated files during a manual update", async (isPublic) => {
    const client = new Octokit();
    const created = await createGist(client, { filename: "notes.md", content: "Before", isPublic });
    mockSetGistFile(created.gistId, "other.md", "Unrelated work");
    await updateGist(client, created.gistId, "notes.md", "After");
    expect((await readGistFile(client, created.gistId, "notes.md")).isPublic).toBe(isPublic);
    expect(mockGetGist(created.gistId)?.files.get("other.md")).toBe("Unrelated work");
    expect(await currentGitHubLogin(client)).toBe("mock");
  });

  it("the real adapter PATCHes only the linked file without changing visibility or inventing a revision condition", async () => {
    vi.stubEnv("GITHUB_MOCK", "");
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      html_url: "https://gist.github.com/fixture", updated_at: "2026-09-05T00:00:00Z", history: [{ version: "after" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new Octokit({ request: { fetch: transport } });
    const result = await updateGist(client, "fixture", "notes.md", "Saved content");
    expect(result.revision).toBe("after");
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.github.com/gists/fixture");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ files: { "notes.md": { content: "Saved content" } } });
    expect(new Headers(init?.headers).has("If-Match")).toBe(false);
  });

  it("marks missing inline content and visibility as unknown rather than a verified empty secret gist", async () => {
    vi.stubEnv("GITHUB_MOCK", "");
    const transport = vi.fn(async () => new Response(JSON.stringify({
      id: "fixture", owner: { login: "owner" }, files: { "notes.md": { filename: "notes.md" } },
      history: [{ version: "before" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = await readGistFile(new Octokit({ request: { fetch: transport } }), "fixture", "notes.md");
    expect(file.contentKnown).toBe(false);
    expect(file.visibilityKnown).toBe(false);
    expect(transport).toHaveBeenCalledOnce();
  });
});
