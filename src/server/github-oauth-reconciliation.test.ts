import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { AdapterAccount, AdapterUser } from "next-auth/adapters";

process.env.PGLITE_DATA_DIR = "memory://";
delete process.env.DATABASE_URL;

describe("GitHub OAuth identity reconciliation", () => {
  let db: Awaited<ReturnType<typeof import("@/server/db").getDb>>;
  let schema: typeof import("@/server/db/schema");
  let adapter: ReturnType<typeof import("./github-oauth-reconciliation").GithubReconciliationAdapter>;
  let githubOAuthProfile: typeof import("./github-oauth-reconciliation").githubOAuthProfile;
  let ReconciliationError: typeof import("./github-oauth-reconciliation").GithubIdentityReconciliationError;
  let sequence = 0;

  beforeAll(async () => {
    const dbModule = await import("@/server/db");
    const reconciliation = await import("./github-oauth-reconciliation");
    db = await dbModule.getDb();
    schema = dbModule.schema;
    adapter = reconciliation.GithubReconciliationAdapter(db);
    githubOAuthProfile = reconciliation.githubOAuthProfile;
    ReconciliationError = reconciliation.GithubIdentityReconciliationError;
  });

  function nextLogin(stem: string): string {
    sequence += 1;
    return `${stem}-${sequence}`;
  }

  async function legacy(login: string, overrides: Partial<typeof schema.users.$inferInsert> = {}) {
    const [user] = await db
      .insert(schema.users)
      .values({
        name: `Legacy ${login}`,
        login,
        email: `${login.toLowerCase()}@dev.local`,
        image: "https://legacy.invalid/avatar",
        ...overrides,
      })
      .returning();
    return user;
  }

  function profile(login: string, providerAccountId: number, email = `${login.toLowerCase()}@example.test`): AdapterUser {
    return {
      ...githubOAuthProfile({
        id: providerAccountId,
        login,
        name: `GitHub ${login}`,
        email,
        avatar_url: "https://avatars.githubusercontent.com/u/1",
      }, {
        access_token: "profile-access-token",
        token_type: "bearer",
        scope: "read:user",
      }),
      emailVerified: null,
    } as AdapterUser;
  }

  function account(userId: string, providerAccountId: number): AdapterAccount {
    return {
      userId,
      provider: "github",
      providerAccountId: String(providerAccountId),
      type: "oauth",
      access_token: "test-access-token",
      token_type: "bearer",
      scope: "read:user",
    };
  }

  async function createGithubUser(data: AdapterUser): Promise<AdapterUser> {
    if (!adapter.createUser) throw new Error("createUser adapter method is missing");
    return adapter.createUser(data);
  }

  async function linkGithub(data: AdapterAccount): Promise<void> {
    if (!adapter.linkAccount) throw new Error("linkAccount adapter method is missing");
    await adapter.linkAccount(data);
  }

  it("reuses one safe legacy row, preserves its owned data, and fills the reserved account", async () => {
    const login = nextLogin("legacy");
    const old = await legacy(login);
    await db.insert(schema.documents).values({ id: `doc-${login}`, ownerId: old.id, title: "Owned", content: "" });

    const user = await createGithubUser(profile(login, 836001));
    const [reserved] = await db
      .select({ accessToken: schema.accounts.access_token })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.provider, "github"), eq(schema.accounts.providerAccountId, "836001")));
    await linkGithub(account(user.id, 836001));

    expect(user.id).toBe(old.id);
    expect(reserved.accessToken).toBe("profile-access-token");
    expect(user).toMatchObject({
      login,
      email: `${login}@example.test`,
      name: `GitHub ${login}`,
    });
    const [document] = await db.select({ ownerId: schema.documents.ownerId }).from(schema.documents).where(eq(schema.documents.id, `doc-${login}`));
    expect(document.ownerId).toBe(old.id);
    const [linked] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.provider, "github"), eq(schema.accounts.providerAccountId, "836001")));
    expect(linked).toMatchObject({ userId: old.id, access_token: "test-access-token" });
  });

  it("normalizes a mixed-case GitHub login before matching", async () => {
    const login = nextLogin("mixed");
    const old = await legacy(login.toUpperCase(), { email: `${login}@dev.local` });

    const user = await createGithubUser(profile(`  ${login.toUpperCase()}  `, 836002));

    expect(user.id).toBe(old.id);
    expect(user.login).toBe(login);
  });

  it("lets an existing GitHub account follow its linked user without reconciliation", async () => {
    const login = nextLogin("linked");
    const linkedUser = await legacy(login, { email: `${login}@example.test` });
    await db.insert(schema.accounts).values({
      userId: linkedUser.id,
      provider: "github",
      providerAccountId: "836003",
      type: "oauth",
    });

    if (!adapter.getUserByAccount) throw new Error("getUserByAccount adapter method is missing");
    const found = await adapter.getUserByAccount({ provider: "github", providerAccountId: "836003" });

    expect(found?.id).toBe(linkedUser.id);
    expect(found?.name).toBe(linkedUser.name);
  });

  it("creates a normal new OAuth identity when no legacy login matches", async () => {
    const login = nextLogin("new");

    const user = await createGithubUser(profile(login, 836004));

    expect(user.id).not.toBe("836004");
    expect(user.login).toBe(login);
    const users = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.login}) = ${login}`);
    const accounts = await db
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.provider, "github"), eq(schema.accounts.providerAccountId, "836004")));
    expect(users).toEqual([{ id: user.id }]);
    expect(accounts).toEqual([{ userId: user.id }]);
  });

  it("fails closed on ambiguous normalized logins without writing", async () => {
    const login = nextLogin("ambiguous");
    await legacy(login);
    await legacy(login.toUpperCase(), { email: `${login}-other@dev.local` });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);

    await expect(createGithubUser(profile(login, 836005))).rejects.toMatchObject({
      name: "GithubIdentityReconciliationError",
      reason: "ambiguous_login",
    });

    const after = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
    const linked = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836005"));
    expect(after).toEqual(before);
    expect(linked).toHaveLength(0);
  });

  it("fails closed when another row claims the legacy row's own address, without profile or account writes", async () => {
    const login = nextLogin("email");
    const old = await legacy(login);
    await legacy(nextLogin("email-owner"), { email: `${login.toUpperCase()}@DEV.LOCAL` });

    await expect(createGithubUser(profile(login, 836006))).rejects.toMatchObject({ reason: "email_conflict" });

    const [unchanged] = await db.select().from(schema.users).where(eq(schema.users.id, old.id));
    expect(unchanged).toEqual(old);
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836006"))).toHaveLength(0);
  });

  it("reuses the legacy row without the e-mail when another user already has that address", async () => {
    const login = nextLogin("shared-email");
    const old = await legacy(login);
    const holder = await legacy(nextLogin("email-holder"), { email: `${login.toUpperCase()}@EXAMPLE.TEST` });

    const user = await createGithubUser(profile(login, 836014));

    expect(user.id).toBe(old.id);
    expect(user).toMatchObject({ login, email: null, name: `GitHub ${login}` });
    const [untouched] = await db.select().from(schema.users).where(eq(schema.users.id, holder.id));
    expect(untouched).toEqual(holder);
    const [linked] = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836014"));
    expect(linked.userId).toBe(old.id);
  });

  // The work accounts of Enterprise Managed Users: `handle_shortcode`, often with the address the same
  // person's personal account already signed in with.
  it("signs a managed account in as its own user when a personal account has the same e-mail", async () => {
    const handle = nextLogin("mona");
    const address = `${handle}@work.test`;
    const personal = await createGithubUser(profile(handle, 836015, address));
    await linkGithub(account(personal.id, 836015));

    const managed = await createGithubUser(profile(`${handle}_Octo`, 836016, address.toUpperCase()));
    await linkGithub(account(managed.id, 836016));

    expect(managed.id).not.toBe(personal.id);
    expect(managed).toMatchObject({ login: `${handle}_octo`, email: null, name: `GitHub ${handle}_Octo` });
    const [kept] = await db.select().from(schema.users).where(eq(schema.users.id, personal.id));
    expect(kept).toMatchObject({ login: handle, email: address });
    const accounts = await db
      .select({ userId: schema.accounts.userId, providerAccountId: schema.accounts.providerAccountId })
      .from(schema.accounts)
      .where(sql`${schema.accounts.providerAccountId} in ('836015', '836016')`);
    expect(accounts).toHaveLength(2);
    expect(accounts).toContainEqual({ userId: personal.id, providerAccountId: "836015" });
    expect(accounts).toContainEqual({ userId: managed.id, providerAccountId: "836016" });
  });

  it("keeps a managed account's e-mail when nobody else has it, and never reuses a legacy row for it", async () => {
    const login = `${nextLogin("solo")}_octo`;
    const old = await legacy(login);

    const user = await createGithubUser(profile(login, 836017));

    expect(user.id).not.toBe(old.id);
    expect(user).toMatchObject({ login, email: `${login}@example.test` });
  });

  it("makes concurrent first sign-ins of a managed account converge on one user and one account", async () => {
    const login = `${nextLogin("managed-concurrent")}_octo`;
    const oauthProfile = profile(login, 836018);

    const [first, second] = await Promise.all([createGithubUser(oauthProfile), createGithubUser(oauthProfile)]);
    await Promise.all([linkGithub(account(first.id, 836018)), linkGithub(account(second.id, 836018))]);

    expect(second.id).toBe(first.id);
    expect(await db.select().from(schema.users).where(eq(schema.users.login, login))).toHaveLength(1);
    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836018"));
    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe(first.id);
  });

  it("never finds a user by e-mail: the GitHub account id is the identity", async () => {
    if (!adapter.getUserByEmail) throw new Error("getUserByEmail adapter method is missing");
    const holder = await legacy(nextLogin("by-email"), { email: "by-email@example.test" });

    expect(holder.email).toBe("by-email@example.test");
    expect(await adapter.getUserByEmail("by-email@example.test")).toBeNull();
  });

  it("fails closed when the provider account becomes linked to a conflicting user", async () => {
    const desiredLogin = nextLogin("provider");
    const other = await legacy(nextLogin("other"), { email: "provider-other@example.test" });
    await db.insert(schema.accounts).values({
      userId: other.id,
      provider: "github",
      providerAccountId: "836007",
      type: "oauth",
    });

    await expect(createGithubUser(profile(desiredLogin, 836007))).rejects.toMatchObject({
      reason: "provider_account_conflict",
    });
  });

  it.each(["profile", "verified", "account", "session"] as const)(
    "refuses an unsafe legacy account state (%s) without writes",
    async (state) => {
      const login = nextLogin(`unsafe-${state}`);
      const overrides =
        state === "profile"
          ? { email: `${login}@example.test` }
          : state === "verified"
            ? { emailVerified: new Date("2026-01-01T00:00:00Z") }
            : {};
      const old = await legacy(login, overrides);
      if (state === "account") {
        await db.insert(schema.accounts).values({
          userId: old.id,
          provider: "example",
          providerAccountId: `example-${sequence}`,
          type: "oauth",
        });
      }
      if (state === "session") {
        await db.insert(schema.sessions).values({
          sessionToken: `session-${sequence}`,
          userId: old.id,
          expires: new Date("2030-01-01T00:00:00Z"),
        });
      }

      await expect(createGithubUser(profile(login, 836100 + sequence))).rejects.toMatchObject({
        reason: "unsafe_legacy",
      });

      const [unchanged] = await db.select().from(schema.users).where(eq(schema.users.id, old.id));
      expect(unchanged).toEqual(old);
    },
  );

  it("makes concurrent first sign-ins converge on one user and one account", async () => {
    const login = nextLogin("concurrent");
    const old = await legacy(login);
    const oauthProfile = profile(login, 836008);

    const [first, second] = await Promise.all([createGithubUser(oauthProfile), createGithubUser(oauthProfile)]);
    await Promise.all([linkGithub(account(first.id, 836008)), linkGithub(account(second.id, 836008))]);

    expect(first.id).toBe(old.id);
    expect(second.id).toBe(old.id);
    const users = await db.select().from(schema.users).where(sql`lower(${schema.users.login}) = ${login}`);
    const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836008"));
    expect(users).toHaveLength(1);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].userId).toBe(old.id);
  });

  it("links GitHub to an already signed-in user when no reservation exists", async () => {
    const login = nextLogin("signed-in");
    const user = await legacy(login, { email: `${login}@example.test` });

    await linkGithub(account(user.id, 836009));

    const [linked] = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836009"));
    expect(linked).toMatchObject({ userId: user.id, provider: "github", access_token: "test-access-token" });
  });

  it("refuses to move a provider account while linking from another signed-in user", async () => {
    const first = await legacy(nextLogin("link-owner"), { email: "link-owner@example.test" });
    const second = await legacy(nextLogin("link-other"), { email: "link-other@example.test" });
    await linkGithub(account(first.id, 836010));

    await expect(linkGithub(account(second.id, 836010))).rejects.toMatchObject({
      reason: "provider_account_conflict",
    });

    const [linked] = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836010"));
    expect(linked.userId).toBe(first.id);
  });

  it("leaves development users and unrelated OAuth providers on the base adapter path", async () => {
    if (!adapter.createUser || !adapter.linkAccount) throw new Error("required adapter methods are missing");
    const login = nextLogin("dev");
    const user = await adapter.createUser({
      id: `ignored-${sequence}`,
      name: login,
      login,
      email: `${login}@dev.local`,
      emailVerified: null,
      image: null,
    });
    await adapter.linkAccount({
      userId: user.id,
      provider: "example",
      providerAccountId: `example-${sequence}`,
      type: "oauth",
    });

    expect(user.login).toBe(login);
    const [linked] = await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, `example-${sequence}`));
    expect(linked).toMatchObject({ userId: user.id, provider: "example" });
  });

  it.each([
    ["d--b", 836011],
    ["x--", 836012],
  ])("creates an ordinary OAuth identity for provider-supplied noncanonical login %s", async (login, accountId) => {
    const old = await legacy(login);
    const user = await createGithubUser(profile(login, accountId));
    await linkGithub(account(user.id, accountId));

    expect(user.id).not.toBe(old.id);
    expect(user.login).toBe(login);
    const users = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(trim(${schema.users.login})) = ${login}`);
    expect(users).toHaveLength(2);
    expect(users.map(({ id }) => id)).toContain(old.id);
    const linked = await db
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.provider, "github"), eq(schema.accounts.providerAccountId, String(accountId))));
    expect(linked).toEqual([{ userId: user.id }]);
  });

  it("surfaces unnormalizable GitHub profile identifiers from the adapter without database writes", async () => {
    for (const login of ["bad.login", "bad login", "_octo", "a".repeat(40)]) {
      await expect(
        createGithubUser(profile(login, 836013)),
      ).rejects.toBeInstanceOf(ReconciliationError);
    }
    await expect(
      createGithubUser({
        ...githubOAuthProfile(
          { id: "not-numeric", login: "valid-login" },
          { access_token: "profile-access-token" },
        ),
        emailVerified: null,
      } as AdapterUser),
    ).rejects.toBeInstanceOf(ReconciliationError);
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.providerAccountId, "836013"))).toHaveLength(0);
  });
});
