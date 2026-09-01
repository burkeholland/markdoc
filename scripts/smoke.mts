// API smoke test against a running Markdoc server (typically the production build started by
// `npm run start:local`). No browser: it signs in with the development login, exercises the
// REST surface that production has to get right (health and its DB-free `?probe=live` liveness
// answer, the JSON 404 catch-all for unknown `/api/*` paths, the MCP liveness card, templates,
// bytea assets, HTML export, PDF export twice in a row) and exits non-zero on the first failure.
//
//   npm run start:local                                     # terminal 1
//   BASE_URL=http://localhost:3900 npm run smoke             # terminal 2
//
// Environment:
//   BASE_URL           server to hit (default http://localhost:3900)
//   SMOKE_LOGIN        dev-login handle (default smoke-<random>)
//   SMOKE_PDF_OPTIONAL set to 1 to tolerate a 503 from PDF export (no Chromium on this host)

const base = (process.env.BASE_URL ?? "http://localhost:3900").replace(/\/$/, "");
const login = process.env.SMOKE_LOGIN ?? `smoke-${Date.now().toString(36)}`;
const pdfOptional = process.env.SMOKE_PDF_OPTIONAL === "1";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let failures = 0;
function ok(label: string, detail?: string) {
  console.log(`  ok   ${label}${detail ? `  (${detail})` : ""}`);
}
function fail(label: string, detail: string): never {
  failures++;
  console.error(`  FAIL ${label}: ${detail}`);
  throw new Error(`${label}: ${detail}`);
}
function check(cond: unknown, label: string, detail: string) {
  if (cond) ok(label, detail);
  else fail(label, detail);
}

/** Minimal cookie jar so the session survives across plain fetch() calls. */
const jar = new Map<string, string>();
function remember(res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const res = await fetch(`${base}${path}`, { ...init, headers, redirect: init.redirect ?? "manual" });
  remember(res);
  return res;
}

