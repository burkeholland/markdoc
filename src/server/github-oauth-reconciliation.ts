import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, sql } from "drizzle-orm";
import type { Adapter, AdapterAccount, AdapterUser } from "next-auth/adapters";
import type { Db } from "@/server/db";
import { schema } from "@/server/db";

const GITHUB_IDENTITY_FIELD = "__markdocGithubIdentity";
// What GitHub may send as a login. The underscore is there for managed accounts (Enterprise Managed
// Users), whose login is the handle, `_` and the enterprise's short code: `mona-cat_octo`.
const GITHUB_PROVIDER_LOGIN_PATTERN = /^[a-z\d][a-z\d_-]{0,38}$/;
// What a legacy row may be matched on: a canonical ordinary login. A managed login never is one.
const GITHUB_RECONCILIATION_LOGIN_PATTERN = /^(?!.*--)[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/;
const GITHUB_ACCOUNT_ID_PATTERN = /^\d{1,32}$/;

export type GithubIdentityConflictReason =
  | "ambiguous_login"
  | "email_conflict"
  | "invalid_profile"
  | "provider_account_conflict"
  | "unsafe_legacy";

export class GithubIdentityReconciliationError extends Error {
  constructor(readonly reason: GithubIdentityConflictReason) {
    super(`GitHub identity reconciliation refused: ${reason}`);
    this.name = "GithubIdentityReconciliationError";
  }
}

export interface GithubIdentityMarker {
  provider: "github";
  providerAccountId: string;
  login: string;
  account: {
    refresh_token?: string;
    access_token?: string;
    expires_at?: number;
    token_type?: string;
    scope?: string;
    id_token?: string;
    session_state?: string;
  };
}

interface MarkedGithubUser {
  [GITHUB_IDENTITY_FIELD]: GithubIdentityMarker;
}

export interface GithubProviderProfile {
  id: string | number;
  login?: string | null;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

export interface GithubTokenSet {
  refresh_token?: unknown;
  access_token?: unknown;
  expires_at?: unknown;
  token_type?: unknown;
  scope?: unknown;
  id_token?: unknown;
  session_state?: unknown;
}

export function normalizeGithubLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const login = value.trim().toLowerCase();
  return GITHUB_RECONCILIATION_LOGIN_PATTERN.test(login) ? login : null;
}

function normalizeProviderGithubLogin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const login = value.trim().toLowerCase();
  return GITHUB_PROVIDER_LOGIN_PATTERN.test(login) ? login : null;
}

