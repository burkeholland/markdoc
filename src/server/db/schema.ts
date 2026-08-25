import {
  pgTable,
  text,
  timestamp,
  integer,
  primaryKey,
  boolean,
  customType,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
  },
});

// --- Auth.js tables -------------------------------------------------------

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date", withTimezone: true }),
  image: text("image"),
  /** GitHub login (handle). Used for sharing by handle. */
  login: text("login"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// --- Application tables ---------------------------------------------------

export type StorageKind = "local" | "gist" | "repo";
export type LinkAccess = "private" | "view" | "comment" | "edit";
export type Role = "owner" | "editor" | "commenter" | "viewer";
/** How much of its user's access an API token carries: `read` < `comment` < `full` (everything the user can do). */
export type TokenScope = "read" | "comment" | "full";

export const documents = pgTable(
  "document",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull().default("Untitled"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Where the canonical copy lives outside Markdoc, if anywhere. */
    storage: text("storage").$type<StorageKind>().notNull().default("local"),
    /** Latest Yjs document state (full update). */
    ystate: bytea("ystate"),
    /** Latest Markdown text, denormalized for listing, search, and export. */
    content: text("content").notNull().default(""),
    linkAccess: text("link_access").$type<LinkAccess>().notNull().default("private"),
    gistId: text("gist_id"),
    gistFile: text("gist_file"),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    repoBranch: text("repo_branch"),
    repoPath: text("repo_path"),
    /** Blob SHA of the file as last seen on GitHub (for safe updates). */
    githubSha: text("github_sha"),
    /** Content as last published to / pulled from GitHub, to detect local changes. */
    publishedContent: text("published_content"),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastEditedBy: text("last_edited_by"),
    /** Set when the document is in the trash; purged for good 30 days later. */
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("document_owner_idx").on(t.ownerId)],
);

export const collaborators = pgTable(
  "collaborator",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    /** GitHub login of the collaborator (they may not have signed in yet). */
    login: text("login").notNull(),
    role: text("role").$type<Exclude<Role, "owner">>().notNull().default("editor"),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.login] })],
);

export type VersionKind = "auto" | "named" | "publish" | "restore" | "import";

export const versions = pgTable(
  "version",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title"),
    kind: text("kind").$type<VersionKind>().notNull().default("auto"),
    content: text("content").notNull(),
    createdBy: text("created_by"),
    createdByName: text("created_by_name"),
    commitSha: text("commit_sha"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("version_doc_number_idx").on(t.documentId, t.number)],
);

export const stars = pgTable(
  "star",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    starred: boolean("starred").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.userId] })],
);

