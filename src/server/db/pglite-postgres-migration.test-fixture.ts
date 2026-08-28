import { PGlite } from "@electric-sql/pglite";

export async function seedMigrationFixture(source: PGlite): Promise<void> {
  const largeBytes = Buffer.alloc(1_048_579);
  for (let index = 0; index < largeBytes.length; index++) largeBytes[index] = index % 251;

  await source.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, login)
     VALUES ($1, $2, NULL, $3::timestamptz, NULL, $4)`,
    ["user-1", "Burké 🚀", "2026-08-27T01:02:03.654321Z", "burke"],
  );
  await source.query(
    `INSERT INTO account ("userId", type, provider, "providerAccountId", refresh_token, access_token, expires_at, token_type, scope, id_token, session_state)
     VALUES ($1, 'oauth', 'github', 'github-1', NULL, $2, 123456, 'bearer', 'repo', NULL, NULL)`,
    ["user-1", "account-access-value"],
  );
  await source.query(`INSERT INTO session ("sessionToken", "userId", expires) VALUES ('session-value', 'user-1', $1::timestamptz)`, [
    "2026-09-01T00:00:00.111222Z",
  ]);
  await source.query(
    `INSERT INTO "verificationToken" (identifier, token, expires) VALUES ('identity', 'verification-value', $1::timestamptz)`,
    ["2026-09-02T00:00:00.222333Z"],
  );
  await source.query(
    `INSERT INTO document (
       id, title, owner_id, storage, ystate, content, link_access, gist_id, gist_file,
       repo_owner, repo_name, repo_branch, repo_path, github_sha, published_content,
       published_at, created_at, updated_at, last_edited_by, deleted_at
     ) VALUES (
       'doc-1', $1, 'user-1', 'local', $2, $3, 'private', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL,
       $4::timestamptz, $5::timestamptz, $6::timestamptz, NULL, 'infinity'::timestamptz
     )`,
    [
      "Unicode café 🚀",
      Buffer.from([0, 1, 2, 255]),
      "# Unicode\n\nΚαλημέρα 世界",
      "2026-08-27T12:34:56.123456Z",
      "2026-08-26T01:02:03.000001Z",
      "2026-08-27T01:02:03.999999Z",
    ],
  );
  await source.query(
    `INSERT INTO collaborator (document_id, login, role, added_by, created_at)
     VALUES ('doc-1', 'collaborator', 'editor', NULL, $1::timestamptz)`,
    ["2026-08-27T02:03:04.123456Z"],
  );
  await source.query(
    `INSERT INTO version (id, document_id, number, title, kind, content, created_by, created_by_name, commit_sha, created_at)
     OVERRIDING SYSTEM VALUE
     VALUES ('version-1', 'doc-1', 7, NULL, 'named', $1, 'user-1', $2, NULL, $3::timestamptz)`,
    ["# Unicode\n\nΚαλημέρα 世界", "Burké", "2026-08-27T03:04:05.234567Z"],
  );
  await source.query(`INSERT INTO star (document_id, user_id, starred) VALUES ('doc-1', 'user-1', true)`);
  await source.query(`INSERT INTO recent (user_id, document_id, opened_at) VALUES ('user-1', 'doc-1', $1::timestamptz)`, [
    "2026-08-27T04:05:06.345678Z",
  ]);
  await source.query(
    `INSERT INTO api_token (
       id, user_id, name, prefix, token_hash, scope, document_ids, created_at,
       last_used_at, last_mcp_seen_at, last_mcp_call_at, expires_at, revoked_at
     ) VALUES (
       'api-token-1', 'user-1', 'Fixture agent', 'mk_fixture', 'fixture-token-hash',
       'full', ARRAY['doc-1'], $1::timestamptz, NULL, NULL, NULL, $2::timestamptz, NULL
     )`,
    ["2026-08-27T05:06:07.456789Z", "0001-02-03 04:05:06.123456+00 BC"],
  );
  await source.query(
    `INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data, created_at)
     VALUES ('asset-big', 'doc-1', 'user-1', 'large.bin', 'application/octet-stream', $1, 'big-hash', $2, $3::timestamptz)`,
    [largeBytes.length, largeBytes, "2026-08-27T06:07:08.567890Z"],
  );
  await source.query(
    `INSERT INTO asset (id, document_id, user_id, name, mime, size, sha256, data, created_at)
     VALUES ('asset-empty', 'doc-1', NULL, 'empty.bin', 'application/octet-stream', 0, 'empty-hash', $1, $2::timestamptz)`,
    [Buffer.alloc(0), "2026-08-27T06:07:09.000001Z"],
  );
  await source.query(
    `INSERT INTO notification (id, user_login, document_id, kind, actor_login, actor_name, ref_id, snippet, created_at, read_at)
     VALUES ('notification-1', 'burke', 'doc-1', 'mention', NULL, NULL, 'ref-1', '', $1::timestamptz, NULL)`,
    ["2026-08-27T07:08:09.678901Z"],
  );
  await source.query(
    `INSERT INTO activity (id, document_id, actor_id, actor_name, actor_kind, action, detail, created_at)
     VALUES ('activity-1', 'doc-1', NULL, 'Agent', 'agent', 'edit', $1::jsonb, $2::timestamptz)`,
    [JSON.stringify({ values: [1, null, "é"], nested: { enabled: true } }), "2026-08-27T08:09:10.789012Z"],
  );
  await source.query(
    `INSERT INTO agent_request (
       id, document_id, user_id, instruction, selection, mode, status, claimed_by, result, created_at, updated_at
     ) VALUES (
       'request-1', 'doc-1', 'user-1', 'Review this', $1::jsonb, 'suggest', 'done',
       'Fixture agent', $2::jsonb, $3::timestamptz, $4::timestamptz
     )`,
    [
      JSON.stringify({ from: 0, to: 4, quote: "# Uni" }),
      JSON.stringify({ suggestions: 1, comments: 0, summary: "Done" }),
      "2026-08-27T09:10:11.890123Z",
      "2026-08-27T09:11:12.901234Z",
    ],
  );
  await source.query(
    `INSERT INTO review (id, document_id, user_id, agent_token_id, author_name, verdict, summary, thread_ids, created_at)
     VALUES ('review-1', 'doc-1', 'user-1', 'api-token-1', 'Fixture agent', 'approve', '', $1::jsonb, $2::timestamptz)`,
    [JSON.stringify(["thread-1"]), "2026-08-27T10:11:12.012345Z"],
  );
  await source.query(
    `INSERT INTO webhook (id, user_id, url, secret, events, document_ids, active, failures, created_at)
     VALUES ('webhook-1', 'user-1', $1, 'webhook-secret-value', $2::jsonb, NULL, true, 0, $3::timestamptz)`,
    ["https://fixture.invalid/hook", JSON.stringify(["document.updated"]), "2026-08-27T11:12:13.123456Z"],
  );
  await source.query(
    `INSERT INTO webhook_delivery (id, webhook_id, event, status, duration_ms, attempt, created_at)
     VALUES ('delivery-1', 'webhook-1', 'document.updated', 200, 17, 1, $1::timestamptz)`,
    ["2026-08-27T12:13:14.234567Z"],
  );
}