/** Body text plus its parse as a JSON object (`null` when it is not one, e.g. Next's HTML 404 page). */
async function readJson(res: Response): Promise<{ text: string; body: Record<string, unknown> | null }> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return { text, body: parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null };
  } catch {
    return { text, body: null };
  }
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n${name}`);
  return fn();
}

async function main() {
  console.log(`Markdoc smoke against ${base} as @${login}`);

  await step("health", async () => {
    const res = await call("/api/health");
    check(res.status === 200, "GET /api/health", `status ${res.status}`);
    const body = (await res.json()) as { ok: boolean; db: boolean; collab: boolean; version?: string };
    check(body.ok === true && body.db === true, "database reachable", JSON.stringify(body));
    check(body.collab === true, "collaboration server registered", `collab=${body.collab}`);

    // The Liveness probe (infra/main.bicep) hits this every 30 s: it answers from the process alone,
    // so the body carries `probe: "live"` and none of the database fields (`db`, `latencyMs`).
    const live = await call("/api/health?probe=live");
    const probe = await readJson(live);
    check(
      live.status === 200 && probe.body?.ok === true && probe.body.probe === "live" && !("db" in probe.body) && !("latencyMs" in probe.body),
      "GET /api/health?probe=live",
      `status ${live.status} ${probe.body ? JSON.stringify(probe.body) : JSON.stringify(probe.text.slice(0, 120))}`,
    );
  });

  await step("unauthenticated API surface", async () => {
    // Unknown `/api/*` paths are answered by the `[...rest]` catch-all with JSON, never Next's HTML 404
    // page (agents parse the body). A random suffix keeps the row repeat-safe and cache-proof.
    const missing = `/api/nonexistent-${Math.random().toString(36).slice(2, 10)}`;
    const nf = await call(missing);
    const nfType = nf.headers.get("content-type") ?? "none";
    const notFound = await readJson(nf);
    check(
      nf.status === 404 && nfType.startsWith("application/json") && typeof notFound.body?.error === "string" && notFound.body.path === missing,
      `GET ${missing}`,
      `status ${nf.status} ${nfType} ${notFound.body ? JSON.stringify(notFound.body) : JSON.stringify(notFound.text.slice(0, 120))}`,
    );

    // Same expectation as e2e/share-agent.spec.ts ("The URL in the card is live"): a plain GET is the
    // liveness card, name "markdoc", tools > 0.
    const mcp = await call("/api/mcp");
    const alive = await readJson(mcp);
    check(
      mcp.ok && alive.body?.name === "markdoc" && typeof alive.body.tools === "number" && alive.body.tools > 0,
      "GET /api/mcp (alive)",
      `status ${mcp.status} ${alive.body ? `name=${JSON.stringify(alive.body.name)} tools=${alive.body.tools}` : JSON.stringify(alive.text.slice(0, 120))}`,
    );
  });

  await step("sign in (development login)", async () => {
    const csrfRes = await call("/api/auth/csrf");
    check(csrfRes.status === 200, "GET /api/auth/csrf", `status ${csrfRes.status}`);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const form = new URLSearchParams({ csrfToken, login, redirect: "false" });
    const res = await call("/api/auth/callback/dev", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const hasSession = [...jar.keys()].some((k) => k.endsWith("authjs.session-token"));
    check(
      hasSession,
      "session cookie issued",
      hasSession ? `status ${res.status}` : `status ${res.status}; cookies: ${[...jar.keys()].join(", ") || "none"}. Is AUTH_DEV_LOGIN set to "force" for this production server?`,
    );
    const me = await call("/api/me");
    check(me.status === 200, "GET /api/me", `status ${me.status}`);
    const { user } = (await me.json()) as { user: { login: string | null } };
    check(user.login === login, "signed in as the right user", `login=${user.login}`);
  });

  await step("dashboard", async () => {
    const res = await call("/");
    check(res.status === 200, "GET /", `status ${res.status}`);
    const html = await res.text();
    check(/data-testid="(new-document|empty-state|document-list)"/.test(html), "dashboard HTML renders the document list or empty state", `${html.length} bytes`);
  });

  const docId = await step("create a document from a template", async () => {
    const list = await call("/api/templates");
    check(list.status === 200, "GET /api/templates", `status ${list.status}`);
    const { templates } = (await list.json()) as { templates: { id: string }[] };
    check(templates.some((t) => t.id === "meeting-notes"), "meeting-notes template offered", `${templates.length} templates`);
    const res = await call("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template: "meeting-notes" }),
    });
    check(res.status === 201, "POST /api/documents {template}", `status ${res.status}`);
    const { document } = (await res.json()) as { document: { id: string; title: string } };
    check(document.title === "Meeting notes", "template title applied", `id=${document.id} title=${JSON.stringify(document.title)}`);
    const content = await call(`/api/documents/${document.id}/content`);
    check(content.status === 200, "GET /api/documents/:id/content", `status ${content.status}`);
    const { content: text } = (await content.json()) as { content: string };
    check(text.includes("Action items") && text.includes(`@${login}`) && !text.includes("{{"), "placeholders filled", `${text.length} chars`);
    return document.id;
  });

  const assetUrl = await step("upload a PNG asset and read it back", async () => {
    const res = await call(`/api/documents/${docId}/assets?name=dot.png`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG,
    });
    check(res.status === 201, "POST /api/documents/:id/assets", `status ${res.status}`);
    const asset = (await res.json()) as { id: string; url: string; mime: string; size: number };
    check(asset.mime === "image/png" && asset.size === PNG.length, "asset metadata", JSON.stringify(asset));
    const get = await call(asset.url);
    check(get.status === 200, `GET ${asset.url}`, `status ${get.status}`);
    check(get.headers.get("content-type") === "image/png", "asset content-type", get.headers.get("content-type") ?? "none");
    const bytes = Buffer.from(await get.arrayBuffer());
    check(bytes.equals(PNG), "asset bytes round-trip through bytea", `${bytes.length} bytes`);
    return asset.url;
  });

  await step("export", async () => {
    // Put the image in the document so HTML/PDF export has to inline a bytea asset.
    const put = await call(`/api/documents/${docId}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `# Meeting notes\n\nSmoke run for @${login}.\n\n![dot](${assetUrl})\n\n## Action items\n\n- [ ] ship it\n`,
      }),
    });
    check(put.status < 300, "PUT /api/documents/:id/content", `status ${put.status}`);

    const md = await call(`/api/documents/${docId}/export?format=md`);
    check(md.status === 200 && (await md.text()).includes("Smoke run"), "export md", `status ${md.status}`);

    const html = await call(`/api/documents/${docId}/export?format=html&download=1`);
    check(html.status === 200, "export html", `status ${html.status} ${html.headers.get("content-type")}`);
    const page = await html.text();
    check(page.includes("Action items") && page.includes("data:image/png;base64,"), "html export inlines the asset", `${page.length} bytes`);

    const pdf = await call(`/api/documents/${docId}/export?format=pdf`);
    if (pdf.status === 503 && pdfOptional) {
      console.log("  skip export pdf (503: Chromium not available; SMOKE_PDF_OPTIONAL=1)");
      return;
    }
    check(pdf.status === 200, "export pdf", `status ${pdf.status} ${pdf.status === 503 ? await pdf.text() : ""}`.trim());
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    const head = pdfBytes.subarray(0, 5).toString("latin1");
    check(head === "%PDF-", "pdf magic bytes", JSON.stringify(head));

    // Straight away a second export: it is served by the shared Chromium the first one launched (the reuse
    // itself is unit-tested in src/server/export/pdf-handle.test.ts); here two exports in a row must both answer.
    const startedAt = Date.now();
    const again = await call(`/api/documents/${docId}/export?format=pdf`);
    if (again.status === 503 && pdfOptional) {
      console.log("  skip export pdf (second) (503: Chromium not available; SMOKE_PDF_OPTIONAL=1)");
      return;
    }
    const againBytes = Buffer.from(await again.arrayBuffer());
    const elapsedMs = Date.now() - startedAt;
    const againType = again.headers.get("content-type") ?? "none";
    check(
      again.status === 200 && againType.startsWith("application/pdf") && againBytes.subarray(0, 5).toString("latin1") === "%PDF-",
      "GET /api/documents/:id/export?format=pdf (second)",
      `status ${again.status} ${againType}; ${pdfBytes.length} then ${againBytes.length} bytes; ${elapsedMs} ms` +
        (again.status === 200 ? "" : ` ${JSON.stringify(againBytes.toString("utf8").slice(0, 120))}`),
    );
  });

  await step("cleanup", async () => {
    const res = await call(`/api/documents/${docId}`, { method: "DELETE" });
    check(res.status < 300, "DELETE /api/documents/:id", `status ${res.status}`);
  });
}

main()
  .then(() => {
    console.log(`\nSMOKE PASSED against ${base}`);
  })
  .catch((err) => {
    if (failures === 0) console.error(`\n  FAIL ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nSMOKE FAILED against ${base}`);
    // Exit naturally like the success path: `process.exit()` right after a few keep-alive fetches trips a
    // libuv assertion on Windows (Node 24, `UV_HANDLE_CLOSING` in async.c) and exits -1073740791 instead of 1.
    process.exitCode = 1;
  });
