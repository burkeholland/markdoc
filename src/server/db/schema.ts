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
import { sql } from "drizzle-orm";
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

/**
 * A folder groups its owner's documents. One level only: a folder never holds another folder (#2377).
 *
 * A folder is an organizing layer and nothing more — it carries no access of its own, so a document's
 * `folder_id` never widens who can read it. Sharing a folder is #2380, and that is the change that has
 * to teach `getDocumentAccess()` and `visibleDocuments()` about folders.
 */
export const folders = pgTable(
  "folder",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("folder_owner_idx").on(t.ownerId),
    // Two folders of one owner may not share a name, compared case-insensitively, so the sidebar never
    // shows two rows a person cannot tell apart. Different owners are free to reuse a name.
    uniqueIndex("folder_owner_name_idx").on(t.ownerId, sql`lower(${t.name})`),
  ],
);

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
    /**
     * The folder holding this document, or null for the top level. Always a folder of the document's
     * own owner. Deliberately unrelated to `repoPath`: a GitHub-backed document's folder here says
     * nothing about where the file sits in its repository (#2377).
     *
     * `set null` on delete is a safety net only. Deleting a folder sends its documents to the trash
     * first (`deleteFolder()`), so a document never silently reappears at the top level.
     */
    folderId: text("folder_id").references(() => folders.id, { onDelete: "set null" }),
    /** Latest Yjs document state (full update). */
    ystate: bytea("ystate"),
    /** Latest Markdown text, denormalized for listing, search, and export. */
    content: text("content").notNull().default(""),
    linkAccess: text("link_access").$type<LinkAccess>().notNull().default("private"),
    /**
     * Whether link previews (Slack, Teams, iMessage unfurls) of a restricted document show its title and
     * first lines instead of the generic Markdoc card. Owner-only; a link-shared document always shows them.
     */
    linkPreview: boolean("link_preview").notNull().default(false),
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
  (t) => [
    index("document_owner_idx").on(t.ownerId),
    // "What is in this folder" on every dashboard render.
    index("document_folder_idx").on(t.folderId),
  ],
);

