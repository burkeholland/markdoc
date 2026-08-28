import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { getDb, schema } = await import("./db");
const { createDocument, upsertCollaborator } = await import("./documents");
const { createApiToken } = await import("./tokens");
const { createReview } = await import("./reviews");
const { collectUserEvents, decodeCursor } = await import("./agent-events");

type TestUser = { id: string; login: string; name: string; image: null };

let owner: TestUser;
let reviewer: TestUser;

beforeAll(async () => {
  const db = await getDb();
  const [ownerRow] = await db.insert(schema.users).values({ name: "Olive", login: "olive-review-owner", email: "olive-review-owner@example.com" }).returning();
  const [reviewerRow] = await db.insert(schema.users).values({ name: "Rae", login: "rae-reviewer", email: "rae-reviewer@example.com" }).returning();
  owner = { id: ownerRow.id, login: ownerRow.login!, name: ownerRow.name!, image: null };
  reviewer = { id: reviewerRow.id, login: reviewerRow.login!, name: reviewerRow.name!, image: null };
});

describe("createReview agent events", () => {
  it("records review.created for the owner and returns it to the posting token with includeSelf", async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Review events", content: "# Review events\n\nPlease review this paragraph.\n" });
    await upsertCollaborator(doc.id, reviewer.login, "commenter", owner.id);
    const reviewerToken = await createApiToken(reviewer.id, "Review Bot");
    const reviewerAgent = { ...reviewer, agent: reviewerToken.name, tokenId: reviewerToken.id };
    const ownerAgent = { ...owner, agent: "Owner Watcher" };
    const startedAt = new Date();
    const ownerStart = await collectUserEvents(ownerAgent, null, {}, startedAt);
    const reviewerStart = await collectUserEvents(reviewerAgent, null, {}, startedAt);

    const review = await createReview(doc.id, reviewerAgent, "commenter", {
      summary: "One change requested.",
      verdict: "request_changes",
      comments: [{ quote: "Please review this paragraph.", body: "Tighten this sentence." }],
    });

    const ownerPage = await collectUserEvents(ownerAgent, decodeCursor(ownerStart.cursor));
    expect(ownerPage.events).toHaveLength(1);
    expect(ownerPage.events[0]).toMatchObject({
      type: "review.created",
      documentId: doc.id,
      reviewId: review.id,
      verdict: "request_changes",
      summary: "One change requested.",
      comments: 1,
      actor: { name: "Review Bot", login: reviewer.login, kind: "agent", agent: "Review Bot", self: false },
    });

    const reviewerCursor = decodeCursor(reviewerStart.cursor);
    expect((await collectUserEvents(reviewerAgent, reviewerCursor)).events).toEqual([]);
    const selfPage = await collectUserEvents(reviewerAgent, reviewerCursor, { includeSelf: true });
    expect(selfPage.events).toHaveLength(1);
    expect(selfPage.events[0]).toMatchObject({
      type: "review.created",
      reviewId: review.id,
      actor: { name: "Review Bot", login: reviewer.login, kind: "agent", agent: "Review Bot", self: true },
    });
  });
});
