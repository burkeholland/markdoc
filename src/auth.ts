import NextAuth, { type NextAuthConfig, type DefaultSession } from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { GithubReconciliationAdapter, githubOAuthProfile } from "@/server/github-oauth-reconciliation";
import { logAuthError } from "@/server/session-cookie";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      login: string | null;
      agent?: string | null;
    } & DefaultSession["user"];
  }
  interface User {
    login?: string | null;
  }
}

/**
 * Dev-only sign in without GitHub so the app (and e2e tests) can run locally.
 * `1` is ignored under NODE_ENV=production; `force` enables it there too, which is only meant
 * for smoke-testing the production build on a developer machine (`npm run start:local`).
 */
export const devLoginEnabled =
  (process.env.AUTH_DEV_LOGIN === "1" && process.env.NODE_ENV !== "production") || process.env.AUTH_DEV_LOGIN === "force";

export const githubConfigured = !!(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);

async function buildConfig(): Promise<NextAuthConfig> {
  const db = await getDb();
  const providers: NextAuthConfig["providers"] = [];

  if (githubConfigured) {
    providers.push(
      GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
        authorization: { params: { scope: "read:user user:email gist repo" } },
        profile(profile, tokens) {
          return githubOAuthProfile(profile, tokens);
        },
      }),
    );
  }

  if (devLoginEnabled) {
    providers.push(
      Credentials({
        id: "dev",
        name: "Development login",
        credentials: {
          login: { label: "GitHub handle", type: "text" },
        },
        async authorize(credentials) {
          const login = String(credentials?.login ?? "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "");
          if (!login) return null;
          const [existing] = await db.select().from(schema.users).where(eq(schema.users.login, login));
          if (existing) return existing;
          const [created] = await db
            .insert(schema.users)
            .values({
              name: login,
              login,
              email: `${login}@dev.local`,
              image: `https://avatars.githubusercontent.com/${login}?s=80`,
            })
            .returning();
          return created;
        },
      }),
    );
  }

  return {
    adapter: GithubReconciliationAdapter(db),
    providers,
    // Database sessions for OAuth; the dev credentials provider needs JWT, so we
    // use JWT and enrich it from the database.
    session: { strategy: "jwt" },
    trustHost: true,
    pages: { signIn: "/login" },
    logger: { error: logAuthError },
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          token.sub = user.id;
          token.login = user.login ?? null;
          token.picture = user.image ?? token.picture;
          token.name = user.name ?? token.name;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          session.user.id = token.sub as string;
          session.user.login = (token.login as string | null) ?? null;
          session.user.image = (token.picture as string | null) ?? session.user.image;
          session.user.name = (token.name as string | null) ?? session.user.name;
          session.user.agent = (token.agent as string | null) ?? null;
        }
        return session;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildConfig);