export const gistAutoUpdates = pgTable("gist_auto_update", {
  documentId: text("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  /** Consent belongs to this identity, never to a transferee. Owner changes disable it in the save trigger. */
  publisherId: text("publisher_id").notNull(),
  gistId: text("gist_id").notNull(),
  filename: text("filename").notNull(),
  accountLogin: text("account_login").notNull(),
  isPublic: boolean("is_public").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull(),
  generation: text("generation").notNull(),
  queuedVersion: integer("queued_version").notNull().default(1),
  syncedVersion: integer("synced_version").notNull().default(0),
  activeVersion: integer("active_version"),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").$type<"off" | "pending" | "syncing" | "synced" | "failed" | "conflict">().notNull().default("off"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  message: text("message"),
}, (t) => [index("gist_auto_update_due_idx").on(t.enabled, t.status, t.dueAt)]);

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
  (t) => [
    primaryKey({ columns: [t.documentId, t.login] }),
    // Login-first lookups ("every document shared with me") in visibleDocuments() and
    // collectUserEvents() cannot use the (document_id, login) primary key.
    index("collaborator_login_idx").on(t.login),
  ],
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

/**
 * Server-only outbox for a whole-document PUT whose required audit version must become durable.
 * One row per document serializes recovery; no route exposes this table to connected clients.
 */
export const requiredVersionIntents = pgTable("required_version_intent", {
  documentId: text("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  versionId: text("version_id").notNull().unique(),
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  kind: text("kind").$type<VersionKind>().notNull(),
  title: text("title"),
  createdBy: text("created_by"),
  createdByName: text("created_by_name"),
  applied: boolean("applied").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});

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
    /** Normalized name used by @mentions; null after revocation so the name can be reused. */
    mentionSlug: text("mention_slug"),
    /** First characters of the token for identification in lists. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** What the token may do, never more than its user: `read` (GET, watch, presence), `comment` (+ comments, suggestions, reviews, requests) or `full`. */
    scope: text("scope").$type<TokenScope>().notNull().default("full"),
    /** When set, the token only sees these documents; every other id answers 404. Null = all the user's documents. */
    documentIds: text("document_ids").array(),
    /** Owner switch: other users may address requests to this agent (`@owner/slug`). Off = the owner alone (#1296). */
    collaboratorsMayAsk: boolean("collaborators_may_ask").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    /** Last time an MCP client listed tools with this token (`tools/list` reported by markdoc-mcp to POST /api/agent/mcp-activity): the CLI is connected. */
    lastMcpSeenAt: timestamp("last_mcp_seen_at", { mode: "date", withTimezone: true }),
    /** Last time an MCP client called a tool with this token (`tools/call`): permissions were granted and it worked. */
    lastMcpCallAt: timestamp("last_mcp_call_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("api_token_user_idx").on(t.userId), uniqueIndex("api_token_user_mention_slug_unique").on(t.userId, t.mentionSlug)],
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
    /** Every `@user/Agent` target parsed from the complete body before the display snippet is clipped. */
    agentTargets: text("agent_targets").array(),
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
 * Work a human handed to agents from inside the editor ("Ask an agent"). A request is addressed to one
 * agent — the `@login/slug` mentioned in the comment (owner login + token mention slug, lower-cased) — or to
 * none (`agent_login` null: the requester's own tokens). Only the addressee's owner-token lists, claims and
 * completes it; `claimed_by_login` tells two users' same-named tokens apart.
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
    /** Comment thread (in the shared Y.Doc) the request was made from, when it came from a comment. */
    threadId: text("thread_id"),
    /** Addressee: the mentioned agent's owner login (lower-cased); null = unaddressed (rows from before 0019 too). */
    agentLogin: text("agent_login"),
    /** Addressee: the mentioned agent's mention slug (lower-cased; `api_token.mention_slug`), stored by name so a rotated token keeps receiving. */
    agentSlug: text("agent_slug"),
    mode: text("mode").$type<AgentRequestMode>().notNull().default("suggest"),
    status: text("status").$type<AgentRequestStatus>().notNull().default("open"),
    /** Token (agent) name that claimed the request. */
    claimedBy: text("claimed_by"),
    /** Owner login (lower-cased) of the token that claimed it; null on rows claimed before 0019. */
    claimedByLogin: text("claimed_by_login"),
    result: jsonb("result").$type<AgentRequestResult | null>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_request_document_status_idx").on(t.documentId, t.status),
    index("agent_request_status_created_idx").on(t.status, t.createdAt.desc()),
    index("agent_request_document_thread_idx").on(t.documentId, t.threadId),
    index("agent_request_agent_status_idx").on(t.agentLogin, t.agentSlug, t.status),
  ],
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

export type OwnershipTransferStatus = "applied" | "rolled_back";

/**
 * Rollback record written by `scripts/transfer-legacy-ownership.mts` in the same transaction as the
 * transfer it describes: the deleted source `user` row, every (table, pk, column, old value) it changed
 * and the fingerprints `--rollback` must see before it reverses them. Never read by the app.
 */
export const ownershipTransfers = pgTable("ownership_transfer", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  sourceUserJson: jsonb("source_user_json").$type<Record<string, unknown>>().notNull(),
  movedRowsJson: jsonb("moved_rows_json").$type<unknown[]>().notNull(),
  postFingerprintsJson: jsonb("post_fingerprints_json").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<OwnershipTransferStatus>().notNull().default("applied"),
});

export type OwnershipTransfer = typeof ownershipTransfers.$inferSelect;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type Version = typeof versions.$inferSelect;
export type Collaborator = typeof collaborators.$inferSelect;
export type User = typeof users.$inferSelect;
