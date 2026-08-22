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
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { mode: "date", withTimezone: true }),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (t) => [index("api_token_user_idx").on(t.userId)],
);

export type ApiToken = typeof apiTokens.$inferSelect;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Version = typeof versions.$inferSelect;
export type Collaborator = typeof collaborators.$inferSelect;
export type User = typeof users.$inferSelect;


