# Held PostgreSQL recovery collector

`scripts/postgres-recovery-collector.mts` is an offline, non-operational
compatibility validator. It reads caller-captured JSON projections from one
explicit absolute directory and emits one value-safe receipt. It cannot connect
to PostgreSQL or Azure, invoke a guest command, inspect the local host, perform a
backup or restore, or grant itself authority.

The v1 result always has `decision: "STOP"` because no collector execution
authority exists. A structurally invalid input has `decision: "MALFORMED"`.
`physical_compatible: true` is evidence inside a held receipt, not permission to
run a collector, restore data, recover a service, merge, release, or deploy.

## Separate responsibilities

| Boundary | Owner | v1 behavior |
| --- | --- | --- |
| Future capture | A later, exactly scoped one-shot guest authorization | May project only the listed value-safe facts. It must not run SQL, connect to PostgreSQL, contact Azure, perform backup/restore, or retain raw output. No such authorization exists today. |
| Validation | This offline collector | Reads the closed projection set, checks compatibility and policy, and emits the closed receipt. It has no command runner or network client. |
| Manager policy | A separately authenticated policy source | Supplies policy v1 and an authentication projection bound to this observation. Policy is not collector execution authority. |
| Isolated restore | A different, independently approved action | Produces a scratch-restore receipt only after an isolated restore and fail-closed cleanup. The collector cannot start or authorize that action. |

The detached policy authentication fields are a projection from the external
authority boundary, not authentication performed by this collector. The
collector binds its subject, version, SHA-256 payload digest, observation nonce,
freshness window, expiry, and one-use count. Missing, stale, future, replayed, or
altered authority stops the result.

## Closed input root

The input identity is `markdoc-postgres-recovery-projections/v1`. The directory
must contain exactly these 13 regular JSON files:

| File | Projection |
| --- | --- |
| `pg-version.json` | `PG_VERSION` major |
| `active-binary-version.json` | active binary upstream full version |
| `installed-package-version.json` | installed package version, parsed upstream full version, and last package change UTC |
| `control-data.json` | `pg_controldata` system identifier, retained in memory only |
| `pgbackrest-info.json` | stanza/repository status, backup completion/error and stop times, database/repository tuple, history tuple/version/system identifier, and incomplete-operation count |
| `archive-configuration.json` | enumerated effective WAL/archive settings, timeout, repository key, and last configuration change UTC |
| `archive-state.json` | status-directory presence, repository key, ready-file ages without names, spool error count, and unresolved-failure boolean |
| `backup-health.json` | sanitized status, observation UTC, repository/archive booleans, and operation-complete boolean |
| `scratch-restore.json` | status, completion UTC, isolation/cleanup booleans, and separate-authorization state |
| `production-binding.json` | typed binding kind/state and count, without resource identity |
| `observation-clock.json` | observation UTC, decision UTC, and a bounded observation nonce |
| `rpo-policy.json` | policy rows and their detached authentication projections |
| `vm-recovery.json` | discrete filesystem-consistent recovery kind and recovery-point UTC |

Every object has its own v1 `schema` discriminator. Unknown fields, raw output,
unknown files, symlinks, non-files, malformed JSON, invalid scalar formats, and
files over 1 MiB are malformed. A missing required file is STOP. Policy rows are
an array so zero and duplicate policies fail deterministically instead of one
silently replacing another.

Inputs are projections, not command lines, logs, configuration files, process
records, paths, WAL names, or package-manager output. The repository and database
keys exist only to join related projected rows in memory. They are never emitted.

## Policy v1

Policy identity is `markdoc-postgres-recovery-policy/v1`, subject
`markdoc-postgresql-recovery`, with these exact manager-approved values:

| Bound | Seconds |
| --- | ---: |
| Maximum unarchived data | 300 |
| Maximum observation age at decision | 900 |
| Maximum successful scratch-restore drill age | 604800 |

Authentication identity is
`markdoc-postgres-recovery-policy-authentication/v1`. Its authenticated UTC must
not be in the future or more than 900 seconds before the observation. Its expiry
must include the decision time. Its subject/version/digest must bind the exact
policy row, its nonce must bind the exact observation, and its use count must be
one.

These checks authenticate policy evidence only. The schema deliberately has no
collector execution-authority field, so an input root cannot turn v1 into an
operational collector.

## Evaluation

The validator:

1. Selects the newest backup by `timestamp.stop` from backups that are both
   complete and non-error. An equal newest stop time is ambiguous.
2. Matches that backup's `(database.id, database.repo_key)` to exactly one
   history row. It never uses history array order or the newest history row.
3. Requires the data, active binary, and selected backup history majors to
   match. A different minor within one major is allowed evidence; it is not an
   incompatibility by itself.
4. Requires the active full version to equal the installed package's parsed
   upstream full version and compares live/history system identifiers only in
   memory.
5. Requires one healthy repository, matching archive repositories, the expected
   effective archive configuration, a present status directory, no spool error,
   no unresolved archive failure, and fresh healthy sanitized health.
6. Requires a successful, separately authorized, isolated scratch restore with
   complete cleanup. Its completion must follow the latest package or archive
   configuration change and be no more than 604800 seconds old.

The unarchived-data bound has exactly one formula:

```text
archive_timeout_seconds + oldest_pending_archive_age_seconds
```

The pending age is zero only when the ready-file projection is empty. With one
or more ready files, it is the maximum projected age. The bound is unavailable
when repository, configuration, status, spool, failure, health, clock, or policy
evidence is not established.

The discrete VM recovery point and pgBackRest-plus-WAL evidence remain separate
receipt objects. The VM time is a discrete filesystem-consistent point only.
Backup stop times, archive timestamps, WAL names, scratch completion, and
collector observation time are never labeled as an exact latest-restorable UTC.

## Closed receipt

The receipt identity is
`markdoc-postgres-recovery-compatibility/v1`. Its allowlist is:

- UTC observation and typed binding count;
- active/installed versions, data/backup majors, equality booleans, and physical
  compatibility;
- effective-configuration boolean, archive timeout, pending count/age, spool
  error count, health age, conservative unarchived bound, objective, and result;
- discrete VM recovery kind/time with `pitr: false`;
- scratch freshness booleans; and
- `STOP`/`MALFORMED` plus enumerated reason codes.

It never includes system identifiers, observation nonces, policy digests, paths,
PIDs, WAL names, stanza/repository/database/resource identities, command lines,
logs, tokens, configuration text, or unlisted input values.

## Local validation only

The CLI requires `--input-root` and accepts no target, connection, command,
authorization, restore, or network option. It writes only the receipt to stdout.
STOP exits 1 and MALFORMED exits 2.

The unit fixture suite creates disposable input roots under the operating
system's temporary directory, evaluates each root in forward and reverse check
order, requires byte-equivalent receipt objects, and removes every root in
`finally` plus the suite parent in `afterAll`.