function normalizeProviderAccountId(value: unknown): string | null {
  const id = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  return GITHUB_ACCOUNT_ID_PATTERN.test(id) ? id : null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function githubAccountTokens(tokens: GithubTokenSet): GithubIdentityMarker["account"] {
  const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined;
  const accessToken = typeof tokens.access_token === "string" && tokens.access_token ? tokens.access_token : undefined;
  const expiresAt = optionalInteger(tokens.expires_at);
  const tokenType = optionalText(tokens.token_type) ?? undefined;
  const scope = optionalText(tokens.scope) ?? undefined;
  const idToken = typeof tokens.id_token === "string" && tokens.id_token ? tokens.id_token : undefined;
  const sessionState = typeof tokens.session_state === "string" && tokens.session_state ? tokens.session_state : undefined;
  return {
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    ...(tokenType ? { token_type: tokenType } : {}),
    ...(scope ? { scope } : {}),
    ...(idToken ? { id_token: idToken } : {}),
    ...(sessionState ? { session_state: sessionState } : {}),
  };
}

/**
 * Maps only a validated GitHub response to the private marker consumed by the
 * adapter. Other providers and ordinary adapter callers cannot enter the
 * reconciliation path accidentally.
 */
export function githubOAuthProfile(profile: GithubProviderProfile, tokens: GithubTokenSet = {}) {
  const providerAccountId = String(profile.id).trim();
  const rawLogin = typeof profile.login === "string" ? profile.login.trim().toLowerCase() : "";
  const login = normalizeProviderGithubLogin(rawLogin);

  return {
    id: providerAccountId,
    name: optionalText(profile.name) ?? login ?? rawLogin,
    email: normalizeEmail(profile.email),
    image: optionalText(profile.avatar_url),
    login: login ?? rawLogin,
    [GITHUB_IDENTITY_FIELD]: {
      provider: "github",
      providerAccountId,
      login: login ?? rawLogin,
      account: githubAccountTokens(tokens),
    } satisfies GithubIdentityMarker,
  };
}

function githubMarker(data: AdapterUser): GithubIdentityMarker | null {
  const marker = (data as AdapterUser & Partial<MarkedGithubUser>)[GITHUB_IDENTITY_FIELD];
  if (!marker) return null;
  if (
    marker.provider !== "github" ||
    normalizeProviderAccountId(marker.providerAccountId) !== marker.providerAccountId ||
    normalizeProviderGithubLogin(marker.login) !== marker.login ||
    !marker.account ||
    typeof marker.account !== "object" ||
    typeof marker.account.access_token !== "string" ||
    !marker.account.access_token
  ) {
    throw new GithubIdentityReconciliationError("invalid_profile");
  }
  return { ...marker, account: githubAccountTokens(marker.account) };
}

function adapterUser(row: typeof schema.users.$inferSelect): AdapterUser {
  // Auth.js declares AdapterUser.email as required even though OAuth profiles
  // and its own adapters support a nullable email column.
  return row as AdapterUser;
}

type IdentityTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function acquireIdentityLocks(
  tx: IdentityTransaction,
  marker: GithubIdentityMarker,
  emails: string[] = [],
): Promise<void> {
  const lockNames = [
    `github-account:${marker.providerAccountId}`,
    `github-login:${marker.login}`,
    ...emails.map((email) => `github-email:${email}`),
  ].sort();
  for (const lockName of lockNames) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`);
  }
}

/** Whether a user other than `exceptUserId` already has this (normalized) e-mail. */
async function emailHeldByAnother(tx: IdentityTransaction, email: string, exceptUserId: string | undefined): Promise<boolean> {
  const holders = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(trim(${schema.users.email})) = ${email}`)
    .limit(2);
  return holders.some((row) => row.id !== exceptUserId);
}

/**
 * The user for a first GitHub sign-in, with its account row reserved in the same transaction. The
 * GitHub account id is the identity. With `reconcileLegacy` (a canonical ordinary login) the one safe
 * legacy row with that login is reused; otherwise the user is always new.
 */
async function createOrReconcileGithubUser(db: Db, data: AdapterUser, marker: GithubIdentityMarker, reconcileLegacy: boolean): Promise<AdapterUser> {
  const email = normalizeEmail(data.email);
  return db.transaction(async (tx) => {
    await acquireIdentityLocks(tx, marker, [email, `${marker.login}@dev.local`].filter((value): value is string => !!value));

    const [linked] = await tx
      .select({ user: schema.users })
      .from(schema.accounts)
      .innerJoin(schema.users, eq(schema.users.id, schema.accounts.userId))
      .where(
        and(
          eq(schema.accounts.provider, "github"),
          eq(schema.accounts.providerAccountId, marker.providerAccountId),
        ),
      )
      .limit(1);
    if (linked) {
      if (normalizeProviderGithubLogin(linked.user.login) !== marker.login) {
        throw new GithubIdentityReconciliationError("provider_account_conflict");
      }
      return adapterUser(linked.user);
    }

    const candidates = reconcileLegacy
      ? await tx
          .select()
          .from(schema.users)
          .where(sql`lower(trim(${schema.users.login})) = ${marker.login}`)
          .limit(2)
          .for("update")
      : [];
    if (candidates.length > 1) throw new GithubIdentityReconciliationError("ambiguous_login");
    const candidate: typeof schema.users.$inferSelect | undefined = candidates[0];

    // Two rows that claim the same legacy address: which one is this person is not ours to guess.
    const legacyEmail = normalizeEmail(candidate?.email);
    if (candidate && legacyEmail && (await emailHeldByAnother(tx, legacyEmail, candidate.id))) {
      throw new GithubIdentityReconciliationError("email_conflict");
    }

    // The e-mail is a detail of the profile, never the identity: one person can have a personal and a
    // managed (work) GitHub account with the same address. The column is unique, so the account that
    // signs in second is stored without it instead of being refused.
    const profile = {
      name: optionalText(data.name) ?? marker.login,
      email: email && (await emailHeldByAnother(tx, email, candidate?.id)) ? null : email,
      image: optionalText(data.image),
      login: marker.login,
      emailVerified: null,
    };

    let user: typeof schema.users.$inferSelect;
    if (candidate) {
      const [candidateAccounts, candidateSessions] = await Promise.all([
        tx.select({ provider: schema.accounts.provider }).from(schema.accounts).where(eq(schema.accounts.userId, candidate.id)).limit(1),
        tx.select({ token: schema.sessions.sessionToken }).from(schema.sessions).where(eq(schema.sessions.userId, candidate.id)).limit(1),
      ]);
      const safeLegacyEmail = normalizeEmail(candidate.email) === `${marker.login}@dev.local`;
      if (!safeLegacyEmail || candidate.emailVerified !== null || candidateAccounts.length || candidateSessions.length) {
        throw new GithubIdentityReconciliationError("unsafe_legacy");
      }
      const [updated] = await tx
        .update(schema.users)
        .set(profile)
        .where(eq(schema.users.id, candidate.id))
        .returning();
      user = updated;
    } else {
      const [created] = await tx.insert(schema.users).values(profile).returning();
      user = created;
    }

    await tx.insert(schema.accounts).values({
      userId: user.id,
      type: "oauth",
      provider: "github",
      providerAccountId: marker.providerAccountId,
      ...marker.account,
    });
    return adapterUser(user);
  });
}

