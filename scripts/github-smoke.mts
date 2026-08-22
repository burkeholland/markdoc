// GitHub integration smoke test. Needs a running server with GITHUB_TOKEN set (dev login) and `gh` authenticated.
// Usage: BASE_URL=http://localhost:3100 npx tsx scripts/github-smoke.mts
import { chromium, expect } from "@playwright/test";
import { execSync } from "node:child_process";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const scratch = process.env.SCRATCH_REPO ?? "burkeholland/markdoc-scratch";
const [owner, repo] = scratch.split("/");
const token = execSync("gh auth token", { encoding: "utf8" }).trim();

async function ghApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "markdoc-smoke" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
type Gist = { files: Record<string, { content: string }> };
type Contents = { content: string; sha: string };
const gistFile = async (id: string, name: string) => (await ghApi<Gist>("GET", `/gists/${id}`)).files[name].content;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/login`);
await page.getByTestId("dev-login").fill("ghsmoke");
await page.getByTestId("dev-login-submit").click();
await page.waitForURL(`${base}/`);
const api = page.request;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Awaited<ReturnType<typeof api.get>>): Promise<any> => {
  const body = await r.text();
  if (!r.ok()) throw new Error(`${r.status()} ${body}`);
  return JSON.parse(body);
};
const liveText = () => page.evaluate(() => (window as unknown as { __markdocSession: { ytext: { toString(): string } } }).__markdocSession.ytext.toString());

console.log("== gists");
const gists = await json(await api.get(`${base}/api/github/gists`));
console.log("markdown gists:", gists.gists.length);

console.log("== create doc + link to new secret gist");
const created = await json(await api.post(`${base}/api/documents`, { data: { content: "# Gist test\n\nHello from Markdoc.\n" } }));
const docId = created.document.id as string;
const linked = await json(await api.post(`${base}/api/documents/${docId}/link`, { data: { storage: "gist", filename: "markdoc-smoke.md", isPublic: false } }));
const gistId = linked.document.gistId as string;
console.log("gist:", gistId, linked.document.githubUrl);
expect(await gistFile(gistId, "markdoc-smoke.md")).toBe("# Gist test\n\nHello from Markdoc.\n");

console.log("== publish after edit");
await page.goto(`${base}/d/${docId}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 30000 });
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.keyboard.type("\nSecond line.");
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]');
const pub = await json(await api.post(`${base}/api/documents/${docId}/publish`, { data: { message: "smoke publish" } }));
console.log("published:", pub.result);
expect(await gistFile(gistId, "markdoc-smoke.md")).toContain("Second line.");
expect(pub.document.hasUnpublishedChanges).toBe(false);

console.log("== pull after remote change");
await ghApi("PATCH", `/gists/${gistId}`, { files: { "markdoc-smoke.md": { content: "# Gist test\n\nChanged on GitHub.\n" } } });
const pulled = await json(await api.post(`${base}/api/documents/${docId}/pull`));
console.log("pull:", pulled.result);
expect(pulled.result.changed).toBe(true);
await expect.poll(liveText).toContain("Changed on GitHub.");
console.log("live editor shows pulled text OK");

console.log("== repo: link new file, publish, pull");
const repoDoc = await json(await api.post(`${base}/api/documents`, { data: { content: "# Repo test\n\nFrom Markdoc.\n" } }));
const branches = await json(await api.get(`${base}/api/github/repos/${owner}/${repo}/branches`));
console.log("branches:", branches.branches);
const branch = branches.branches[0] as string;
const files = await json(await api.get(`${base}/api/github/repos/${owner}/${repo}/files?ref=${branch}`));
console.log("markdown files:", files.files.map((f: { path: string }) => f.path));
const path = `docs/smoke-${Date.now()}.md`;
const linkedRepo = await json(await api.post(`${base}/api/documents/${repoDoc.document.id}/link`, { data: { storage: "repo", owner, repo, branch, path } }));
console.log("linked:", linkedRepo.document.repoPath, "publishedAt:", linkedRepo.document.publishedAt);
const pubRepo = await json(await api.post(`${base}/api/documents/${repoDoc.document.id}/publish`, { data: { message: "smoke: add note" } }));
console.log("commit:", pubRepo.result.commitSha, pubRepo.result.url);
expect(pubRepo.result.commitSha).toBeTruthy();
const remote = await ghApi<Contents>("GET", `/repos/${scratch}/contents/${path}?ref=${branch}`);
expect(Buffer.from(remote.content.replace(/\n/g, ""), "base64").toString("utf8")).toBe("# Repo test\n\nFrom Markdoc.\n");

// Change it on GitHub, then pull.
const newContent = Buffer.from("# Repo test\n\nEdited on GitHub.\n").toString("base64");
await ghApi("PUT", `/repos/${scratch}/contents/${path}`, { message: "remote edit", content: newContent, sha: remote.sha, branch });
const pulledRepo = await json(await api.post(`${base}/api/documents/${repoDoc.document.id}/pull`));
expect(pulledRepo.result.changed).toBe(true);
const exported = await (await api.get(`${base}/api/documents/${repoDoc.document.id}/export`)).text();
expect(exported).toBe("# Repo test\n\nEdited on GitHub.\n");
console.log("repo pull OK");

// Publish again with no local changes is a no-op.
const pub2 = await json(await api.post(`${base}/api/documents/${repoDoc.document.id}/publish`, { data: { message: "smoke: noop" } }));
expect(pub2.result.skipped).toBe(true);
console.log("no-op publish skipped OK");

// Conflict detection: change on GitHub again, edit locally, publish must fail with 409.
const latest = await ghApi<Contents>("GET", `/repos/${scratch}/contents/${path}?ref=${branch}`);
await ghApi("PUT", `/repos/${scratch}/contents/${path}`, { message: "conflicting remote edit", content: Buffer.from("# Repo test\n\nConflict.\n").toString("base64"), sha: latest.sha, branch });
await page.goto(`${base}/d/${repoDoc.document.id}`);
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]', { timeout: 30000 });
await page.locator(".cm-content").click();
await page.keyboard.press("Control+End");
await page.keyboard.type("\nLocal edit.");
await page.waitForSelector('[data-testid="save-state"][data-state="saved"]');
const conflict = await api.post(`${base}/api/documents/${repoDoc.document.id}/publish`, { data: { message: "should conflict" } });
console.log("conflict status:", conflict.status(), (await conflict.json()).error);
expect(conflict.status()).toBe(409);

console.log("== import from gist and repo");
const imp1 = await json(await api.post(`${base}/api/import`, { data: { source: "gist", gistId } }));
expect((await (await api.get(`${base}/api/documents/${imp1.document.id}/export`)).text()).trim()).toBe("# Gist test\n\nChanged on GitHub.");
const imp2 = await json(await api.post(`${base}/api/import`, { data: { source: "repo", owner, repo, branch, path: "docs/seed.md" } }));
const seed = await (await api.get(`${base}/api/documents/${imp2.document.id}/export`)).text();
expect(seed).toContain("# Scratch");
console.log("imports OK:", imp1.document.title, "|", imp2.document.title);

console.log("== versions recorded");
const versions = await json(await api.get(`${base}/api/documents/${repoDoc.document.id}/versions`));
console.log(versions.versions.map((v: { kind: string; title: string | null }) => `${v.kind}:${v.title}`));
expect(versions.versions.some((v: { kind: string }) => v.kind === "publish")).toBe(true);

console.log("== cleanup");
await ghApi("DELETE", `/gists/${gistId}`);
console.log("gist deleted; scratch repo kept at", scratch);
await browser.close();
console.log("ALL GOOD");
