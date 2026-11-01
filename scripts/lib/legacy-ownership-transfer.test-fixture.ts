import * as Y from "yjs";
import type { TRANSFER_COUNT_LABELS } from "./legacy-ownership-transfer";

/** Shared seed for the PGlite unit test and the PostgreSQL integration test. */
export const FIXTURE = {
  sourceLogin: "legacy-dev",
  sourceId: "legacy-user-id-0001",
  targetLogin: "target-gh",
  targetId: "target-user-id-0001",
  otherId: "other-user-id-0001",
  accountId: "83699999",
  oauthToken: "oauth-token-must-not-be-output",
  privateEmail: "private-target@example.test",
} as const;

export const FIXTURE_TABLES = [
  "account",
  "activity",
  "agent_request",
  "api_token",
  "asset",
  "collaborator",
  "document",
  "notification",
  "ownership_transfer",
  "recent",
  "review",
  "session",
  "star",
  "user",
  "verificationToken",
  "version",
  "video_upload",
  "video_upload_part",
  "webhook",
  "webhook_delivery",
] as const;

export const FIXTURE_EXPECTED_DRY_RUN: Record<(typeof TRANSFER_COUNT_LABELS)[number], number> = {
  "document.owner_id moved": 2,
  "document.last_edited_by updated": 1,
  "version.created_by updated": 5,
  "collaborator.added_by updated": 1,
  "collaborator.login moved": 1,
  "collaborator.login deduplicated": 1,
  "collaborator.login owner_deleted": 2,
  "star.user_id moved": 1,
  "star.user_id deduplicated": 1,
  "recent.user_id moved": 1,
  "recent.user_id deduplicated": 1,
  "api_token.user_id moved": 1,
  "asset.user_id moved": 1,
  "video_upload.user_id moved": 1,
  "agent_request.user_id moved": 1,
  "review.user_id moved": 1,
  "webhook.user_id moved": 1,
  "folder.owner_id moved": 1,
  "activity.actor_id updated": 1,
  "activity.actor_id agent_prefix updated": 1,
  "notification.user_login moved": 1,
  "notification.user_login deduplicated": 1,
  "notification.actor_login updated": 1,
  "document.ystate identity metadata (not rewritten)": 1,
  "user deleted": 1,
};

export type FixtureQuery = (text: string, values?: unknown[]) => Promise<unknown>;

/**
 * The verified production shape plus one row for every move, dedup and refusal path: a legacy user with
 * two documents, six versions and one last_edited_by; a target user with a GitHub account and seven
 * documents; a third user; and a document where both users have a `recent` row.
 */
