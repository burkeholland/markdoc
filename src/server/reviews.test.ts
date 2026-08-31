import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.PGLITE_DATA_DIR = "memory://";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
delete process.env.DATABASE_URL;

type TestUser = { id: string; login: string; name: string; image: null };
let actor: TestUser | null = null;
vi.mock("@/auth", () => ({ auth: async () => (actor ? { user: actor } : null) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// Wrapped so a test can fail one post-write step of a review at a time.
vi.mock("@/server/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/activity")>();
  return { ...actual, recordActivity: vi.fn(actual.recordActivity) };
});
vi.mock("@/server/notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications")>();
  return { ...actual, notify: vi.fn(actual.notify), recordMentions: vi.fn(actual.recordMentions) };
});

const { getDb, schema } = await import("./db");
const { eq } = await import("drizzle-orm");
const { createDocument, upsertCollaborator } = await import("./documents");
const { createApiToken } = await import("./tokens");
const { createReview, recordSuggestionDecision } = await import("./reviews");
const { collectUserEvents, decodeCursor } = await import("./agent-events");
const { readLiveDoc } = await import("./livedoc");
const { listActivity, recordActivity } = await import("./activity");
const { listNotifications, notify, recordMentions } = await import("./notifications");
const { POST: POST_REVIEWS } = await import("@/app/api/documents/[id]/reviews/route");

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

    const { review, ...rest } = await createReview(doc.id, reviewerAgent, "commenter", {
      summary: "One change requested.",
      verdict: "request_changes",
      comments: [{ quote: "Please review this paragraph.", body: "Tighten this sentence." }],
    });
    // The success shape carries no `warnings` key.
    expect(rest).toEqual({});

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

/**
 * `docs/agents.md` promises that a non-2xx status means nothing changed and that a review is atomic on its quotes
 * (audit #1202 F12): a review row that cannot be written takes its threads back out of the document before the
 * 500; the mentions, the activity row and the owner's notification are `warnings` on the created review.
 */
