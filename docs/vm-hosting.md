# VM-hosted production

The September 4, 2026 hosting change co-locates Markdoc with PostgreSQL on
`markdoc-pg`, avoiding the fixed cost of a VNet-integrated Container Apps
environment. Application releases use the [configured terminal command](#terminal-release-command)
or the manual [Deploy to Azure (manual) workflow](../.github/workflows/deploy.yml),
not Container Apps or `deploy/azure.ps1`.

## What is known

This September 6 composition brings reviewed documentation from
`70d67fb846fa1a1dc76041b529056a6b94d5fa90` into the local feature candidate
`316dfdf3ce939fcf94c79e990dfe3e6437dd21ea`. Its workflow and VM release script
were at that composition byte-identical to the broader hosting source at
`64829d514fc96a217a99a3bbfa4d6d375c996037`; other infrastructure changes from
that source are not included. Historical infrastructure claims below remain
dated records, not claims about this candidate's older helpers.

Nonsecret Azure metadata was supplied by the lead/manager, including the
lead's bounded guest readback during the 18:24:35 UTC cycle, follow-ups at
19:02:30 and 19:04:17 UTC, the rollback-bundle outcome through 19:23:20 UTC,
the pinned-restore attempt at 19:41:00 UTC, and the single scratch diagnostic
at 19:57:26.989 UTC. The documentation work
itself made no cloud, site, guest, database or backup calls. The lead's
observations, same-host preservation and backup restore do not establish a
release, a readable recovered database or full database health.

| Item | Recorded value and evidence |
| --- | --- |
| Public origin | `https://markdoc.app` (apex, Cloudflare DNS-only A record to `markdoc-web-ip` = `20.62.106.80`). The Azure DNS label `markdoc-burkeholland.eastus2.cloudapp.azure.com` on `markdoc-web-ip` stays in place and only redirects to it; see [Public domain](#public-domain-markdocapp). No former Container Apps endpoint is a fallback. |
| Resource group and VM | `markdoc-rg` (hyphen), `markdoc-pg`; supplied metadata says Linux, provisioning `Succeeded`, VM agent enabled, and `markdoc-web-ip` attached to `markdoc-pg-nic/primary`. |
| Azure context | Lead confirmed tenant `f1fde69f-c8d3-4b94-adeb-02d045b37f6a` and enabled subscription `332d0c98-694c-48a0-91f3-465de6ac30a5`. This is not proof of guest command access or workflow identity permissions. |
| Application service | Lead observed `markdoc-app.service` loaded, active, running at `/etc/systemd/system/markdoc-app.service`; systemd working directory empty. Source writes a Docker unit with host networking, 768 MiB memory and 0.6 CPU; unit contents/resource limits were not read back. |
| Container | Lead observed the existing `markdoc-app` container running, working directory `/app`. The follow-up confirmed its image reference/local image presence and read process liveness as detailed below. |
| Environment and unit files | Lead observed `/etc/markdoc/markdoc.env` and `/etc/systemd/system/markdoc-app.service` as regular root-owned files, both mode `0600`, by stat only. That readback displayed no contents or environment variable names/values. Source reuses the environment file and changes `APP_VERSION`; the later protected copies are recorded under rollback. |
| Registry and identity | September 4 record: `markdocacrmnd542unepl56.azurecr.io`, VM identity with `AcrPull` and `Key Vault Secrets User`. Source uses managed-identity authentication for pull and removes Docker login state on exit. Current role assignments/pull success are unverified. |
| Proxy and TLS | Lead observed `nginx.service` loaded, active, running. September 4 record describes Let's Encrypt and `certbot.timer`; proxy configuration, certificate and timer state were not read back. |
| Database | Lead's local peer, read-only catalog query reported database `markdoc`, current schema `public`, PostgreSQL `16.15` (Ubuntu `16.15-0ubuntu0.24.04.1`). `postgresql.service` was loaded/active/exited, an umbrella-service state, not evidence that the database is stopped. September 4 record gives the same `Standard_B1ms` VM at `10.42.2.4:5432`; data directory and app connection target remain unverified. |
| Migration ledger | Lead read 19 rows (IDs 1-19) from `drizzle.__drizzle_migrations`; every hash and journal ordering time matched source migrations `0000` through `0018`. Pending migrations and upgrade/rollback limits are detailed below. |

The observed container image reference was
`markdocacrmnd542unepl56.azurecr.io/markdoc@sha256:21546bc69066d93d3c7844af139e7925b3b838c4c63bb6fd87ae840abfb7c313`.
The reported local image ID was also
`sha256:21546bc69066d93d3c7844af139e7925b3b838c4c63bb6fd87ae840abfb7c313`.
The 19:04:17 UTC ID-only image inspection established local presence, not
registry availability or ability to pull. Two combined image-format reads
failed; they did not obtain image size or OCI version metadata. A later
isolated `Image.Size` read at 19:18:30 UTC succeeded: **994602519 bytes**.
That does not erase or explain the earlier failures; OCI version metadata
remains unobtained and container OCI labels were absent. The separate archive
size and same-host retention evidence are recorded under [rollback](#rollback).

At 19:02:30 UTC, the existing app's local `/api/health?probe=live` reported
`ok=true`, `probe=live`, `collab=true` and
`version=6e251b1d047ed82427717ef595ef6872e95af3b5`.
This is the running process's self-reported source, not cryptographic image
attestation or a newly accepted release artifact. The liveness route skips
database opening; no full health request, migration, environment-file read or
image-environment read was performed for that readback.

The container's internal port is **3000 on the Linux VM** (`Dockerfile` and
the release script). It is not the retired Windows development server. Do not
restart that server or launch an independent application writer as a release
step. Production must continue using the existing PostgreSQL database; a new
PGlite store is not a fallback.

## Source selection and schema boundary

The older five-feature candidate
`a459a429516affa21ebc1345d8023b6da6462ddd`, based on `8332080`, and the broader
hosting commit `64829d514fc96a217a99a3bbfa4d6d375c996037` were separate inputs.
The locally source-reviewed successor
`316dfdf3ce939fcf94c79e990dfe3e6437dd21ea` already preserves the feature changes
and imports exactly `.github/workflows/deploy.yml` and
`infra/deploy-vm-image.sh` from that hosting source. This documentation successor
adds only the reviewed deployment documentation and its composition seams; it does not
import the broader infrastructure changes or replace feature documentation.
**Do not run its old infrastructure helpers**, including `deploy/azure.ps1`
with or without `-InfraOnly`: the non-`-InfraOnly` refusal in the broader
hosting source is absent here.

Local source acceptance is **not production or performance acceptance**.
The maximum-latency target failed, the final runtime is unmeasured, and
recovery/upgrade work remains incomplete. Neither `316dfdf` nor this
documentation successor is approved for production. The accepted release SHA
and new image digest remain to be established. The protected same-host
rollback bundle below is concrete, but image loading, old-binary compatibility
and independent custody are unproven; the source association is a self-report.

**An image release is not necessarily schema-neutral.** The historical hosting
source ships migrations through `0019`; this feature candidate also includes
`0020_gist_auto_update.sql`. The lead's explicit ledger/source comparison
matched all 19 applied rows to `0000` through `0018`. The latest,
`0018_agent_request_thread`, has `created_at=1788050213330` and SQL SHA-256
`ae9d2c70a1e222bd8fa4f90e9b8d8b6147f234bb9cc9289e9ce8a429b952916a`.
`created_at` is the source migration journal's ordering time, **not the actual
deployment/application time**.

Both following migrations are pending against that observation:

| Migration | Journal ordering time | Reviewed SQL SHA-256 |
| --- | --- | --- |
| `0019_agent_request_addressee` | `1788219322678` | `1dfe57b0a3563fd6cd37b659d322849839b299d415b27daa6ddfab16c2f6d1a8` |
| `0020_gist_auto_update` | `1788622003570` | `838c5b636a46353e9eceeb58934568dbe0eb730472263cdf27ee7daf43a21146` |

The lead's catalog read found `agent_request` and `api_token` present, but
0019's new `agent_login`, `agent_slug`, `claimed_by_login`,
`collaborators_may_ask` columns and `agent_request_agent_status_idx` absent.
The document columns required by 0020 exist; its new queue table, function,
document-update trigger and index are absent. No user rows were read or changed.

Both migrations are additive DDL without a reset or removal of existing user
data in their SQL, but 0019 takes table/index locks and 0020 adds an
`AFTER UPDATE` document trigger. Static additivity and catalog matches do not
prove an executed PostgreSQL upgrade, old-image compatibility or preservation
of all data. Restoring the older image leaves the new columns/table/trigger
in place; the trigger can continue maintaining the queue.

[`Dockerfile`](../Dockerfile) includes `drizzle` in the image, and
[`src/server/db/index.ts`](../src/server/db/index.ts) runs Drizzle migrations
when opening the database (`DRIZZLE_MIGRATIONS_DIR` overrides the folder).
The reviewed migrator selects migrations newer than the latest journal time
and applies pending SQL/ledger entries in one transaction. It neither runs
down-migrations nor automatically validates existing ledger hashes; the lead's
hash comparison was explicit and did not invoke it.

The deployment script has no separate migration step, but starting the image
can therefore mutate schema. Before dispatch, the release owner must compare
the final accepted image's migration hashes with the observed ledger and
reviewed pending SQL, assess the PostgreSQL upgrade and previous-image
compatibility, and establish the backup/recovery requirements. Those outcomes
have not been demonstrated by this metadata readback. If unresolved, do not
start the candidate. This runbook adds no automatic migration, reset,
initialization, PGlite-to-PostgreSQL transfer, repair or schema rollback command.

## Release

Only the release owner runs this **mutating** workflow, after the source,
performance, schema and recovery requirements above are resolved. It was not
run for this documentation update.

1. Record the accepted full 40-character commit SHA and retain the previous
   image by immutable digest with its matching SHA. Preserve the same-host
   bundle below and establish image/configuration restoration and custody;
   its existence alone does not prove them. The script's temporary copies
   remain separate, not a durable rollback archive. Schedule one operator with
   no overlapping infrastructure, patch, recovery or other database writer work.
2. In **Deploy to Azure (manual)**, select the accepted ref and enter `deploy`
   for `confirm`. The workflow builds the selected checkout's `GITHUB_SHA`,
   not an arbitrary SHA from a description; verify it matches the accepted
   commit. `AZURE_RESOURCE_GROUP` must name `markdoc-rg`, and
   `AZURE_ACR_NAME` must name the existing registry.
3. The workflow builds in ACR with full/12-character SHA tags and
   `APP_VERSION`, resolves the immutable digest, then sends
   [`infra/release-wal-gate.sh`](../infra/release-wal-gate.sh) before
   [`infra/deploy-vm-image.sh`](../infra/deploy-vm-image.sh) in one VM Run
   Command on `markdoc-pg`. The deployment script invokes the gate and refuses
   to continue without its operation-bound receipt. Only after the gate proves
   exact release-endpoint replay and removes its scratch cluster does the script
   pull the digest, update only `APP_VERSION` in the existing environment file,
   replace the application unit and restart `markdoc-app`. It does not
   reprovision or restart primary PostgreSQL.
4. The script waits for local `/api/health` to report `ok`, `db` and `collab`
   true and `version` equal to the requested full SHA. The workflow then
   resolves `markdoc-web-ip`'s DNS name and requires the same fields at the
   public HTTPS endpoint. This is a single-service restart, not an ACA
   revision/traffic switch; no zero-downtime or no-data-loss claim follows.
5. Record the actual source SHA, immutable digest, prior artifact, observed
   service/health metadata and interruption/failure outcome. Health/version
   alone does not prove feature behavior, the applied schema or recovery.
   The release owner completes the requested feature checks before calling
   the release successful.

### Terminal release command

[`deploy/release-vm.ps1`](../deploy/release-vm.ps1) uses the existing ACR build
and VM Run Command route with the current operator's Azure CLI context.
It needs PowerShell 7.2+, Git, tar and Azure CLI on Windows; no local Docker,
GitHub OIDC setup, new identity, secret copy or infrastructure command is involved.
The release owner must resolve the source/performance/schema/recovery requirements
above before executing it. Adding this entrypoint is not a deployment or approval.

The configured workflow supplies pinned Node 22 before the command. Its policy
CLI runs directly from repository source and needs no repository dependency
install. Before Azure resource validation or any source archive/build, VM,
database or production mutation, the command binds the working
`package-lock.json` to the exact bytes committed at the selected SHA, runs one
package audit with no retry, rechecks the lock and withholds raw output. It
accepts only the bounded pass report with an empty package list and all blocked,
severity, vulnerability, reported and omitted counts equal to zero.

The current lock resolves the audited transitive packages to
`fast-uri@3.1.8`, `qs@6.16.0`, `hono@4.13.8`, `js-yaml@4.3.2` and
`sharp@0.35.4`. The bounded dependency preflight reports zero blocked,
severity, vulnerability, reported and omitted counts. Workflow setup, a merge,
audit evidence or this documentation update neither invokes nor approves a
release.

The Board release command (run from the composed project's root) is:

```powershell
pwsh -NoProfile -NonInteractive -File .\deploy\release-vm.ps1
```

The Board supplies `RELEASE_SHA`. For a separately authorized terminal release,
pass `-ExpectedCommit` with the accepted full 40-hex SHA; it must agree with
`RELEASE_SHA` if both are present. Both paths require clean `main` at that exact
commit, including no untracked source. An immutable Git archive, not the working
directory or ignored local files, supplies the build and guest script.
`RELEASE_VERSION` is a Board label; image `APP_VERSION` remains the full SHA.
`RELEASE_PREVIOUS_SHA` does not request an automatic rollback.

All nonsecret defaults are already wired: subscription
`332d0c98-694c-48a0-91f3-465de6ac30a5`, tenant
`f1fde69f-c8d3-4b94-adeb-02d045b37f6a`, resource group `markdoc-rg`, ACR
`markdocacrmnd542unepl56` / `markdocacrmnd542unepl56.azurecr.io`, VM `markdoc-pg`,
public IP `markdoc-web-ip` with Azure DNS name
`markdoc-burkeholland.eastus2.cloudapp.azure.com`, and public origin
`https://markdoc.app`.
The command rejects another subscription/tenant/cloud, registry, VM/NIC/IP
association or Azure DNS name, and checks public health only on `markdoc.app`. It neither signs in interactively nor changes
the active account. The guest still uses its managed identity and existing
root-owned `0600` `/etc/markdoc/markdoc.env` for `markdoc-app`.

The command reconciles the accepted ACR QuickRun by polling a bounded recent-run
window for the unique submission tag, so a successful Azure CLI call does not
depend on returning a run ID. It then waits for ACR success, requires a single
well-formed digest for the full-SHA tag matching that build's output, and makes
one VM invocation containing the WAL gate and existing deployment script.
Before image pull, environment
change, unit rewrite or service start, the gate creates an operation-named
restore point, captures its exact WAL record LSN, performs an explicit
`pg_switch_wal()`, and waits for PostgreSQL's
exact `.done` archive-status object for the containing segment. pgBackRest's
documented asynchronous archive push returns success only after safely storing
that segment in the archive. The gate additionally reads repository metadata to
identify repository 1's current archive ID, then requires `repo-ls` to expose
the exact checksum-suffixed WAL object in that archive. It binds that basename
to the release receipt without printing the repository path. It restores from
the same repository to a fresh invocation-owned directory with that LSN as the
recovery target, starts PostgreSQL with no network listener on a private socket
and unused port, polls for SQL readiness while recovery finishes, requires
`archive_mode=off` and a replay LSN at or beyond the captured endpoint, then
stops and removes that scratch cluster.
It does not fetch or copy WAL outside recovery, alter archive state, checkpoint
or restart the primary, change recovery configuration, use the weekly
restore-check directory, or connect to an application database.

The scripts now require the fifth argument, a guest invocation UUID. Terminal
success requires one exact ordered capture/switch/remote-archive/restore/SQL/
replay/cleanup evidence block bound to that UUID and containing the exact WAL
segment and remote object basename. It must be followed by the local-health
ready marker, the invocation-specific completion marker, and non-redirected
public `/api/health` with boolean `ok`, `db`, `collab` all true and `version`
exactly the selected SHA. Missing, duplicate, malformed, reordered,
wrong-operation, wrong-object or replay-behind evidence fails closed. ARM
transport success alone never suffices.
A public failure after guest readiness is a failed/unverified release, **not** an
automatic rollback. Existing local rollback restores configuration/image only;
it does not undo schema changes.

The local deadline is 35 minutes. Build polling stops by roughly 12.5 minutes
and the ACR build itself has a ten-minute service timeout. The guest
gate is phase-bounded: lock acquisition is nonblocking, archive wait is five
minutes, restore ten minutes, scratch start four minutes, SQL recovery readiness
ten minutes, each control query 30 seconds, and cleanup gets a separate
45-second stop. Cleanup targets only the invocation's directory/process. Cloud
queue/upload/pull and startup durations are not guaranteed to fit. On failure
or timeout, do not press Release again before reconciling the prior attempt: no
write is resubmitted, but killing the CLI does **not** cancel remote work.
Output records the unique submission tag and the reconciled ACR run ID, then
the VM resource, guest invocation UUID and start time. The high-level VM CLI
does not expose its ARM operation ID; the guest UUID is instead retained in Run
Command parameters/output for targeted owner reconciliation. Failure to find
one unique tagged run leaves Azure acceptance unknown. Raw build/VM/HTTP output
is withheld. The protected rollback bundle and diagnostics are not terminal
scratch space.

### September 24 release-gate verification

Bounded production-safe diagnostics found that the backup system was healthy:
pgBackRest 2.59.1, PostgreSQL 16, seven recorded backups, no archive failures,
about 20 GB free on the PostgreSQL volume, and a successful weekly isolated
restore marker about 4.6 days old. The release-specific restore failed because
pgBackRest 2.59.1 rejects `--lock-timeout` for the `restore` command with error
`031`; both `0` and `30` were invalid. The gate already wraps restore in a hard
ten-minute process timeout, so removing the unsupported option preserves a
bounded failure path.

The next rehearsal restored successfully but reached the SQL check while
PostgreSQL was still replaying and temporarily reported that it was not
accepting connections. `pg_ctl -w` did not establish the stronger condition
the gate needed. The gate now polls that exact SQL readiness condition for at
most ten minutes.

A later release target landed exactly on a WAL segment boundary. That byte
position is not itself a WAL record, so PostgreSQL exhausted the archived
segment and exited because the configured LSN target was never encountered.
The gate now creates an operation-named PostgreSQL restore point and uses its
returned record LSN as both the archive proof and replay threshold. Operation
`af9d6b09-43e3-4000-b2f0-e35f4797e6c7` proved the corrected complete gate:
captured restore-point LSN `F/81000090`, exact segment and checksum-suffixed
repository object archived, scratch restore and SQL readiness succeeded, replay
reached exactly `F/81000090`, and owned cleanup succeeded. The application
image was not pulled or restarted during this rehearsal.

## Public domain (markdoc.app)

Production moved from the shared Azure name to `https://markdoc.app` after
Google Safe Browsing flagged `markdoc-burkeholland.eastus2.cloudapp.azure.com`
as phishing. `.app` is on the HSTS preload list, so browsers only ever use
HTTPS for it: the certificate must exist before anyone opens the site.

| Piece | Value |
| --- | --- |
| DNS (Cloudflare, **DNS only**, grey cloud) | `A markdoc.app -> 20.62.106.80`, `CNAME www -> markdoc.app`. The Cloudflare proxy must stay off: certbot validates over plain HTTP on the VM, and nginx terminates TLS itself. |
| Certificates | Let's Encrypt `markdoc.app` (covers `markdoc.app` and `www.markdoc.app`) plus the existing `markdoc-burkeholland.eastus2.cloudapp.azure.com`; both renew through `certbot.timer`. |
| nginx | [`infra/nginx-markdoc.conf`](../infra/nginx-markdoc.conf) is the source for `/etc/nginx/sites-available/markdoc`. `markdoc.app` proxies to the app on `127.0.0.1:3000`; `www.markdoc.app`, the Azure name and plain HTTP redirect to `https://markdoc.app` with the same path and query (`301` for pages, `308` for `/api/*` so writes keep their method). |
| App environment (`/etc/markdoc/markdoc.env`) | `AUTH_URL=https://markdoc.app`, `MARKDOC_URL=https://markdoc.app`, `MARKDOC_CANONICAL_HOST=markdoc.app`. |
| GitHub OAuth app | Homepage URL `https://markdoc.app`, authorization callback URL `https://markdoc.app/api/auth/callback/github`. |

Cutover order (each step reversible until the OAuth change):

1. Wait until `Resolve-DnsName markdoc.app` and `Resolve-DnsName www.markdoc.app` return `20.62.106.80`.
2. On the VM: `certbot certonly --nginx --cert-name markdoc.app -d markdoc.app -d www.markdoc.app`. This only issues the certificate; nginx config is unchanged.
3. Back up `/etc/nginx/sites-available/markdoc` and `/etc/markdoc/markdoc.env`, install `infra/nginx-markdoc.conf`, `nginx -t`, `systemctl reload nginx`.
4. Set the three environment values above and `systemctl restart markdoc-app.service`.
5. Update the GitHub OAuth app (GitHub allows one callback URL, so the old origin stops signing in; it only redirects now anyway).
6. Verify `https://markdoc.app/api/health` reports `ok`, `db`, `collab` true, that the old name answers `301` to `https://markdoc.app/...`, and that GitHub sign-in completes.

Rollback before step 5: restore both backups, `nginx -t && systemctl reload nginx`, restart `markdoc-app.service`. After step 5, also set the OAuth callback back to the Azure name.

## Health and safe diagnostics

For an authorized operational read, use bounded nonsecret metadata:
service active/substate and restart count, container image digest, environment
file owner/mode only, and the health fields `ok`, `db`, `collab`, `version`
at `https://markdoc.app/api/health`.
Do not print environment values, full units/container inspection, user data
or unfiltered journals into reports.

The source is **not** guaranteed secret-free on failure:
`infra/deploy-vm-image.sh` prints the last 100 journal lines if the new image
does not become ready, and the workflow prints the VM command result. Treat
that output as potentially sensitive, not as a safe diagnostic transcript.
This documentation does not change that behavior. The later lead preflight's
filtered pgBackRest help included an INFO start line with nonsecret repository
context; no production log was inspected to establish tool-local logging.
That report is not a blanket no-log assertion, and successful transport did
not make the subsequent resource-stop outcome a successful restore.

## Backup metadata and unknowns

[`infra/postgres-recovery.sh`](../infra/postgres-recovery.sh) defines daily
pgBackRest full backups (`markdoc-pgbackrest-full.timer`, 02:30 UTC), daily
logical backups (`markdoc-logical-backup.timer`, 03:30 UTC), two-minute backup
monitoring, and a weekly isolated restore check
(`markdoc-restore-check.timer`, Sunday 05:00 UTC, two-hour service timeout).
Those schedules are configuration, not evidence that the timers are currently
installed, enabled or succeeding.

The September 6 lead readback supplied these **file-stat observations only**:

| File | Observed metadata |
| --- | --- |
| `/etc/pgbackrest/pgbackrest.conf` | Regular file, owner `postgres`, mode `0640`; contents not read. |
| `/var/lib/pgbackrest/logical-last-success` | Empty regular file, owner `postgres`, mode `0640`, mtime `2026-09-06T03:30:29.652526990Z`. |
| `/var/lib/pgbackrest/restore-last-success` | Empty regular file, owner `postgres`, mode `0640`, mtime `2026-09-06T05:16:22.466795403Z`. |

Marker names/mtimes do not identify a recoverable backup or prove its contents,
custody, point-in-time recovery coverage, restore compatibility or data-loss
bounds. The later lead readback obtained existing pgBackRest `info` metadata
for stanza `markdoc`, beyond those stat-only observations:

| Recorded backup metadata | Value |
| --- | --- |
| Stanza status code / backup records | `0` / `7` |
| Newest backup and newest full | `20260906-023651F`, type `full`, `error=false` |
| Start | `2026-09-06T02:36:51Z` (Unix seconds `1788662211`) |
| Stop | `2026-09-06T02:36:59Z` (Unix seconds `1788662219`) |
| Database size | `37710898` bytes |
| Repository size | `7364389` bytes |

This identifies an existing recorded artifact, not object completeness,
checksum/restore verification, continuous WAL coverage, custody/retention or
an acceptable release-time recovery point. Logical dump identity was not
queried. No backup contents were read and no backup, restore, retention or
pruning action was performed in those metadata readbacks.

The lead's first attempt to restore that exact backup stopped on the load
guard at 19:22:14 UTC: load 1.548828125 exceeded one CPU, although disk and
memory still passed. It stopped **before creating any scratch directory,
restoring a backup or starting scratch PostgreSQL**. That attempt produced no
scratch restore/catalog or actual `0019` + `0020` upgrade result; no production
database, service, configuration or traffic changed. It ended without a retry
or load-polling loop.
The post-02:36:59 UTC WAL/recovery point remains unproven: at the stop time
that was a 16h45m15s unknown recoverability interval, not evidence of missing
or lost writes/WAL. The image/configuration export does not establish RPO.

In a separately authorized continuation, fresh capacity passed at 19:38:48 UTC.
At 19:41:00 UTC, one pgBackRest restore pinned to `20260906-023651F` completed
with exit 0, but scratch PostgreSQL startup returned exit 1. The reported
cleanup was stop status 3 / stopped, with the scratch directory removed;
execution lasted 14.8 seconds. This is a completed artifact restore, **not a
recovered/readable database**, catalog result, `0019` + `0020` upgrade,
old-binary compatibility or post-backup WAL/RPO proof. That attempt did not
classify the startup failure; its scratch logs were removed.
The protected rollback bundle was untouched and no image was exported again.

The lead's full diagnostic report records one separately authorized attempt
starting at 19:57:26.989 UTC. Its fresh, unchanged capacity guard passed:
20,696,924,160 bytes free, 968,376,320 bytes available memory, and load
0.16845703125 on one CPU. Restoring the same `20260906-023651F` artifact
returned 0; scratch startup returned 1 and the catalog query was not reached.
Owned data/socket were postgres-owned `0700`, independent configuration files
`0600`, all nonsymlinks; restored `PG_VERSION` was 16.

Before cleanup, bounded on-host classification of scratch `postgres.log`
matched `wal_or_checkpoint_unavailable`, `startup_process_failed` and
fatal/PANIC; `launch.log` matched `could_not_start_server`. No permission,
configuration-syntax or version-incompatibility category matched; that is not
an exhaustive exclusion. Startup is now classified as **WAL/checkpoint-related**,
but the exact mechanism remains unknown: this family does not distinguish
archive access, scratch restore-command routing, an invalid checkpoint or
genuinely absent WAL. It does **not** establish missing/lost/corrupt production
WAL or data, or that the backup is broken. No specific safe setting correction
was established, so none was applied and there was no second diagnostic attempt.
Cleanup stop returned 1, status returned 3 (stopped), and the exclusive scratch
data and raw logs were removed after 15.8 seconds. The protected rollback bundle
was unchanged, with no re-export. No readable recovered database, upgrade,
old-binary compatibility or post-02:36:59 UTC WAL/RPO proof follows.

The [September 4 egress record](https://github.com/burkeholland/markdoc/blob/64829d514fc96a217a99a3bbfa4d6d375c996037/docs/postgres-egress.md#current-production-state)
reports a successful pgBackRest restore drill before the network change.
Earlier infrastructure records describe Azure VM backup policy
`daily-7-days`. Neither establishes current recoverability. A readable recovered
database, durable backup retention, WAL coverage, current Azure protection
status and an acceptable recovery point for this release are **unknown here**.
A timer, recorded backup metadata, a historical drill or an application health
response cannot substitute for those facts.

The existing restore-check helper is mutating even though its restore target
is scratch by design: it writes logs/configuration/a marker and uploads a
result. It selects the latest backup rather than pinning the label above;
neither its existence nor the marker proves that artifact was restored.
No restore helper was executed for the metadata readback. The separately
authorized artifact-pinned outcomes above do not establish that this existing
helper succeeded or that the restored backup yielded a usable database.

## Rollback

The lead retained `/var/lib/markdoc-rollback-20260906T191204Z-j385wv1k` on
the same host. **It MUST NOT be cleaned up as temporary scratch.** Stat
readback at 19:23:20 UTC confirmed root/root ownership, directory mode `0700`
and `0600` files: `image.tar`, `markdoc.env`, `markdoc-app.service` and
`metadata.json`. The environment and unit copies each passed silent comparison
(`cmp` exit 0); image export returned 0. Metadata recorded the complete bundle
at 19:22:14.166288 UTC, including the observed image ID and process-reported
source above. Protected contents were not displayed. The image archive is
**994621952 bytes**, SHA-256
`f5f6691296d2a66f1554ded9424742c04832393bce19dee6f53b84873ee100a7`.

This is a durable same-host image/configuration copy, not a database backup,
registry/pull guarantee or independent/off-host custody. It has not been
loaded or used to prove old-binary compatibility, and retention across loss
of this VM/filesystem is unestablished. Any separately authorized recovery
continuation should reuse this bundle, not export a second one. The resource
stop above left no scratch process running and changed no production service.

On script failure before local readiness, the exit handler attempts to restore
the prior environment and systemd unit and restart the old application. Its
rollback health test requires `ok`, `db` and `collab`, but does not compare the
old version. It deletes the temporary rollback directory when cleanup finishes.
The separately retained bundle does not change this workflow behavior or
retroactively make its temporary copies durable.

A public health/version failure **after** the script reports local readiness
fails the workflow but does not trigger that handler's rollback. The release
owner must assess the state rather than assume the old image is running.
For a later application rollback, the existing VM script accepts the retained
previous digest and its matching full SHA, subject to the schema-compatibility
decision above; verify both local and public version afterward. There is no
Container Apps revision to reactivate.

Application rollback does not undo PostgreSQL schema changes or data writes,
prove that a backup is restorable, or guarantee that every in-flight edit was
saved. Do not reset or restore the database merely because an image fails.
Any database recovery is a separate owner-controlled operation.

## Maintenance tools

Do not recreate the retired `markdoc-maint` Container Apps Job. One-off repair,
backup, recovery, OS patching and infrastructure work are not application
release steps. A separate VM maintenance plan must establish the required
tool image, protected environment, single-writer coordination and recovery
evidence before any write; this page does not authorize a second container
or supply repair/migration commands.

See the [README release summary](../README.md#production-runbook-vm-application-releases)
and [infrastructure scope/history](infra-deploy.md). Old Container Apps,
private-only VM and Windows-server procedures are historical, not fallback
routes for the current deployment.
