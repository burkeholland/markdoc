# Held PostgreSQL recovery collector

`scripts/postgres-recovery-collector.mts` is an offline, non-operational
compatibility validator. It reads caller-captured JSON projections from one
explicit absolute directory and emits one value-safe receipt. It cannot connect
to PostgreSQL or Azure, invoke a guest command, inspect the local host, perform a
backup or restore, or grant itself authority.

The public v1 CLI always has `decision: "STOP"` because it accepts no authority
argument. A structurally invalid authenticated input has `decision:
"MALFORMED"`. Library evaluation may set `physical_compatible: true` only after
three externally accepted roots authenticate capture, policy, and scratch
evidence. Even then, `HELD_NON_OPERATIONAL` keeps the decision STOP: evidence is
not permission to run a collector, restore data, recover a service, merge,
release, or deploy.

## Separate responsibilities

| Boundary | Owner | v1 behavior |
| --- | --- | --- |
| Future capture | A later, exactly scoped one-shot guest authorization | May project only the listed value-safe facts and create a manifest. Its manager caller must separately accept the capture root. It must not run SQL, connect to PostgreSQL, contact Azure, perform backup/restore, or retain raw output. No such authorization exists today. |
| Validation | This offline collector | Acquires the external trust roots first, then the manifest and closed projection set, checks compatibility and policy, and emits the closed receipt. It has no command runner or network client. |
| Manager policy | A separately authenticated policy source | Supplies policy v1 and a caller-owned accepted policy root bound to its exact bytes and observation. Policy is not collector execution authority. |
| Isolated restore | A different, independently approved action | Supplies a caller-owned accepted scratch root that binds the exact receipt bytes, subject, authorization, cleanup, and times. The collector cannot start or authorize that action. |

## External authority roots

Authority never comes from the input directory. A future manager-owned library
caller must provide three accepted references. The public CLI supplies none.

`markdoc-postgres-recovery-accepted-authority-reference/v1` binds each external
root's absolute lexical path, native realpath, device/inode identity, byte count,
SHA-256, and kind. The capture reference additionally binds the accepted input
root's absolute path, native realpath, and device/inode identity. Recomputing a
manifest or authority file cannot change this caller-owned identity.

The referenced canonical root schemas are:

| Identity | Exact role |
| --- | --- |
| `markdoc-postgres-recovery-capture-authority/v1` | Accepted status, production subject, capture-operation identity, observation nonce, acceptance/expiry, one-shot use, and exact manifest logical name/bytes/SHA-256. |
| `markdoc-postgres-recovery-policy-authority/v1` | Accepted policy subject, observation nonce, authentication/expiry, one-shot use, and exact policy logical name/bytes/SHA-256. |
| `markdoc-postgres-recovery-scratch-authority/v1` | Accepted scratch subject, separate authorization, observation nonce, completion/authentication/expiry, isolation and cleanup, one-shot use, and exact receipt logical name/bytes/SHA-256. |

The capture root must authenticate before the manifest path is opened. Policy
and scratch roots also authenticate before any projection path is opened.
Missing, altered, future, stale, replayed, self-asserted, or relation-mismatched
authority returns a value-empty STOP receipt.

## Closed input root

The input identity is `markdoc-postgres-recovery-projections/v1`. Its directory
must contain exactly `capture-manifest.json` plus these 13 regular projection
files:

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
unknown files, symlinks, hard links, aliases, non-files, malformed JSON, invalid
scalar formats, and files over 1 MiB fail closed. A missing required file is
STOP. Policy rows are an array so zero and duplicate policies fail
deterministically instead of one silently replacing another.

Inputs are projections, not command lines, logs, configuration files, process
records, paths, WAL names, or package-manager output. The repository and database
keys exist only to join related projected rows in memory. They are never emitted.

The manifest identity is
`markdoc-postgres-recovery-capture-manifest/v1`. It contains the exact production
binding subject, `markdoc-postgres-value-safe-capture/v1` operation identity,
observation nonce/time, expiry, one-shot use, and a sorted 13-member list. Each
member has only its exact logical name, byte count, and SHA-256.

JSON bytes are UTF-8 without a BOM and must equal the collector's canonical
encoding: Unicode-code-point object-key order, NFC strings, no insignificant
whitespace or alternate escapes, and safe integers only. Fatal UTF-8, UTF-16,
duplicate/prototype keys, malformed surrogate pairs, non-NFC strings, and
noncanonical bytes are rejected before the typed projection parser.

The collector opens directories and files as held descriptors. On systems with
`O_NOFOLLOW` it uses that flag; on every system it binds pre-open, descriptor,
post-open, lexical path, native realpath, device/inode, link count, size, mode,
and change-time fingerprints. It reads every authority, manifest, and projection
twice from its descriptor, enforces exact size and EOF, then keeps every
descriptor open through receipt generation. Before returning, it rereads
authority roots, manifest, and all projections in that trust order, repeats
the input census, then performs one terminal descriptor-only read pass and one
terminal closed-root/path-fingerprint verification without caller callbacks.
Any replacement or drift returns a value-empty STOP receipt.

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
one. Those projected authentication fields are additionally content-bound by
the external policy authority root; the input file cannot authenticate itself.

These checks authenticate policy evidence only. No projection or manifest field
can create an accepted authority reference, so an input root cannot turn v1 into
an operational collector.

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
An unsupported VM kind, future point, or stale observation makes both VM claim
fields unavailable.
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
Because no manager caller supplies external roots, it stops before reading the
input root. STOP exits 1 and MALFORMED exits 2. Its current receipt is exactly:

```json
{
  "schema": "markdoc-postgres-recovery-compatibility/v1",
  "observed_at": null,
  "binding_count": null,
  "engine": {
    "active_full": null,
    "installed_full": null,
    "data_major": null,
    "backup_major": null,
    "same_major": null,
    "full_versions_equal": null,
    "same_system_id": null,
    "physical_compatible": false
  },
  "archive": {
    "effective_config_matches": null,
    "archive_timeout_seconds": null,
    "pending_count": null,
    "oldest_pending_age_seconds": null,
    "spool_error_count": null,
    "health_age_seconds": null,
    "unarchived_age_bound_seconds": null,
    "objective_seconds": null,
    "meets_objective": null
  },
  "vm_recovery": {
    "kind": null,
    "pitr": false,
    "recovery_point_utc": null
  },
  "scratch_restore": {
    "fresh_after_engine_change": null,
    "within_drill_age": null
  },
  "decision": "STOP",
  "reasons": ["CAPTURE_AUTHORITY_ABSENT"]
}
```

The unit fixture suite creates disposable input roots under the operating
system's temporary directory. It preserves the original compatibility matrix and
adds descriptor-boundary, authority, manifest, encoding, symlink, hard-link,
rename, replacement, replay, and self-grant attacks. Both evaluator orders must
produce identical receipt objects. Every root is removed in `finally`, with the
suite parent removed again in `afterAll`.
