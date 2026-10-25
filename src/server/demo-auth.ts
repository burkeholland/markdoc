import { eq } from "drizzle-orm";
import type { getDb } from "@/server/db";
import { schema } from "@/server/db";
import { createDocument } from "@/server/documents";

type Db = Awaited<ReturnType<typeof getDb>>;
type Env = Readonly<Record<string, string | undefined>>;

/** The fixed account the demo sign-in uses (test environments only). */
export const DEMO_LOGIN = "markdoc-demo";

/**
 * Demo sign-in is on only when `MARKDOC_DEMO_AUTH=1` and NODE_ENV is explicitly `development` or `test`.
 * There is deliberately no override for production builds (unlike AUTH_DEV_LOGIN=force), and an unset
 * or unknown NODE_ENV counts as production.
 */
export function demoAuthEnabled(env: Env = process.env): boolean {
  return env.MARKDOC_DEMO_AUTH === "1" && (env.NODE_ENV === "development" || env.NODE_ENV === "test");
}

/** Refuse to start a production server that has the demo flag set at all, so a misconfigured deploy fails closed. */
export function assertDemoAuthSafe(env: Env = process.env): void {
  if (env.MARKDOC_DEMO_AUTH && env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error("MARKDOC_DEMO_AUTH must not be set outside development/test (NODE_ENV=" + (env.NODE_ENV ?? "unset") + "). Refusing to start.");
  }
}

export const DEMO_DOCUMENTS: ReadonlyArray<{ title: string; content: string }> = [
  {
    title: "Welcome to Markdoc",
    content: `# Welcome to Markdoc

This is the **demo account**. Everything here is sample content you can edit, share, or delete.

## Try these

- [ ] Edit this paragraph and watch it save
- [ ] Add a comment on a sentence
- [ ] Open *Share* and copy a link
- [x] Sign in as the demo user

> Markdown, together.

| Feature | Shortcut |
| --- | --- |
| Bold | Ctrl/Cmd+B |
| Italic | Ctrl/Cmd+I |
`,
  },
  {
    title: "Meeting notes",
    content: `# Meeting notes

## Agenda
1. Roadmap review
2. Bug triage
3. Open questions

## Decisions
- Ship the reader view first.
- Revisit mobile layout next sprint.

\`\`\`ts
export function greet(name: string) {
  return \`Hello, \${name}!\`;
}
\`\`\`
`,
  },
  {
    title: "Long document",
    content:
      "# Long document\n\n" +
      Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Paragraph ${i + 1} exists so scrolling, the outline and the reader have something to chew on.\n`).join("\n"),
  },
];

/** Find or create the demo user; a brand-new demo user gets the sample documents. */
export async function ensureDemoUser(db: Db) {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.login, DEMO_LOGIN));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.users)
    .values({ name: "Demo User", login: DEMO_LOGIN, email: `${DEMO_LOGIN}@demo.local`, image: null })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [raced] = await db.select().from(schema.users).where(eq(schema.users.login, DEMO_LOGIN));
    return raced;
  }
  for (const doc of DEMO_DOCUMENTS) await createDocument({ ownerId: created.id, title: doc.title, content: doc.content });
  return created;
}