function accountValues(data: AdapterAccount) {
  return {
    type: data.type,
    refresh_token: data.refresh_token ?? null,
    access_token: data.access_token ?? null,
    expires_at: data.expires_at ?? null,
    token_type: data.token_type ?? null,
    scope: data.scope ?? null,
    id_token: data.id_token ?? null,
    session_state: typeof data.session_state === "string" ? data.session_state : null,
  };
}

async function linkGithubAccount(db: Db, data: AdapterAccount): Promise<void> {
  const marker: GithubIdentityMarker = {
    provider: "github",
    providerAccountId: normalizeProviderAccountId(data.providerAccountId) ?? "",
    login: "unused",
    account: {},
  };
  if (!marker.providerAccountId || typeof data.access_token !== "string" || !data.access_token) {
    throw new GithubIdentityReconciliationError("invalid_profile");
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`github-account:${marker.providerAccountId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.provider, "github"),
          eq(schema.accounts.providerAccountId, marker.providerAccountId),
        ),
      )
      .limit(1);
    if (existing && existing.userId !== data.userId) {
      throw new GithubIdentityReconciliationError("provider_account_conflict");
    }
    if (!existing) {
      await tx.insert(schema.accounts).values({
        userId: data.userId,
        provider: "github",
        providerAccountId: marker.providerAccountId,
        ...accountValues(data),
      });
      return;
    }
    await tx
      .update(schema.accounts)
      .set(accountValues(data))
      .where(
        and(
          eq(schema.accounts.provider, "github"),
          eq(schema.accounts.providerAccountId, marker.providerAccountId),
          eq(schema.accounts.userId, data.userId),
        ),
      );
  });
}

export function GithubReconciliationAdapter(db: Db): Adapter {
  const base = DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  });
  const createUser = base.createUser;
  const linkAccount = base.linkAccount;
  if (!createUser || !linkAccount) throw new Error("The configured Auth.js adapter is incomplete");

  return {
    ...base,
    // Auth.js asks this before it creates a user for a new OAuth account, and refuses the sign-in
    // (OAuthAccountNotLinked) when anyone has the profile's e-mail. No provider here signs in by e-mail,
    // and a GitHub account is identified by its id alone, so nobody is ever found this way.
    async getUserByEmail() {
      return null;
    },
    async createUser(data) {
      const marker = githubMarker(data);
      if (!marker) return createUser(data);
      return createOrReconcileGithubUser(db, data, marker, normalizeGithubLogin(marker.login) !== null);
    },
    async linkAccount(data) {
      if (data.provider === "github") {
        await linkGithubAccount(db, data);
        return;
      }
      await linkAccount(data);
    },
  };
}
