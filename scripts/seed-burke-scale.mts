// Seed a running Markdoc dev server with the Burke-scale fixture (e2e/fixtures/burke-scale.ts):
// 60 documents (one ~12k-word hero doc with 25 comment threads), 10 starred, 8 in the trash,
// 12 shared with a second user, plus an API token — all through the public API, so the lead can
// load it on a throwaway server and look at the app with real volume.
//
//   PORT=3870 npm run dev:port                                   # terminal 1
//   MARKDOC_URL=http://localhost:3870 npm run seed:burke-scale   # terminal 2
//
// Environment / flags:
//   MARKDOC_URL    server to seed (default http://localhost:3870)
//   SEED_OWNER     dev-login handle that owns the documents (default burke)
//   SEED_PEER      dev-login handle the 12 shared documents go to (default burke-peer)
//   --yes          required to seed anything on port 3000 (Burke's live server)
//
// Needs AUTH_DEV_LOGIN on the target (dev:port sets it). Exits non-zero on the first failed call.

import { seedBurkeScale, type SeedRequest, type SeedRequestOptions, type SeedResponse } from "../e2e/fixtures/burke-scale";

const args = new Set(process.argv.slice(2));
const base = (process.env.MARKDOC_URL ?? "http://localhost:3870").replace(/\/$/, "");
const owner = process.env.SEED_OWNER ?? "burke";
const peer = process.env.SEED_PEER ?? "burke-peer";

const url = new URL(base);
if ((url.port || (url.protocol === "https:" ? "443" : "80")) === "3000" && !args.has("--yes")) {
  console.error(`[seed:burke-scale] ${base} is port 3000 (the live server). Pass --yes if you really mean it.`);
  process.exit(2);
}

/** Minimal cookie jar so the dev-login session survives across fetch() calls. */
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

function wrap(res: Response): SeedResponse {
  let text: Promise<string> | null = null;
  const body = () => (text ??= res.text());
  return {
    ok: () => res.ok,
    status: () => res.status,
    text: body,
    json: async () => JSON.parse(await body()) as unknown,
  };
}

function method(verb: string) {
  return async (path: string, options: SeedRequestOptions = {}): Promise<SeedResponse> => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    let body: BodyInit | undefined;
    if (options.data instanceof Uint8Array) {
      body = options.data as Uint8Array<ArrayBuffer>;
    } else if (options.data !== undefined) {
      headers["content-type"] ??= "application/json";
      body = JSON.stringify(options.data);
    }
    return wrap(await call(path, { method: verb, headers, body }));
  };
}

const client: SeedRequest = { get: method("GET"), post: method("POST"), put: method("PUT"), delete: method("DELETE") };

async function signIn(login: string) {
  const csrf = await call("/api/auth/csrf");
  if (csrf.status !== 200) throw new Error(`GET /api/auth/csrf -> ${csrf.status}; is the server up at ${base}?`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  await call("/api/auth/callback/dev", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, login, redirect: "false" }),
  });
  const me = await call("/api/me");
  if (me.status !== 200) throw new Error(`dev login as ${login} failed (GET /api/me -> ${me.status}); does the server have AUTH_DEV_LOGIN set?`);
  const { user } = (await me.json()) as { user: { login: string | null } };
  if (user.login !== login) throw new Error(`signed in as ${user.login}, expected ${login}`);
}

async function main() {
  console.log(`[seed:burke-scale] ${base} as @${owner} (sharing with @${peer})`);
  const health = await call("/api/health");
  if (health.status !== 200) throw new Error(`GET /api/health -> ${health.status}`);
  // The peer must exist as a user for shares and mentions to resolve in the UI: sign in once, then switch to the owner.
  await signIn(peer);
  jar.clear();
  await signIn(owner);

  const seed = await seedBurkeScale(client, { owner, peer }, { log: (line) => console.log(line) });
  console.log("");
  console.log(`  hero doc      ${base}/d/${seed.longDoc.id}  (${seed.commentLoad.totals.threads} threads)`);
  console.log(`  dashboard     ${base}/  (${seed.docs.length} docs: ${seed.docs.length - seed.trashedIds.length} listed, ${seed.starredIds.length} starred, ${seed.trashedIds.length} in trash, ${seed.sharedIds.length} shared with @${peer})`);
  console.log(`  token         ${seed.token ? `${seed.token.slice(0, 8)}… (owner, 30 days)` : "none"}`);
  console.log(`  elapsed       ${seed.elapsedMs} ms`);
}

main().catch((err) => {
  console.error(`[seed:burke-scale] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