describe("the non-2xx promise for reviews (#1232)", () => {
  type ReviewerAgent = TestUser & { agent: string; tokenId: string };
  let reviewerAgent: ReviewerAgent;
  const TEXT = "# Atomic review\n\nFirst finding here.\n\nSecond finding there.\n";
  const twoComments = [
    { quote: "First finding here.", body: "Tighten this, @olive-review-owner." },
    { quote: "Second finding there.", body: "```suggestion\nSecond finding elsewhere.\n```" },
  ];
  const freshDoc = async () => {
    const doc = await createDocument({ ownerId: owner.id, title: "Atomic review", content: TEXT });
    await upsertCollaborator(doc.id, reviewer.login, "commenter", owner.id);
    return doc.id;
  };
  const threadCount = (docId: string) => readLiveDoc(docId, (doc) => doc.getMap("comments").size);
  const reviewRows = async (docId: string) => (await getDb()).select().from(schema.reviews).where(eq(schema.reviews.documentId, docId));
  const reviewActivity = async (docId: string) => (await listActivity(docId, { limit: 100 })).items.filter((a) => a.action === "review.create");
  const ownerReviewNotifications = async (reviewId: string) => (await listNotifications(owner.login, { kind: "review" })).items.filter((n) => n.refId === reviewId);
  /** Runs `fn` with console.error silenced; returns its result and the `[reviews]`-prefixed lines it logged. */
  const quietly = async <T>(fn: () => Promise<T>): Promise<{ result: T; logged: unknown[][] }> => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fn();
      return { result, logged: errors.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("[reviews]")) };
    } finally {
      errors.mockRestore();
    }
  };

  beforeAll(async () => {
    const token = await createApiToken(reviewer.id, "Atomic Bot");
    reviewerAgent = { ...reviewer, agent: token.name, tokenId: token.id };
  });
  afterEach(() => {
    // A failure armed with `...Once` and never consumed must not leak into the next test.
    vi.mocked(recordActivity).mockReset();
    vi.mocked(notify).mockReset();
    vi.mocked(recordMentions).mockReset();
    actor = null;
  });

  it("a review row that cannot be written takes its threads back out: the 500 leaves zero threads and zero rows", async () => {
    const docId = await freshDoc();
    const db = await getDb();
    const originalInsert = db.insert;
    const realInsert = originalInsert.bind(db) as (table: unknown) => unknown;
    // The reviews table refuses the row; every other write (the threads' document store, the undo) goes through.
    db.insert = ((table: unknown) => {
      if (table === schema.reviews) throw new Error('Failed query: insert into "reviews" ("id", "document_id") values ($1, $2) params: abc,secret-owner-uuid');
      return realInsert(table);
    }) as typeof db.insert;
    try {
      const { logged } = await quietly(async () => {
        await expect(createReview(docId, reviewerAgent, "commenter", { summary: "Two findings.", verdict: "request_changes", comments: twoComments })).rejects.toThrow(/Failed query/);
      });
      // The undo itself did not fail (it would be logged under its own line).
      expect(logged).toEqual([]);
    } finally {
      db.insert = originalInsert;
    }
    expect(await threadCount(docId)).toBe(0);
    expect(await reviewRows(docId)).toEqual([]);
    expect(await reviewActivity(docId)).toEqual([]);
    expect((await listNotifications(owner.login, { kind: "mention" })).items.filter((n) => n.documentId === docId)).toEqual([]);
    // The retry an agent makes after the 500 creates the review once: two threads, one row.
    const { review, ...rest } = await createReview(docId, reviewerAgent, "commenter", { summary: "Two findings.", verdict: "request_changes", comments: twoComments });
    expect(rest).toEqual({});
    expect(review.threadIds).toHaveLength(2);
    expect(await threadCount(docId)).toBe(2);
    expect(await reviewRows(docId)).toHaveLength(1);
  });

  it("the owner's notification failing is a warning on the created review: two threads, one row, one log line", async () => {
    const docId = await freshDoc();
    vi.mocked(notify).mockRejectedValueOnce(new Error("notifications table is away"));
    const { result, logged } = await quietly(() => createReview(docId, reviewerAgent, "commenter", { summary: "Two findings.", verdict: "request_changes", comments: twoComments }));
    expect(result).toEqual({ review: expect.objectContaining({ documentId: docId, verdict: "request_changes", threadIds: [expect.any(String), expect.any(String)] }), warnings: ["notification-not-sent"] });
    expect(logged).toEqual([["[reviews] notification-not-sent", expect.any(Error)]]);
    expect(await threadCount(docId)).toBe(2);
    expect(await reviewRows(docId)).toHaveLength(1);
    // Everything that did not fail happened: the mention (its own notify call went through before) and the activity row.
    expect(await reviewActivity(docId)).toHaveLength(1);
    expect(await ownerReviewNotifications(result.review.id)).toEqual([]);
  });

  it("the activity row or the mentions failing are their own warning codes; the review stands", async () => {
    const docId = await freshDoc();
    vi.mocked(recordActivity).mockRejectedValueOnce(new Error("activity table is away"));
    const first = await quietly(() => createReview(docId, reviewerAgent, "commenter", { summary: "Two findings.", verdict: "comment", comments: twoComments }));
    expect(first.result.warnings).toEqual(["activity-not-recorded"]);
    expect(first.logged).toEqual([["[reviews] activity-not-recorded", expect.any(Error)]]);
    expect(await reviewActivity(docId)).toEqual([]);
    expect(await ownerReviewNotifications(first.result.review.id)).toHaveLength(1);

    vi.mocked(recordMentions).mockRejectedValueOnce(new Error("mentions are away"));
    const second = await quietly(() => createReview(docId, reviewerAgent, "commenter", { summary: "Again.", verdict: "comment", comments: twoComments }));
    expect(second.result.warnings).toEqual(["mentions-not-recorded"]);
    expect(second.logged).toEqual([["[reviews] mentions-not-recorded", expect.any(Error)]]);
    expect(await threadCount(docId)).toBe(4);
    expect(await reviewRows(docId)).toHaveLength(2);
  });

  it("a quote that does not anchor is still a 400 that leaves nothing (no threads to undo, nothing logged)", async () => {
    const docId = await freshDoc();
    const { logged } = await quietly(async () => {
      await expect(createReview(docId, reviewerAgent, "commenter", { summary: "Two findings.", verdict: "comment", comments: [twoComments[0], { quote: "Not in the text.", body: "Never." }] })).rejects.toMatchObject({
        status: 400,
        details: { notFound: ["Not in the text."] },
      });
    });
    expect(logged).toEqual([]);
    expect(await threadCount(docId)).toBe(0);
    expect(await reviewRows(docId)).toEqual([]);
  });

  it("POST /reviews answers 201 { review } on success and 201 { review, warnings } when a tail fails", async () => {
    const docId = await freshDoc();
    actor = reviewer;
    const req = (comments = twoComments) => new Request(`http://localhost:3700/api/documents/${docId}/reviews`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "Over REST.", verdict: "approve", comments }) });
    const params = { params: Promise.resolve({ id: docId }) };
    const res = await POST_REVIEWS(req(), params);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ review: expect.objectContaining({ documentId: docId, verdict: "approve", authorName: "Rae" }) });

    vi.mocked(notify).mockRejectedValueOnce(new Error("notifications table is away"));
    const { result: warned } = await quietly(() => POST_REVIEWS(req(), params));
    expect(warned.status).toBe(201);
    expect(await warned.json()).toEqual({ review: expect.objectContaining({ documentId: docId }), warnings: ["notification-not-sent"] });
    expect(await threadCount(docId)).toBe(4);
  });
});

describe("recordSuggestionDecision (#1232)", () => {
  it("the author's notification failing is logged as [reviews] notification-not-sent and the activity row stands", async () => {
    const docId = (await createDocument({ ownerId: owner.id, title: "Decision", content: "# Decision\n\nA quoted line.\n" })).id;
    const thread = { id: "thread-1232", authorId: reviewer.id, authorName: reviewer.name, body: "```suggestion\nA better line.\n```", quote: "A quoted line." };
    const ownerActor = { id: owner.id, name: owner.name, kind: "user" as const, login: owner.login };
    vi.mocked(notify).mockRejectedValueOnce(new Error("notifications table is away"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordSuggestionDecision(docId, thread, true, ownerActor)).resolves.toBeUndefined();
      expect(errors.mock.calls).toEqual([["[reviews] notification-not-sent", expect.any(Error)]]);
    } finally {
      errors.mockRestore();
    }
    const rows = (await listActivity(docId, { limit: 10 })).items.filter((a) => a.action === "comment.suggestion.accepted");
    expect(rows).toEqual([expect.objectContaining({ actorName: owner.name, detail: expect.objectContaining({ threadId: "thread-1232", author: reviewer.name }) })]);
    expect((await listNotifications(reviewer.login, { kind: "suggestion.accepted" })).items.filter((n) => n.refId === "thread-1232")).toEqual([]);
    // Without the failure the author hears about it.
    await recordSuggestionDecision(docId, thread, true, ownerActor);
    expect((await listNotifications(reviewer.login, { kind: "suggestion.accepted" })).items.filter((n) => n.refId === "thread-1232")).toHaveLength(1);
  });
});