import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { NextAuthConfig } from "next-auth";

// `next-auth` itself cannot be loaded here (it imports `next/server` in a way only Next resolves). Its
// route handlers are a thin wrapper, repeated below: the configuration `src/auth.ts` builds, the same
// defaults from the environment, and the Auth.js core that does all of the work.
vi.mock("next-auth", async () => {
  const { Auth, setEnvDefaults } = await import("@auth/core");
  return {
    default: (config: () => Promise<NextAuthConfig>) => {
      const handle = async (request: Request) => {
        const built = await config();
        built.secret ??= process.env.AUTH_SECRET;
        built.basePath ||= "/api/auth";
        setEnvDefaults(process.env, built, true);
        return Auth(request, built);
      };
      return { handlers: { GET: handle, POST: handle }, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
    },
  };
});

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;
delete process.env.AUTH_URL;
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
process.env.AUTH_GITHUB_ID = "test-client-id";
process.env.AUTH_GITHUB_SECRET = "test-client-secret";

const ORIGIN = "http://localhost:3700";

/** What the fake GitHub answers for the account that is signing in. */
type GithubAccount = { id: number; login: string; name: string | null; email: string | null; primaryEmail?: string };

type SessionBody = { user?: { id: string; login: string | null; name: string | null; email: string | null } } | null;

describe("GitHub sign-in through Auth.js", () => {
  let handlers: Record<"GET" | "POST", (request: Request) => Promise<Response>>;
  let db: Awaited<ReturnType<typeof import("@/server/db").getDb>>;
  let schema: typeof import("@/server/db/schema");
  let github: GithubAccount;

  beforeAll(async () => {
    const dbModule = await import("@/server/db");
    db = await dbModule.getDb();
    schema = dbModule.schema;
    handlers = (await import("./auth")).handlers as unknown as typeof handlers;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** github.com for the length of one sign-in: the token exchange, the profile and the e-mail list. */
  function fakeGithub(account: GithubAccount) {
    github = account;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: `gho_${github.id}`, token_type: "bearer", scope: "read:user,user:email,gist,repo" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: github.id, login: github.login, name: github.name, email: github.email, avatar_url: `https://avatars.githubusercontent.com/u/${github.id}` });
        }
        if (url === "https://api.github.com/user/emails") {
          return Response.json(github.primaryEmail ? [{ email: github.primaryEmail, primary: true, verified: true }] : []);
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
  }

  /** One browser: its cookies, and the three requests a sign-in makes to /api/auth. */
  function browser() {
    const jar = new Map<string, string>();
    async function send(method: "GET" | "POST", path: string, form?: Record<string, string>) {
      const headers = new Headers();
      if (jar.size) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      if (form) headers.set("content-type", "application/x-www-form-urlencoded");
      const request = new Request(`${ORIGIN}${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
      const response = await handlers[method](request);
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0];
        const name = pair.slice(0, pair.indexOf("="));
        const value = pair.slice(pair.indexOf("=") + 1);
        if (value === "" || /max-age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    }
    return {
      /** Sign in as `account`; answers where Auth.js sends the browser afterwards. */
      async signIn(account: GithubAccount, returnTo = "/d/document-1"): Promise<string | null> {
        fakeGithub(account);
        const { csrfToken } = (await (await send("GET", "/api/auth/csrf")).json()) as { csrfToken: string };
        const start = await send("POST", "/api/auth/signin/github", { csrfToken, callbackUrl: `${ORIGIN}${returnTo}` });
        const authorize = new URL(start.headers.get("location") ?? "");
        expect(`${authorize.origin}${authorize.pathname}`).toBe("https://github.com/login/oauth/authorize");
        const state = authorize.searchParams.get("state");
        const callback = await send("GET", `/api/auth/callback/github?code=test-code${state ? `&state=${encodeURIComponent(state)}` : ""}`);
        return callback.headers.get("location");
      },
      async session(): Promise<SessionBody> {
        return (await (await send("GET", "/api/auth/session")).json()) as SessionBody;
      },
    };
  }

  const usersWithLogin = (login: string) => db.select().from(schema.users).where(eq(schema.users.login, login));

  // The work accounts of Enterprise Managed Users: GitHub names them `handle_shortcode`.
  it("signs in a managed account, whose login has an underscore", async () => {
    const mona = browser();

    expect(await mona.signIn({ id: 9001, login: "Mona-Cat_Octo", name: "Mona Cat", email: null, primaryEmail: "mona@octo.test" })).toBe(`${ORIGIN}/d/document-1`);

    const session = await mona.session();
    expect(session?.user).toMatchObject({ login: "mona-cat_octo", name: "Mona Cat", email: "mona@octo.test" });
    const [user] = await usersWithLogin("mona-cat_octo");
    expect(user.id).toBe(session?.user?.id);
    const [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "9001"));
    expect(account).toMatchObject({ userId: user.id, provider: "github", access_token: "gho_9001" });
  });

  it("signs in the same person's personal account with the same e-mail as a second user", async () => {
    const personal = browser();

    expect(await personal.signIn({ id: 9002, login: "mona-cat", name: "Mona", email: "mona@octo.test" })).toBe(`${ORIGIN}/d/document-1`);

    const session = await personal.session();
    expect(session?.user).toMatchObject({ login: "mona-cat", email: null });
    const [managed] = await usersWithLogin("mona-cat_octo");
    expect(session?.user?.id).not.toBe(managed.id);
    expect(managed.email).toBe("mona@octo.test");
  });

  it("finds each account's own user again on the next sign-in", async () => {
    const [managed] = await usersWithLogin("mona-cat_octo");
    const [personal] = await usersWithLogin("mona-cat");

    const atWork = browser();
    await atWork.signIn({ id: 9001, login: "Mona-Cat_Octo", name: "Mona Cat", email: null, primaryEmail: "mona@octo.test" });
    expect((await atWork.session())?.user?.id).toBe(managed.id);
    const atHome = browser();
    await atHome.signIn({ id: 9002, login: "mona-cat", name: "Mona", email: "mona@octo.test" });
    expect((await atHome.session())?.user?.id).toBe(personal.id);

    expect(await usersWithLogin("mona-cat_octo")).toHaveLength(1);
    expect(await usersWithLogin("mona-cat")).toHaveLength(1);
  });

  it("sends a sign-in it cannot complete back to the sign-in page, signed out, with the cause in the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stranger = browser();

    expect(await stranger.signIn({ id: 9003, login: "not.a.login", name: null, email: "stranger@octo.test" })).toBe(`${ORIGIN}/login?error=Configuration`);

    expect(await stranger.session()).toBeNull();
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "9003"))).toHaveLength(0);
    expect(error.mock.calls.flat().join("\n")).toContain("GitHub identity reconciliation refused: invalid_profile");
  });
});