/** When a user last opened a document, so the dashboard can sort by "recently opened". One row per (user, document). */
export const recents = pgTable(
  "recent",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    openedAt: timestamp("opened_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.documentId] }), index("recent_user_opened_idx").on(t.userId, t.openedAt.desc())],
);

/** Personal access tokens so agents and scripts can act on a user's behalf. Only a hash is stored. */
export const apiTokens = pgTable(
  "api_token",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Human label, e.g. "GitHub Copilot CLI". Shown as the agent's name in the app. */
    name: text("name").notNull(),
    /** First characters of the token for identification in lists. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** What the token may do, never more than its user: `read` (GET, watch, presence), `comment` (+ comments, suggestions, reviews, requests) or `full`. */
    scope: text("scope").$type<TokenScope>().notNull().default("full"),
    /** When set, the token only sees these documents; every other id answers 404. Null = all the user's documents. */
    documentIds: text("document_ids").array(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    /** Last time an MCP client listed tools with this token (`tools/list` on /api/mcp): the CLI is connected. */
    lastMcpSeenAt: timestamp("last_mcp_seen_at", { mode: "date", withTimezone: true }),
    /** Last time an MCP client called a tool with this token (`tools/call`): permissions were granted and it worked. */
    lastMcpCallAt: timestamp("last_mcp_call_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
);

/** Binary assets (images) embedded in documents. Bytes live in the database behind src/server/assets.ts. */
export const assets = pgTable(
  "asset",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("asset_document_idx").on(t.documentId), uniqueIndex("asset_document_sha_idx").on(t.documentId, t.sha256)],
);

export type Asset = typeof assets.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;

export type NotificationKind = "mention" | "reply" | "resolve" | "reopen" | "suggestion.accept" | "suggestion.reject" | "suggestion.accepted" | "review" | "share" | "request.done" | "webhook.disabled";

/**
 * Per-user notifications: @mentions, replies to and resolutions of threads they took part in,
 * decisions on their suggestions, documents shared with them. Replaces the former `mention` table
 * (migration 0008 copied its rows here with kind 'mention').
 */
export const notifications = pgTable(
  "notification",
  {
    id: text("id").primaryKey(),
    /** Lower-cased GitHub login of the recipient (they may not have signed in yet). */
    userLogin: text("user_login").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<NotificationKind>().notNull(),
    actorLogin: text("actor_login"),
    actorName: text("actor_name"),
    /** Thread, reply or suggestion id the notification is about; the document id for shares. */
    refId: text("ref_id").notNull(),
    snippet: text("snippet").notNull().default(""),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notification_user_kind_ref_idx").on(t.userLogin, t.kind, t.refId),
    index("notification_user_read_created_idx").on(t.userLogin, t.readAt, t.createdAt.desc()),
  ],
);

export type Notification = typeof notifications.$inferSelect;

export type ActivityAction =
  | "edit"
  | "comment.add"
  | "comment.reply"
  | "comment.resolve"
  | "comment.suggestion.accepted"
  | "comment.suggestion.rejected"
  | "review.create"
  | "suggestion.add"
  | "suggestion.accept"
  | "suggestion.reject"
  | "version.save"
  | "version.restore"
  | "publish"
  | "share.add"
  | "share.remove"
  | "asset.upload"
  | "mention"
  | "title.change"
  | "agent.request"
  | "agent.request.done";
export type ActorKind = "user" | "agent";

/** Per-document activity feed: who did what, when — humans and agents alike. `detail` never holds document text beyond short quotes. */
export const activity = pgTable(
  "activity",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    actorId: text("actor_id"),
    actorName: text("actor_name").notNull(),
    actorKind: text("actor_kind").$type<ActorKind>().notNull().default("user"),
    action: text("action").$type<ActivityAction>().notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_document_created_idx").on(t.documentId, t.createdAt.desc())],
);

export type Activity = typeof activity.$inferSelect;

export type AgentRequestMode = "suggest" | "comment" | "rewrite";
export type AgentRequestStatus = "open" | "claimed" | "done" | "cancelled";
export interface AgentRequestSelection {
  from: number;
  to: number;
  quote: string;
}
export interface AgentRequestResult {
  suggestions: number;
  comments: number;
  summary?: string;
}

/**
 * Work a human handed to agents from inside the editor ("Ask an agent"). Agents find open
 * requests across the documents their token's user can see, claim one, do the work with
 * the suggest/comment tools (linking by `requestId`) and complete it.
 */
export const agentRequests = pgTable(
  "agent_request",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    instruction: text("instruction").notNull(),
    selection: jsonb("selection").$type<AgentRequestSelection | null>(),
    mode: text("mode").$type<AgentRequestMode>().notNull().default("suggest"),
    status: text("status").$type<AgentRequestStatus>().notNull().default("open"),
    /** Token (agent) name that claimed the request. */
    claimedBy: text("claimed_by"),
    result: jsonb("result").$type<AgentRequestResult | null>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_request_document_status_idx").on(t.documentId, t.status), index("agent_request_status_created_idx").on(t.status, t.createdAt.desc())],
);

export type AgentRequest = typeof agentRequests.$inferSelect;

export type ReviewVerdict = "approve" | "request_changes" | "comment";

/**
 * A review card: one agent (or person) pass over a document that bundles several comment threads,
 * each possibly carrying a ```suggestion block, under a verdict and summary. Threads themselves live
 * in the shared Y.Doc; this row only remembers which ones belong together.
 */
export const reviews = pgTable(
  "review",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Agent (API token) that posted the review, when it was not the user directly. */
    agentTokenId: text("agent_token_id"),
    authorName: text("author_name").notNull(),
    verdict: text("verdict").$type<ReviewVerdict>().notNull().default("comment"),
    summary: text("summary").notNull().default(""),
    threadIds: jsonb("thread_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_document_created_idx").on(t.documentId, t.createdAt.desc())],
);

export type Review = typeof reviews.$inferSelect;

/**
 * Outbound webhooks: a user's HTTP endpoints that receive the same events `markdoc_watch` returns, pushed
 * instead of long-polled. `secret` is the HMAC key for `X-Markdoc-Signature`; it is shown once at creation
 * and never returned by the API again (it must be stored raw: a hash cannot sign).
 */
export const webhooks = pgTable(
  "webhook",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    /** Event types to deliver (see WEBHOOK_EVENTS in webhooks.ts). */
    events: jsonb("events").$type<string[]>().notNull().default([]),
    /** Only these documents, or null for every document the user can see. */
    documentIds: jsonb("document_ids").$type<string[] | null>(),
    active: boolean("active").notNull().default(true),
    /** Consecutive failed deliveries; reset on success, the hook is disabled at 20. */
    failures: integer("failures").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_user_idx").on(t.userId)],
);

export type Webhook = typeof webhooks.$inferSelect;

/** One delivery attempt of one event to one webhook; rows are kept for 7 days. */
export const webhookDeliveries = pgTable(
  "webhook_delivery",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    /** HTTP status of the response, or 0 when the request failed (timeout, refused). */
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_delivery_hook_created_idx").on(t.webhookId, t.createdAt.desc())],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Version = typeof versions.$inferSelect;
export type Collaborator = typeof collaborators.$inferSelect;
export type User = typeof users.$inferSelect;