export async function seedLegacyOwnershipFixture(q: FixtureQuery): Promise<void> {
  const { sourceLogin, sourceId, targetLogin, targetId, otherId, accountId, oauthToken, privateEmail } = FIXTURE;
  await q(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login) VALUES
       ($1, 'Legacy Dev', $2, NULL, NULL, $3),
       ($4, 'Target Person', $5, now(), 'https://images.example.test/private', $6),
       ($7, 'Other Person', 'other@example.test', now(), NULL, 'other')`,
    [sourceId, `${sourceLogin}@dev.local`, sourceLogin, targetId, privateEmail, targetLogin, otherId],
  );
  await q(
    `INSERT INTO account ("userId", type, provider, "providerAccountId", access_token, token_type, scope)
     VALUES ($1, 'oauth', 'github', $2, $3, 'bearer', 'read:user')`,
    [targetId, accountId, oauthToken],
  );
  await q(`INSERT INTO session ("sessionToken", "userId", expires) VALUES ('target-session', $1, now() + interval '7 days')`, [targetId]);
  await q(`INSERT INTO "verificationToken" (identifier, token, expires) VALUES ('kept', 'kept-secret', now() + interval '1 day')`);

  // Source documents: doc-a (last edited by the source, comment authored by the source) and doc-b.
  await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by, ystate) VALUES ('doc-a', 'A', $1, 'alpha', $1, $2)`, [sourceId, identityYState(sourceId)]);
  await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by) VALUES ('doc-b', 'B', $1, 'beta', $2)`, [sourceId, targetId]);
  for (let number = 1; number <= 4; number++) {
    await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ($1, 'doc-a', $2, 'a', $3, 'Legacy Dev')`, [`ver-a-${number}`, number, sourceId]);
  }
  await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ('ver-b-1', 'doc-b', 1, 'b', $1, 'Legacy Dev')`, [sourceId]);
  await q(`INSERT INTO version (id, document_id, number, content, created_by, created_by_name) VALUES ('ver-b-2', 'doc-b', 2, 'b2', $1, 'Target Person')`, [targetId]);

  // Target documents.
  for (let index = 1; index <= 7; index++) {
    await q(`INSERT INTO document (id, title, owner_id, content, last_edited_by) VALUES ($1, $2, $3, 't', $3)`, [`doc-t${index}`, `T${index}`, targetId]);
  }
  await q(`INSERT INTO version (id, document_id, number, content, created_by) VALUES ('ver-t1-1', 'doc-t1', 1, 't', $1)`, [targetId]);
  // Other user's documents: doc-o1 (source is a collaborator, added by the source) and doc-o2 (both are collaborators).
  await q(`INSERT INTO document (id, title, owner_id, content) VALUES ('doc-o1', 'O1', $1, 'o'), ('doc-o2', 'O2', $1, 'o')`, [otherId]);

  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o1', $1, 'editor', $2)`, [sourceLogin, otherId]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o1', 'someone', 'viewer', $1)`, [sourceId]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-o2', $1, 'viewer', $3), ('doc-o2', $2, 'editor', $3)`, [sourceLogin, targetLogin, otherId]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-t2', $1, 'commenter', $2)`, [sourceLogin, targetId]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-b', $1, 'editor', $2)`, [targetLogin, sourceId]);
  await q(`INSERT INTO collaborator (document_id, login, role, added_by) VALUES ('doc-t3', 'other', 'viewer', $1)`, [targetId]);

  await q(`INSERT INTO star (document_id, user_id) VALUES ('doc-a', $1), ('doc-t1', $1), ('doc-t1', $2), ('doc-o1', $3)`, [sourceId, targetId, otherId]);
  await q(`INSERT INTO recent (user_id, document_id, opened_at) VALUES ($1, 'doc-t1', now() - interval '2 days'), ($2, 'doc-t1', now() - interval '1 day'), ($1, 'doc-b', now()), ($3, 'doc-o1', now())`, [sourceId, targetId, otherId]);

  await q(`INSERT INTO api_token (id, user_id, name, mention_slug, prefix, token_hash) VALUES ('tok-legacy', $1, 'Copilot', 'copilot', 'mk_l', 'hash-legacy'), ('tok-target', $2, 'Reviewer', 'reviewer', 'mk_t', 'hash-target')`, [sourceId, targetId]);
  await q(`INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data) VALUES ('asset-legacy', 'doc-a', $1, 'a.png', 'image/png', 1, 'sha-a', $3), ('asset-target', 'doc-t1', $2, 't.png', 'image/png', 1, 'sha-t', $3)`, [sourceId, targetId, Buffer.from([1])]);
  await q(`INSERT INTO video_upload (id, document_id, user_id, name, mime, size, chunk_count, storage_key, state) VALUES ('video-upload-legacy', 'doc-a', $1, 'walkthrough.webm', 'video/webm', 2, 1, 'legacy/video/walkthrough.webm', 'complete')`, [sourceId]);
  await q(`INSERT INTO video_upload_part (upload_id, part_index, size, sha256) VALUES ('video-upload-legacy', 0, 2, 'video-chunk-sha')`);
  await q(`INSERT INTO agent_request (id, document_id, user_id, instruction) VALUES ('req-legacy', 'doc-a', $1, 'tidy'), ('req-target', 'doc-t1', $2, 'tidy')`, [sourceId, targetId]);
  await q(`INSERT INTO review (id, document_id, user_id, author_name) VALUES ('rev-legacy', 'doc-b', $1, 'Legacy Dev'), ('rev-target', 'doc-t2', $2, 'Target')`, [sourceId, targetId]);
  await q(`INSERT INTO webhook (id, user_id, url, secret) VALUES ('hook-legacy', $1, 'https://example.test/legacy', 'legacy-hook-secret'), ('hook-target', $2, 'https://example.test/target', 'target-hook-secret')`, [sourceId, targetId]);
  await q(`INSERT INTO webhook_delivery (id, webhook_id, event, status, duration_ms) VALUES ('del-legacy', 'hook-legacy', 'document.updated', 200, 5), ('del-target', 'hook-target', 'document.updated', 200, 5)`);
  // One folder each, under names that do not collide: folder_owner_name_idx is unique on
  // (owner_id, lower(name)), and the transfer refuses outright when the two owners share a name.
  await q(`INSERT INTO folder (id, name, owner_id) VALUES ('fold-legacy', 'Legacy work', $1), ('fold-target', 'Target work', $2)`, [sourceId, targetId]);

  await q(`INSERT INTO activity (id, document_id, actor_id, actor_name, action) VALUES ('act-user', 'doc-a', $1, 'Legacy Dev', 'edit'), ('act-agent', 'doc-a', $2, 'Copilot CLI', 'comment.add'), ('act-target', 'doc-t1', $3, 'Target', 'edit'), ('act-other', 'doc-o1', $4, 'Other', 'edit')`, [sourceId, `agent:${sourceId}:Copilot CLI`, targetId, otherId]);
  await q(
    `INSERT INTO notification (id, user_login, document_id, kind, actor_login, ref_id, snippet) VALUES
       ('note-move', $1, 'doc-o1', 'mention', 'other', 'thread-1', ''),
       ('note-dup-source', $1, 'doc-o2', 'share', 'other', 'doc-o2', ''),
       ('note-dup-target', $2, 'doc-o2', 'share', 'other', 'doc-o2', ''),
       ('note-actor', 'other', 'doc-o1', 'reply', $1, 'thread-2', ''),
       ('note-target', $2, 'doc-t1', 'mention', 'other', 'thread-3', '')`,
    [sourceLogin, targetLogin],
  );
}

/** Every row of every table as canonical JSON text, so two states can be compared exactly. */
export async function snapshotFixtureTables(
  query: <T extends Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>,
): Promise<Record<(typeof FIXTURE_TABLES)[number], string[]>> {
  const result = {} as Record<(typeof FIXTURE_TABLES)[number], string[]>;
  for (const table of FIXTURE_TABLES) {
    const exists = await query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [`"${table}"`]);
    if (!exists.rows[0]?.present) {
      result[table] = [];
      continue;
    }
    const rows = await query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM "${table}" t`);
    result[table] = rows.rows.map((row) => row.row).sort();
  }
  return result;
}

export function fixtureSecrets(): string[] {
  return [
    FIXTURE.sourceId,
    FIXTURE.targetId,
    FIXTURE.otherId,
    FIXTURE.sourceLogin,
    FIXTURE.targetLogin,
    FIXTURE.accountId,
    FIXTURE.oauthToken,
    FIXTURE.privateEmail,
    "legacy-hook-secret",
    "hash-legacy",
  ];
}

function identityYState(userId: string): Uint8Array {
  const document = new Y.Doc();
  try {
    const thread = new Y.Map<unknown>();
    document.getMap("comments").set("thread-1", thread);
    thread.set("authorId", userId);
    thread.set("authorName", "Legacy Dev");
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}
