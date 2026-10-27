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
`package-lock.json` to the exact bytes committed at the selected SHA, runs the
package audit, rechecks the lock and withholds raw output. It accepts only the
bounded pass report with an empty package list and all blocked, severity,
vulnerability, reported and omitted counts equal to zero, or the accepted
report described under [Accepted advisories](#accepted-advisories). An advisory whose
optional fields npm sends as null, such as a CVSS vector, still counts as a
finding. Each audit attempt gets 120 seconds. The preflight retries once, after
2 seconds, only when an attempt printed nothing on stdout or exactly npm's
string-only `{"error":{...}}` object, and ended with an error exit or signal,
a failed start or a timeout. Any other output, including a malformed report
or an error object with extra top-level keys, is judged and never retried.
Audit reports must have exactly `auditReportVersion`, `vulnerabilities` and
`metadata` at the top level; unknown keys fail closed as `malformed_audit`.
A timed-out attempt never passes: a report it printed
counts as `rejected` when it is a complete report with findings and as
`malformed_audit` otherwise. A `command_failed` report adds a `reason` built
only from fixed pieces, never from npm's own text: how the attempt ended (exit
code, signal name, timeout or start error code), npm's error code from that
exact error object's `code` or a whole stderr line like `npm error code E401`,
accepting only a whole `E[A-Z0-9_]{1,24}` code, and the attempt number, for
example `npm audit exit 1, npm code E401 (attempt 2 of 2)`. On failure the
command prints at most the preflight status and, for `command_failed`, a
reason in exactly that format. If the reason does not match that format, it
prints only that the raw output was withheld.

`malformed_audit` can mean cut-off or invalid JSON, wrong field types, or a
top-level key other than `auditReportVersion`, `vulnerabilities` and `metadata`.
On a trusted machine, check the top-level key names without printing values:

```powershell
npm audit --package-lock-only --json | node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(Object.keys(o).join(','))"
```

The current report prints `auditReportVersion,vulnerabilities,metadata`. A new
key needs a human to review it and update `parseAuditJson`; it is never a reason
to bypass the preflight.

#### Locked tarballs

For every entry of `package-lock.json`, `npm ci` installs the tarball in the
entry's `"resolved"` field, checked against `"integrity"`, into the folder in
the entry's path. It never compares that tarball with the entry's `"name"` and
`"version"`. `npm audit` and both lists of the policy look only at those two
fields. A lock edited by hand could therefore name one package and version and
install another: with real npm, an entry for `lodash` `4.17.20` that claimed
another name, or that claimed version `4.18.1`, got 0 audit findings and was
installed all the same (#2297).

So the preflight judges the lock before it runs the audit, and refuses it with
the status `invalid_lock` unless every entry other than the root passes all of
these:

1. Its key is nothing but package folders, each directly inside a
   `node_modules` folder: `node_modules/<package>`, repeated with `/` between,
   such as `node_modules/a/node_modules/@scope/b`. No folder is called
   `node_modules`. npm reads a key as a path and names an entry without a
   `"name"` field after the last folder that comes out: with the key
   `node_modules/lodash/../harmless` and the honest tarball of `lodash`
   `4.17.20`, real npm asked `npm audit` about `harmless`, found nothing, and
   `npm ci` filled `node_modules/harmless` with `lodash` `4.17.20`. So a dot
   segment, an empty segment, a trailing slash, a backslash, a leading `./` or
   `/`, an encoded character, or anything else that is not a package folder
   refuses the lock, and the name in the path is always the last folder of the
   whole key. The entry has no `"link"` field. This repository has no
   workspace, no `file:` dependency and no link. npm installs those from a
   folder on disk, which the preflight cannot judge.
2. Its `"version"` is written the one way the registry stores it: three
   numbers without leading zeros and an optional prerelease, such as `1.2.3`
   or `5.0.0-beta.32`, with no leading `v` and no build metadata (`+...`). The
   feed also serves the tarball of `6.15.3` when it is asked for `v6.15.3`,
   `06.15.3` or `6.15.3+x`, and neither `npm audit` nor `BLOCKED_DEPENDENCIES`
   recognises those spellings.
3. Its `"resolved"` is, character for character,
   `https://<host>/1es-public/_packaging/npm-public/npm/registry/<name>/-/<base name>-<version>.tgz`.
   `<name>` is the name the entry is judged by: its `"name"` field when it has
   one, as an alias does, otherwise the name in its path. `<base name>` is that
   name without its scope, and `<version>` is its `"version"`. `<host>` is one
   of the four hosts that serve the package feed without a login:
   `ms-feed-2.pkgs.visualstudio.com`, `ms-feed-12.pkgs.visualstudio.com`,
   `ms-feed-17.pkgs.visualstudio.com` and `ms-feed-25.pkgs.visualstudio.com`.
   The text is compared, never parsed as a URL. Another host, `http`, a user
   name, a port, a query, a fragment, an encoded character, another letter
   case, a dot segment, the right file name under another package's folder,
   another version, a git or `file:` URL: each is simply another text.
4. An entry may lack `"resolved"` only when npm fetches nothing for it because
   it arrives inside another package's tarball: it has `"inBundle": true`, and
   the entry one folder up (its path without the last `/node_modules/<name>`)
   passes rule 3 itself and names it in `"bundleDependencies"`. Today these
   are the six packages inside `@tailwindcss/oxide-wasm32-wasi`. Without
   `"resolved"` npm would fetch `<name>@<version>` from whatever registry the
   machine is configured for. A package that brings bundled packages its
   entry does not name in `"bundleDependencies"`, or that nests them more
   than one folder down, is refused today: for `npm` `10.9.2`, real npm wrote
   215 bundled entries and this rule refuses 147 of them. The command and the
   test below name them. Widening the rule is a reviewed change of its own,
   with proof from real npm of what `npm ci` does for a bundled entry added by
   hand at each depth.

The preflight also answers `invalid_lock`, before any audit runs, while
anything called `npm-shrinkwrap.json` stands next to `package-lock.json`. npm
reads `npm-shrinkwrap.json` instead of `package-lock.json` when a folder holds
both, so `npm audit --package-lock-only` would judge a file the policy never
reads, while the image is built from `package.json` and `package-lock.json`
alone: with a shrinkwrap that held `lodash` `4.18.1` next to a lock that held
`lodash` `4.17.20`, real npm reported 0 findings. This repository has no
`npm-shrinkwrap.json`; delete one that appears. If it appears while the audit
runs, the status is `lock_mismatch`.

After that, the package and version that `npm audit`, `BLOCKED_DEPENDENCIES`
and `ACCEPTED_ADVISORIES` judge are the ones `npm ci` asks the feed for, and
the folder they are judged in is the folder `npm ci` fills. The
rule is code in `parsePackageLock` in `scripts/lib/dependency-policy.ts`; no
environment variable, flag or command-line option turns it off or adds a host.

A refused lock stops the release with
`Dependency preflight failed (status invalid_lock); raw output withheld.` The
report carries the status and nothing about the entry. To see which entries
are refused and why, on a trusted machine:

```powershell
node --no-warnings --experimental-strip-types -e "import('./scripts/lib/dependency-policy.ts').then((policy) => console.log(policy.packageLockProblems(require('node:fs').readFileSync('package-lock.json', 'utf8'))))"
```

It prints `[]` for a lock that passes, otherwise one line per entry with its
reason. The unit test `accepts every entry of this repository's
package-lock.json` in `scripts/lib/dependency-policy.test.ts` prints the same
list, so a pull request that changes the lock finds out in CI and not at the
next release.

The feed's proxy decides which host it writes into `"resolved"`. If npm itself
writes a host that is not in the list, that test fails in the pull request
that brings it. Check first that the new host serves the same feed without a
login: request a tarball that the lock already holds from it, with no
credentials, and compare the hash with the entry's `"integrity"`. Then add the
host to `PACKAGE_FEED_REGISTRIES` in `scripts/lib/dependency-policy.ts` and to
rule 3 above in the same pull request; a test fails while the two do not name
the same hosts. `ms-feed-1` to `ms-feed-28` exist, but all except the four
ask for a login, and a name that does not exist yet could be registered by
anyone, so the list is never widened to a pattern. In every other case
change the lock, not the rule.

What this rule does not prove:

- That the tarball has the hash in `"integrity"`. `npm ci` checks that itself
  and fails with `EINTEGRITY` when it does not.
- What a bundled package holds. A package that brings others inside its own
  tarball installs those copies whatever the lock says about them, even when
  the lock has no entry for them.
- Which npm the image has. It takes `node:22-alpine` as it comes, with
  whatever npm 10 that brings (#2318). npm 10 and npm 11 do not leave the same
  entries out of production; [What production needs](#what-production-needs)
  is the rule that makes them agree.
- How npm is configured on the machine that installs (#2262).

#### What production needs

The image installs with `npm ci --omit=dev`, so a package that only the linter
or the tests need is not in production. The rule for
[accepted advisories](#accepted-advisories) has to know which packages those
are. The lock says it twice, with the mark `"dev": true` on an entry and with
what each entry depends on, and npm itself does not always read the same one.
Measured with real npm (#2308):

- npm 10 (`10.9.4` and `10.9.9`; the image has npm 10) believes the mark
  as long as `package.json` needs what the lock's root entry needs. It then
  leaves out exactly the entries marked `"dev": true`. A production package
  with the mark added by hand was not installed, and a linter package with
  the mark taken off was installed. When the two do not need the same, npm 10
  works it out from what each entry depends on, as npm 11 does.
- npm 11 (`11.12.1`) does not read the mark. It leaves out the entries
  production does not need, which it works out from what each entry depends
  on. A production package with the mark added by hand was installed.
- Both take what the project itself needs from `package.json`, not from the
  lock's root entry. With a package moved from `devDependencies` to
  `dependencies` in `package.json` and the lock left as it was, both installed
  the package, although the lock still called it a devDependency and marked
  it `"dev": true`.

So an entry is surely absent from production only when the mark and the
dependencies both say so and `package.json` agrees with the lock. The
preflight works out what production needs itself, and answers `invalid_lock`,
before any audit runs, unless all of these hold:

1. Every package production needs has an entry. The preflight starts at the
   root entry's `dependencies`, `optionalDependencies` and `peerDependencies`
   (not its `devDependencies`). It finds each name the way npm and Node do, in
   the nearest `node_modules` folder going up from the entry that needs it:
   for a name `x` that `node_modules/a` needs, `node_modules/a/node_modules/x`
   when the lock has that entry, otherwise `node_modules/x`. From every entry
   it finds it goes on through that entry's `dependencies`,
   `optionalDependencies`, `peerDependencies` (optional peers too) and the
   names in its `bundleDependencies`. Every entry reached this way is one
   production needs. An alias is found by its folder. Only three kinds of
   name may have no entry, because npm leaves them out of a lock itself: an
   optional dependency, a peer that `peerDependenciesMeta` marks
   `"optional": true`, and a name that is only in `bundleDependencies`. Any
   other name without an entry refuses the lock: nothing could say what
   `npm ci` would install in its place.
2. The marks say the same as rule 1, in both directions. An entry production
   needs has no `"dev": true`: npm 11 would install it whatever the mark says.
   Every other entry has `"dev": true`: npm 10 would install it without the
   mark. Only a lock in which both agree installs the same production tree on
   npm 10 and on npm 11, and it is the only kind npm writes.
3. The `package.json` next to the lock has the same five records as the
   lock's root entry: `dependencies`, `devDependencies`,
   `optionalDependencies`, `peerDependencies` and `peerDependenciesMeta`. A
   record that is missing equals an empty one, and the order of the names
   does not matter. A name that is in both `dependencies` and
   `optionalDependencies` counts in `optionalDependencies` only, on either
   side, as it does for npm: `npm install --save-optional` writes the name
   into both records of the lock's root entry and into
   `optionalDependencies` alone in `package.json`, and the next plain
   `npm install` takes it out of the root entry's `dependencies` again.
   Every value is a text, compared character for character;
   in `peerDependenciesMeta` it is `{"optional": true}` or
   `{"optional": false}`. A record or a value of any other kind refuses the
   lock, on either side, and so does a `"workspaces"` field on either side. A
   missing or unreadable `package.json` refuses it too. Nothing else in
   `package.json` is compared.
4. The records are what npm writes: in every entry production needs, the three
   dependency records are objects, `bundleDependencies` is a list, and every
   name in them is a package name. npm ignores letter case when it looks a
   name up in a folder, so the preflight does too, and it refuses two keys
   that differ only in letter case. npm counts an entry as a package of the
   entry whose key is, letter for letter, the folder above it. So the
   preflight also refuses a key whose folder above has no entry, such as
   `node_modules/A/node_modules/x` in a lock without `node_modules/A`: npm
   never writes one, and with one in the lock real npm 10 and 11 gave
   `node_modules/a` the copy of `x` at the top and installed it, while a
   walk that ignores letter case would have found the copy below `A`.

When in doubt the preflight counts an entry as production's: it may refuse a
lock that npm would install correctly, and it never calls a production package
dev-only. Two cases of that are known. A package named in `devDependencies`
and also in `dependencies` or `peerDependencies` is a devDependency to real
npm 10 and 11, which leave it out; the preflight counts it as production's,
so the lock npm writes for it is refused by rule 2. Keep a package that is in
`devDependencies` out of the other records. And a `package.json` that
starts with a byte order mark is refused by rule 3, although npm reads it.

Today's lock has 1,006 entries; production needs 477 of them and the other 529
are marked `"dev": true`. Rules 1 and 2 hold for it and for all 29 versions of
the lock in `main`'s history without a single entry of difference, and rule 3
holds for each with the `package.json` of the same commit.

Two things in `package.json` are left out of rule 3 on purpose, each measured
with real npm 10 and 11. An `overrides` entry either changes nothing or
stops `npm ci`: when the lock already satisfies it, and also when it names
another package of the same version, `npm ci` installs what the lock holds;
when it asks for another version or for a tarball address, `npm ci` stops
with an error and installs nothing. In no case measured did an override bring
in a package or a version the lock does not hold. `bundleDependencies` of the
project itself changes nothing about what `npm ci` installs.

If `package.json` changes in any byte while the audit runs, the status is
`lock_mismatch`, as for the lock itself. The command under
[Locked tarballs](#locked-tarballs) that lists refused entries also lists what
rules 1, 2 and 4 refuse, for example
`node_modules/x: the entry is marked "dev": true, but production needs it`.
It reads only the lock, so it cannot show rule 3; for that, compare the five
records of `package.json` with the entry `""` under `"packages"` in the
lock. Two unit tests under `this repository` in
`scripts/lib/dependency-policy.test.ts` check the real lock and the real
`package.json` against all four rules, so a pull request that breaks one
finds out in CI and not at the next release. In every case change the lock or
`package.json`, not the rule. The rule is code in `parsePackageLock` and `readLock` in
`scripts/lib/dependency-policy.ts`; no environment variable, flag or
command-line option turns it off.

What this rule does not prove: that the image's npm is one of the versions
measured here (#2318), how npm is configured on the machine that installs
(#2262), and what a bundled package holds inside its own tarball.

#### Accepted advisories

Some advisories have no patched version to upgrade to. So that such an advisory
does not block every release until upstream ships a fix,
`scripts/lib/dependency-policy.ts` holds one list, `ACCEPTED_ADVISORIES`, next
to `BLOCKED_DEPENDENCIES`. Each entry names one advisory on one package at one
version, with an expiry date and a reason. The list is code: a change to it
goes through a pull request and a review like any other change. No environment
variable, flag or command-line option can add an entry, widen one or move the
clock.

A dev-only entry has been used before: `GHSA-vfj7-8cjw-p6xm` on `braces`
`3.0.3` (only the linter used it, through `eslint-config-next`, and every
published `braces` is affected) was added on 2026-10-03 and deleted in #2294,
when `braces` left the lock; see
[The fast-glob override](#the-fast-glob-override). Production entries for
`body-parser` and `fast-uri` (MCP SDK, #2391 and #2392) were added on 2026-10-25 and
deleted when those packages left the lock; see
[The MCP SDK stand-ins](#the-mcp-sdk-stand-ins). The list is empty. A new entry adds a row
here in the same pull request; a test in
`scripts/lib/dependency-policy.test.ts` fails while this table and the list do
not hold the same entries:

| Advisory | Package | Version | Expires (UTC) | Reason |
| --- | --- | --- | --- | --- |
| (no entries) | | | | |

**Production entries.** An entry may set `production: true`. Only such an
entry may match lock nodes that production installs; every other entry still
needs the "outside production" checks in 1 and 3 below. A reported package
with a node in production is accepted only if every advisory of its own is
listed with `production: true`, or, if it has none, everything it depends on
was accepted that way. Expiry, version pinning and the critical rule apply
unchanged, so a production entry fails closed on its expiry date like any
other. Keep production entries short-lived and tracked by an issue.

An audit with findings is accepted only when all of these hold. Anything else
is `rejected`, exactly as if the list did not exist:

1. Every advisory object in the audit is a listed one: its `url` is exactly
   `https://github.com/advisories/<listed id>`, it is reported on the listed
   package, and every lock node of that package in `package-lock.json`,
   whether npm reports it or not, has the listed version and is outside
   production: it has `"dev": true` and nothing production needs leads to
   it. [What production needs](#what-production-needs) says how the preflight
   works that out and why it does not believe the mark alone.
2. Every other reported package is there only because it depends, directly or
   through other such packages, on an accepted one. A package with any advisory
   of its own that is not listed, or that names a package the audit does not
   report, is rejected.
3. Every lock node of every reported package is outside production in the
   same sense. A lock in which the mark and the dependencies disagree about
   any entry never gets this far: it is `invalid_lock`.
4. The current time is before the end of the entry's expiry date in UTC. From
   00:00 UTC on the next day the same audit is rejected again, so someone has
   to decide again.
5. No blocked dependency is present and nothing in the audit is `critical`. A
   critical advisory is never accepted, listed or not.

A lock node has two names: the folder in its path and, when the entry has one,
its `"name"` field. An aliased dependency such as `"x": "npm:qs@6.15.3"` is
installed in the folder `node_modules/x`, and its lock entry carries the real
name in `"name"`. `npm audit` reports it under the real name. Both lists
(`BLOCKED_DEPENDENCIES` and `ACCEPTED_ADVISORIES`) match a node under either
name, so an alias cannot hide a blocked version or a second node of a listed
package, and neither can a `"name"` field that claims another package:
`npm ci` installs the tarball into the folder in the path whatever that field
says. An entry whose `"name"` is not a package name fails closed as
`invalid_lock`, and so does one whose `"name"` or `"version"` is not the
package and version of the tarball in its `"resolved"`; see
[Locked tarballs](#locked-tarballs).

The accepted result is its own report, not the pass report. It has status
`accepted`, the real severity counts, every reported lock node as a package
with status `accepted` (a node of a listed package) or `dependent`, and an
`exceptions` list with the advisory id, package, version and expiry date of
each entry that was used. It never has more than 25 packages; a larger chain is
rejected. For example, the report for the `braces` entry while it was in the
list:

```json
{"status":"accepted","counts":{"blocked":0,"info":0,"low":0,"moderate":0,"high":5,"critical":0,"vulnerabilities":5,"reported":5,"omitted":0},"packages":[{"name":"@next/eslint-plugin-next","version":"16.3.6","status":"dependent"},{"name":"braces","version":"3.0.3","status":"accepted"},{"name":"eslint-config-next","version":"16.3.6","status":"dependent"},{"name":"fast-glob","version":"3.3.1","status":"dependent"},{"name":"micromatch","version":"4.0.8","status":"dependent"}],"exceptions":[{"advisory":"GHSA-vfj7-8cjw-p6xm","package":"braces","version":"3.0.3","expires":"2026-10-17"}]}
```

`deploy/release-vm.ps1` does not trust that report. It checks it again as
strictly as the pass report: exactly the keys `status`, `counts`, `packages`
and `exceptions`; blocked, critical and omitted equal to zero; severity counts
that add up to a vulnerability count of at least one; a reported count equal to
the number of packages; a fixed pattern for every advisory id, package name,
version and date; at least one exception, none twice; every exception's
package and version among the packages marked `accepted`, and every package
marked `accepted` named by an exception; and an expiry date that is today or
later in UTC. A report that fails any check stops the release with the same
message as any other failed preflight. For a valid one the release prints one
line per accepted advisory and continues. For the `braces` entry that line
was:

```text
Release warning: dependency advisory accepted; advisory=GHSA-vfj7-8cjw-p6xm; package=braces; expires=2026-10-17.
```

Nothing else from the audit reaches the release log. That line appears in
every release while an entry is in use, so an accepted advisory is never
silent.

To remove an entry once upstream ships a fix: in one pull request, update
`package-lock.json` to the patched version (for example with `npm update
<package>`), delete the entry from `ACCEPTED_ADVISORIES` and its row from the
table above, and run the preflight
(`npm run --silent dependency:preflight -- --lock-sha256 <sha256 of package-lock.json> --run-audit`).
It must print the plain pass report. The same steps apply when the package
leaves the lock in another way. If the expiry date arrives first, releases
stop with `status rejected`. Extending the date is a new decision and a new
pull request that changes only that entry; it is never done from the release
machine.

##### The fast-glob override

`braces` was in the lock for one reason: `eslint-config-next` ->
`@next/eslint-plugin-next` -> `fast-glob` `3.3.1` -> `micromatch` -> `braces`,
all development-only. Every published `fast-glob` needs `micromatch`, every
usable `micromatch` needs `braces`, no `braces` is patched, and the plugin pins
`fast-glob` to one version. So `package.json` gives the plugin, and only the
plugin, another package under that name (#2294):

```json
"overrides": {
  "@next/eslint-plugin-next": { "fast-glob": "npm:tinyglobby@0.2.17" }
}
```

Inside the plugin `require("fast-glob")` now loads `tinyglobby`. The lock has
it as `node_modules/@next/eslint-plugin-next/node_modules/fast-glob` with
`"name": "tinyglobby"`, and `fast-glob`, `micromatch` and `braces` are gone.
It is the same swap as the upstream pull request
[vercel/next.js#89531](https://github.com/vercel/next.js/pull/89531), which is
not merged yet.

This is safe only under two conditions, and each one is checked:

- The plugin takes one function from `fast-glob`, `globSync`, in one file,
  `dist/utils/get-root-dirs.js`. `tinyglobby` has a function with that name.
  `scripts/lib/next-lint-fast-glob-override.test.ts` reads the installed plugin
  and fails when another file mentions `fast-glob`, when anything other than
  `globSync` is used from it, or when the plugin no longer depends on it.
- That function is called only to expand the lint setting
  `settings.next.rootDir`, and there `tinyglobby` answers differently: for a
  plain directory it returns every directory below it, where `fast-glob`
  returns the directory itself. `eslint.config.mjs` does not set `rootDir`, so
  the function is never called, and the file refuses to load when any entry
  sets it.

Delete the override when `@next/eslint-plugin-next` no longer depends on
`fast-glob` (the test above then fails and says so): remove the entry from
`overrides`, the check at the end of `eslint.config.mjs` and that test file,
run `npm install --package-lock-only`, and check that `npm explain braces`
finds nothing. When `eslint-config-next` is upgraded while the override is
still needed, run that test and compare the output of `npx eslint -f json`
before and after.

### The MCP SDK stand-ins

`@modelcontextprotocol/sdk` depends on `express` 5 (and through it
`body-parser`), `express-rate-limit`, `ajv` and `ajv-formats` (and through them
`fast-uri`), which had advisories with no patched release on the feed (#2391,
#2392). Markdoc never runs any of them: it only uses the SDK's web-standard and
stdio transports, never its Express helpers, and every MCP `Server` and
`Client` it creates passes
`jsonSchemaValidator: new CfWorkerJsonSchemaValidator()` (`@cfworker/json-schema`)
instead of the SDK's default ajv validator. The SDK still imports `ajv` and
`ajv-formats` at load time, so an override scoped to the SDK installs all four
names as the inert `npm:content-type@1.0.5`, a package the SDK already
depends on. Calling one of them (for example `new Ajv()`) throws, so a new code
path that reaches them fails loudly instead of running unvalidated. A new
`new Client(...)` or `new McpServer(...)` must pass the cfworker validator.
Delete these four overrides once patched releases reach the feed, then run
`npm install` and `npm audit`.

The current lock resolves the audited transitive packages to
`qs@6.16.0`, `hono@4.13.8`, `js-yaml@4.3.2` and
`sharp@0.35.4`. From 2026-10-03 until #2294 the bounded dependency preflight
returned the accepted report for `GHSA-vfj7-8cjw-p6xm` (five high findings,
all in development-only packages) with zero blocked, critical and omitted
counts. The list is empty again, so a release needs the plain pass report,
with zero for every count. Workflow setup, a merge,
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
public IP `markdoc-web-ip` (DNS name
`markdoc-burkeholland.eastus2.cloudapp.azure.com`), and public health at
`https://markdoc.app`. The Azure hostname now redirects to `markdoc.app`, so the
release checks health there directly and still refuses redirects.
The command rejects another subscription/tenant/cloud, registry, VM/NIC/IP
association or public origin. It neither signs in interactively nor changes
the active account. The guest still uses its managed identity and existing
root-owned `0600` `/etc/markdoc/markdoc.env` for `markdoc-app`.

The command reconciles the accepted ACR QuickRun by polling a bounded recent-run
window for the unique submission tag, so a successful Azure CLI call does not
depend on returning a run ID. It then waits for ACR success, requires a single
well-formed digest for the full-SHA tag matching that build's output, and makes
one VM invocation containing the WAL gate and existing deployment script.
Only the read-only `list-runs` and `show-run` polls can count a failed call as a
missed poll. A local per-call timeout, `transport`, `timeout` (including HTTP
408), `throttled` (HTTP 429) or `server_error` (HTTP 5xx) waits the existing five
seconds before the next poll. A successful call resets the consecutive-miss
count, even when its valid evidence still shows no matching run or a running
build. Three consecutive misses stop at the same release stage with the last
call's existing failure message and exit code. Authentication, configuration,
not-found and unknown errors remain immediately fatal, as do malformed or
ambiguous evidence, invalid identities, unknown or failed statuses and digest
checks. No build submission or VM command is retried.

Both poll calls retain their 30-second per-call limit and use one
1,140-second outer phase watchdog that starts before unique-tag creation and
the log lines preceding the single ACR submission. The 90-second native-command
timeout for submission, the 900-second ACR service timeout, wrapper/local work,
unique-tag reconciliation and terminal run evidence all consume that same
clock; no fixed reconciliation reserve is guaranteed. Successful run `ch2g`
took about 602 seconds, while
`ch2h` and `ch2j` reached terminal `Timeout` at about 602-604 seconds with the
old 600-second service limit and produced no image. The 132 unique-tag polls
cannot borrow time from post-build proof, VM or health; normal completion
polling uses the same deadline. A requested five-second poll delay starts only
when it fits the floored remaining time; any deadline overrun is rejected
immediately afterward. An exhausted phase is terminal, not a missed poll,
including when it expires during a failed or successful call. A terminal
deadline is never caught as a per-call failure.

This new line prints once per permitted missed poll, before
`Release: guest invocation`, including the third consecutive miss:

```text
Release: ACR read-only poll missed; category=<category>; HTTP status=<status>; elapsed seconds=<seconds>; consecutive missed polls=<count>/3.
```

`<category>` is one of the four transient categories above; `<status>` is a
single recognized three-digit HTTP status or `none` when absent or conflicting.
`<seconds>` is the failed call's elapsed whole seconds, and `<count>` is the
consecutive-miss count for the current polling stage, from 1 to 3. This line
**can appear in a release that succeeds** when a later poll succeeds before
three consecutive misses or a budget is exhausted. It describes one missed
read-only observation, not the release outcome. Only the existing
`Release failed/unverified at ...` line indicates a terminal failure.

The read-only `az acr manifest list-metadata` digest lookup has its separate retry:
one additional call after a fixed two-second delay, for `transport`, `timeout`,
`throttled` (HTTP 429) or `server_error` (HTTP 5xx). HTTP 408 is also a
`timeout`. `auth`, `configuration`,
`not_found` and `unknown` fail immediately. Conflicting HTTP statuses are not
treated as transient; recognizable permanent failures take precedence.
Each call retains the native wrapper's 30-second limit. Digest lookup, its one
permitted two-second delay and retry, and the final three-command source recheck
share an independent 180-second post-build watchdog. The two lookup calls and
three source commands retain their per-call maxima, but those maxima are not
reserved slices of the outer clock. Local parsing and validation also consume
elapsed time and are checked rather than forcibly terminated. The requested
two-second delay starts only when it fits the floored remaining time; any
deadline overrun is rejected immediately afterward. No ACR build submission or
VM command is retried. A successful retry must still return exactly one
well-formed digest matching the completed build run.

The following digest-lookup log lines print before `Release: guest invocation`.
Both **can appear in a successful release**, for example when a 503 lookup fails
and the single retry returns the correct digest. They describe a failed lookup
attempt and a retry, not the final release outcome. A terminal failure at this
stage has not changed the VM:

```text
Release: ACR digest lookup failed; category=<category>; HTTP status=<status>.
Release: ACR digest lookup retry 1/1 in 2 seconds; read-only lookup only.
```

The first line prints once per failed lookup. `<category>` is only one of the
eight fixed categories above; `<status>` is a single recognized three-digit
HTTP status or `none` when absent or conflicting. Known Azure CLI error wording
can identify the category without retaining a status number; the status then
stays `none` rather than being inferred from the wording. The second line prints at
most once and only for a permitted retry. Insufficient retry time instead
produces this terminal failure line:

```text
Release failed/unverified at immutable image identity: No time remains for the ACR digest lookup retry; no VM command was sent.
```

Only this `No time remains` line and the existing `Release failed/unverified`
failure lines mean the release failed. The lookup-failed and retry lines alone
do not mean the release failed.

The native wrapper reduces stderr to these allow-listed values in memory.
It never prints or stores raw stderr, response bodies, URLs, tokens or
credentials in exception data. Only the two read-only polling calls and the digest lookup opt into this shared
classification. Other native commands do not.

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
Before restoring, the gate pins the latest measured repository-1 backup and
requires free space for its uncompressed data, every WAL segment from the
backup's archive start through the release segment, two additional WAL segments,
and a **2 GiB production reserve**. The WAL estimate deliberately does not rely
on recycling during replay. Invalid metadata, an unsupported timeline span,
unreadable capacity or insufficient space fails closed before restore. During
restore, startup and SQL checks, the gate checks free space about once per
second and stops its owned work if it drops below the reserve. It checks
before and after every SQL-readiness poll, including failed queries.
A reserve breach is permanent for that gate attempt even if space later
recovers, and no additional SQL poll or replay is started afterward. This guard
does not reserve blocks against unrelated writers, so single-operator
coordination and sufficient filesystem capacity remain required.

Scratch PostgreSQL writes to a dedicated `postgres.log`, never the truncated
per-command `command.log`. Before cleanup, failures retain at most ten diagnostic
records from the last 16 KiB of server output. Each record contains only the
operation UUID, severity and an allow-listed error category, such as disk full
or recovery target unreached. Unknown messages are explicitly withheld; paths,
statements, details, credentials and user text are never forwarded. The terminal
release command validates these records again and prints the fixed explanation
alongside the failure stage and cleanup result. Raw scratch logs are removed
with the owned cluster, not left on the production disk.
Known `LOG` messages also preserve fixed startup-abort and signal-termination
categories, including signal 9 (which can indicate an OOM-killer termination).
A signal-9 record alone does not prove OOM; confirming that cause still requires
kernel evidence. Other unrecognized `LOG` text is not forwarded.

After the WAL gate and before registry authentication, pull or app changes,
the image deployment requires **6 GiB free**: a conservative 4 GiB download/
unpacking budget for the current approximately 2.2 GB application image, plus
the same 2 GiB reserve. Reassess that budget if the image grows substantially.
After pull it checks the reserve again before changing the environment, unit
or service. Either refusal produces an operation-bound disk-space status;
the existing app is not restarted or rolled back when it was never changed.

After the new app passes local health/version checks, bounded image retention
keeps the new image, the image it replaced, and protected historical image
`21546bc69066d93d3c7844af139e7925b3b838c4c63bb6fd87ae840abfb7c313`.
Only older images with a Markdoc registry reference and no running or stopped
container using them are eligible. Retention uses individual `docker rmi`
commands, never force, system/volume pruning or rollback-bundle deletion.
A retention failure produces a fixed warning that the terminal command prints;
it does **not** roll back a healthy release. Reconcile that warning and free
capacity before another release.
Previous-image lookup includes stopped containers and is best-effort. If the
container is missing during a crash-loop restart, or its image cannot be
resolved, the release can still repair the app. After successful local health,
image retention is skipped with the same fixed warning; an unknown previous
image is never guessed or deleted.

Run the offline Bash gate/image suites under WSL or Linux with a real `python3`.
The Windows Python Store alias is not a usable interpreter for those suites.

A public failure after guest readiness is a failed/unverified release, **not** an
automatic rollback. Existing local rollback restores configuration/image only;
it does not undo schema changes.

The entrypoint uses these distinct timing boundaries:

| Boundary | Kind | Anchor and value | Controlled work and limits |
| --- | --- | --- | --- |
| Pre-submission | Outer phase watchdog | Release orchestration entry, 900 seconds | Native commands are capped by remaining time and the phase is checked before submission. Synchronous PowerShell, .NET and file work between checks is outside termination control. |
| ACR submission | Native-command timeout | Local submission child, up to 90 seconds within the build watchdog | The local CLI process is killed on timeout; accepted cloud work is not cancelled. |
| ACR service run | Service timeout | The one build requests 900 seconds | ACR applies this service limit. It does not reserve time inside the local build watchdog. |
| Build evidence | Outer phase watchdog and polling bound | Before tag creation, 1,140 seconds; at most 132 reconciliation polls | Tag/log setup, wrapper overhead, submission, reconciliation and completion polling share the clock. A requested sleep starts only when it fits the floored remaining time; any deadline overrun is rejected immediately afterward. No polling reserve is guaranteed. |
| Post-build proof | Outer phase watchdog | After terminal build evidence, 180 seconds | Digest lookup/retry and final source checks share the clock. Synchronous parsing and validation are checked afterward rather than forcibly terminated. |
| VM/result | CLI invocation cap and post-return elapsed assertion | Before the one VM invocation, 2,400 seconds | The local CLI child uses the remaining time. Result parsing, WAL evidence and local-health validation are followed by an elapsed check; the guest is not terminated by the local cap. |
| Public health | HTTP request timeout and post-return elapsed assertion | After exact guest result proof, 20-second request within a 30-second elapsed check | `Invoke-RestMethod -TimeoutSec` limits the HTTP request. Synchronous JSON parsing and health validation run before the elapsed assertion. |
| Failure report | Synchronous writes | Terminal catch | Fixed safe release/run/guest lines are written without an independent termination cap. |
| Local cleanup | Native-command timeout | Archive-removal child, 30 seconds | Only the removal child and output drain are capped. Context validation, path escaping, command resolution and process setup occur before that child boundary. |

The workflow release step has a 79-minute outer cap. Checkout, Node setup and
Azure login each have five-minute step caps, and the job has a 99-minute outer
cap. The differences between those caps are workflow/job headroom, not
guaranteed post-release-step or teardown time.

The guest gate has configured operation caps: lock acquisition is nonblocking,
archive wait is five minutes, restore ten minutes, scratch start four minutes, SQL
recovery readiness ten minutes, each control query 30 seconds, and cleanup gets
a separate 45-second stop. Authentication, `curl`, Docker login/pull,
application restart and health, rollback, retention and other guest overhead
are not all bounded by that list. The 2,400-second local CLI cap is therefore
not a worst-case guest deadline or guaranteed guest margin. Cleanup targets
only the invocation's directory/process. Cloud
work may still outlive a local timeout. On failure or timeout, do not press
Release again before reconciling the prior attempt: no write is resubmitted,
but killing the CLI does **not** cancel remote work. Output records the unique
submission tag and the reconciled ACR run ID, then the VM resource, guest
invocation UUID and start time. The high-level VM CLI does not expose its ARM
operation ID; the guest UUID is instead retained in Run Command
parameters/output for targeted owner reconciliation. Failure to find one
unique tagged run leaves Azure acceptance unknown. Raw build/VM/HTTP output is
withheld. The protected rollback bundle and diagnostics are not terminal
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
| nginx | [`infra/nginx-markdoc.conf`](../infra/nginx-markdoc.conf) is the source for `/etc/nginx/sites-available/markdoc`. `markdoc.app` proxies to the app on `127.0.0.1:3000`; `www.markdoc.app`, the Azure name and plain HTTP redirect to `https://markdoc.app` with the same path and query (`301` for pages, `308` for `/api/*` so writes keep their method). The three TLS server blocks set `client_max_body_size 10m`: see [Request body size](#request-body-size-nginx). |
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

## Request body size (nginx)

nginx refuses a request whose body is larger than `client_max_body_size` with
its own HTML `413 Request Entity Too Large` page, before the app sees the
request. Its default is 1 MB, and until issue #2339 the file set no value. The
lead measured production on 2026-10-08 at 05:00Z, without credentials: a POST
of 2 MB to an API route answered `413`, `text/html`, from nginx; a POST of
100 KB to the same route answered `401`, JSON, from the app. So picture
uploads, imports, agent requests and saves over 1 MB failed, although the app
allows them.

[`infra/nginx-markdoc.conf`](../infra/nginx-markdoc.conf) now sets
`client_max_body_size 10m;` (10 MiB, 10,485,760 bytes) in the `markdoc.app`
server block and in the two TLS server blocks that redirect to it.
**Merging that file changes nothing on production: a person must install it on
the VM** (steps below). The release script does not touch nginx, and agents do
not change the VM.

### Why 10m

10 MiB is the largest body the app can read. Every route except `/api/auth`
passes `src/proxy.ts`, and Next keeps only the first 10 MiB of a body there
(`next.config.ts` sets no `experimental.proxyClientMaxBodySize`). Next does not
answer an error for a larger body: the route receives a cut one and fails on
it. With `10m`, nginx passes everything the app can read and refuses the rest
early, from the `Content-Length`, before any of the body is read.

The app's own limits are all below that. Sizes are the request's
`Content-Length`, measured on a development server with Chromium on 2026-10-08:

| Route | Carries | The app's limit | Enforced | Largest body at the limit |
| --- | --- | --- | --- | --- |
| `POST /api/documents/:id/assets` | one picture, multipart `file` or a raw image body | 5 MiB (`MAX_ASSET_BYTES`) | the route, from `Content-Length`, then `src/server/assets.ts` on the bytes: `413 { error: "Images must be 5 MB or smaller" }` | 5,243,062 bytes for a 5 MiB `photo.png` (182 bytes of multipart frame); 5,243,256 with a 204-character file name |
| `PUT /api/documents/:id/content`, `POST /api/documents`, `POST /api/documents/:id/suggest` | a document's text as JSON | 2,000,000 characters, not bytes | the route's schema, after the body is read: `400` | 2,000,014 bytes for ASCII; 6,000,014 bytes for 2,000,000 CJK characters (three bytes each), answered `200` |
| `POST /api/mcp` | one JSON-RPC request | 4 MiB (4,194,304 bytes), the MCP SDK's default | the SDK, after the token is checked: `413` JSON-RPC | 4,194,304 bytes answered `200`; 4,194,305 answered `413` |
| `POST /api/import/file`, JSON | one text | 2 MiB of UTF-8 (`MAX_IMPORT_BYTES`) | `src/server/import-file.ts`: `413 { error: "Content is larger than 2 MB" }` | 2,097,186 bytes |
| `POST /api/import/file`, multipart | up to 20 files of 2 MiB each plus the pictures they reference, all in one request | 2 MiB a file (`MAX_IMPORT_BYTES`), 20 files (`MAX_IMPORT_FILES`) | the route | four full files are 8,389,224 bytes and answered `201`; 12,583,814 bytes (six files) and 10,486,291 bytes (one file with two 5 MiB pictures) are over what Next passes on and answered `400 { error: "Invalid multipart body" }` |
| every other route with a body (comments, reviews, requests, tokens, webhooks, sharing) | small JSON | a few thousand characters a field | the route's schema | a few KB |

The last import row is why the value is not `8m`: four full-size files in one
request are 616 bytes over 8 MiB. An import larger than 10 MiB does not work on
any host, with or without nginx; sending imports in smaller requests is issue
#2340. `/collab` is a WebSocket and is not subject to `client_max_body_size`.

`server/nginx-body-limit.test.ts` reads the nginx file and the app's limits and
fails when the value is missing from one of the three server blocks, differs
between them, is below a body the app accepts, or is above what Next passes on.
Change a limit in the app and the value here together.

A body over 10 MiB still gets nginx's HTML page. For a picture the editor shows
"The file is too large for the server to accept" (it used to show "Request
failed (413)"). An import shows "Import failed (413)".

### In the redirecting server blocks too

`www.markdoc.app` and the Azure name answer `/api/*` with `308` so that a
write to an old origin keeps its method and body. nginx compares the body size
with `client_max_body_size` when it has chosen the location, before it runs the
`return` inside that location. With the 1 MB default a POST over 1 MB to an old
origin would therefore get nginx's `413` instead of the `308`. This was run in
the review of pull request 2343 with nginx 1.24.0 (the Ubuntu 24.04 package):
with the 1 MB default a POST of 2 MB to `/api/mcp` on either name answered
`413`, and with this file it answered `308`. The plain HTTP block on port 80 is
unchanged.

### nginx defaults that were looked at and left alone

| Directive | Default | Why it stays |
| --- | --- | --- |
| `client_body_timeout` | 60 s | The longest gap between two reads of the body, not a limit on the whole upload. A slow upload fails only when nothing arrives for 60 s. |
| `client_body_buffer_size` | 16 KB on a 64-bit system | A larger body is written to a temporary file (`/var/lib/nginx/body` on Ubuntu) and removed after the request: at most 10 MiB for each upload in flight. Raising it would hold that in memory for each connection instead. |
| `proxy_request_buffering` | on | nginx collects the whole upload and then hands it to the app at once, so a slow client does not hold a request open in the app. |
| `send_timeout`, `large_client_header_buffers` | 60 s, 4 x 8 KB | About responses and request headers, not bodies. |
| `proxy_send_timeout` | 60 s | The gap between two writes to the app on the loopback interface. |

### Install on the VM (a person)

`nginx -t` passed on this file in the review of pull request 2343, with nginx
1.24.0 (the Ubuntu 24.04 package) and a copy in which only the listen
addresses, the certificate paths and the port of the app were changed. The
VM's own nginx and its `nginx.conf` were not checked, so the person on the VM
still runs `nginx -t` before the reload, as below.

Copy `infra/nginx-markdoc.conf` from `main` to `/tmp/nginx-markdoc.conf` on the
VM. Then, as root, look first. These three commands change nothing:

```bash
# 1. The live file must be the previous version of this one, and the one nginx loads.
#    readlink: expect /etc/nginx/sites-available/markdoc.
#    diff: expect only added lines, three `client_max_body_size 10m;` and the comments above
#    them. If anything else differs, stop: the VM has a change the repository does not know,
#    and installing would undo it.
readlink -f /etc/nginx/sites-enabled/markdoc
diff -u /etc/nginx/sites-available/markdoc /tmp/nginx-markdoc.conf

# 2. Is a value already set? Expect no output. A line at the `http` level (nginx.conf or
#    conf.d/) is harmless, because the server blocks override it: note it in the report.
#    A line anywhere else: stop and report it.
grep -rn client_max_body_size /etc/nginx/
```

Go on only when both answers are as expected. (When the diff shows nothing and
the grep shows the three new lines, the file is installed already: stop, there
is nothing to do.) Then install. This block may be run again without harm: it
keeps a backup that is there already, and it puts the previous file back by
itself when `nginx -t` fails.

```bash
# 3. Back up outside /etc/nginx, once. A second run must not replace the backup with the
#    new file (the rollback would then restore nothing), so a backup that exists is kept.
[ -e /root/nginx-markdoc.before-2339 ] || cp -p /etc/nginx/sites-available/markdoc /root/nginx-markdoc.before-2339

# 4. Install, test, and reload only when the test passes. A reload keeps open connections
#    (people who are editing stay connected). When the test fails, the previous file goes
#    back at once, so the file on disk is always one that nginx can load.
install -m 644 -o root -g root /tmp/nginx-markdoc.conf /etc/nginx/sites-available/markdoc
if nginx -t; then
  systemctl reload nginx && echo "INSTALLED: nginx reloaded"
else
  cp -p /root/nginx-markdoc.before-2339 /etc/nginx/sites-available/markdoc
  nginx -t && echo "NOT INSTALLED: the previous file is back in place"
fi
```

`NOT INSTALLED` means that nginx was not reloaded and runs as before, and that
the file on disk is the previous one again. Report the error text of the first
`nginx -t`. When neither line is printed, either the reload itself failed or
`nginx -t` fails with the previous file too (the fault is then not in this
file): report everything that was printed and change nothing more. A file that
fails `nginx -t` must never stay on disk: nginx keeps running with what it has
loaded, but its next reload (a certificate renewal, for example) fails, and it
does not start again after a restart of the VM.

Rollback:

```bash
cp -p /root/nginx-markdoc.before-2339 /etc/nginx/sites-available/markdoc
nginx -t && systemctl reload nginx
```

### Check afterwards

From any machine, without credentials: a POST of 2 MB to `/api/mcp`.

```bash
head -c 2097152 /dev/zero | curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  -H 'Content-Type: application/json' --data-binary @- https://markdoc.app/api/mcp
```

| Answer | Meaning |
| --- | --- |
| `401 application/json` | Expected after the install: nginx passed the body and the app refused the missing token. |
| `413 text/html` | nginx refused the body: the file is not installed or nginx was not reloaded. This is the answer before the install. |

Three more checks:

- `https://markdoc.app/api/health` reports `ok`, `db` and `collab` true.
- The same command with `head -c 11534336` (11 MiB) answers `413 text/html`:
  nginx still refuses a body over the limit early.
- A signed-in person uploads a picture of about 3 MB into a document and it
  appears.

The same 2 MB POST to `https://www.markdoc.app/api/mcp` should answer `308`, as
it did on the nginx of the review (see
[the section above](#in-the-redirecting-server-blocks-too)). If it answers
`413`, the VM's nginx behaves differently from that one: report it. It harms
nothing.

## Client address behind nginx (rate limits)

The app sits behind nginx, so every socket connection comes from `127.0.0.1`.
Until issue #2324 the per-IP limiter for failed bearer tokens (`authFail`, 30
per client) therefore used one shared bucket for the whole internet: 30 wrong
tokens from anyone locked out every API-token, agent and MCP user.

- `clientIp()` in `src/server/rate-limit.ts` trusts the proxy headers when the
  socket peer is loopback (only our own nginx connects from there) or when
  `TRUST_PROXY=1` is in `/etc/markdoc/markdoc.env`. It then uses the **last**
  `X-Forwarded-For` entry, else `X-Real-IP`, never the first
  `X-Forwarded-For` entry. `TRUST_PROXY=1` is not needed on the VM; set it only
  if the app is ever reached through a proxy that is not on loopback. A caller
  that reaches the app port directly is not loopback and keeps its socket
  address.
- Exactly one proxy hop is trusted: our own nginx on the same VM. The app takes
  the entry that hop appended and ignores everything before it.
- Which bucket a request spends (#2323): a bearer token that resolves counts
  per token, a valid session per user, a signed embed cookie per token.
  Anything unverified (a made-up bearer value, a forged cookie, no
  credentials) counts against the client address above, so inventing a
  credential never earns a fresh bucket.
- Why the last `X-Forwarded-For` entry cannot be forged: nginx's
  `$proxy_add_x_forwarded_for` appends `$remote_addr` to whatever the client
  sent, so the final entry is always nginx's own view of the peer, and a client
  cannot add an entry after it. The first entry is the client's to choose.
  This holds with the nginx file as it was before #2324, so it does not depend
  on the new header.
- [`infra/nginx-markdoc.conf`](../infra/nginx-markdoc.conf) also sets
  `proxy_set_header X-Real-IP $remote_addr;`. That is belt and braces and the
  fallback for a proxy that does not append `X-Forwarded-For`. Without it, nginx
  passes a client-sent `X-Real-IP` through unchanged, which is why the app
  prefers the last `X-Forwarded-For` entry and does not rely on `X-Real-IP`.
- The app change and the nginx change are safe in either order. App only: the
  last `X-Forwarded-For` entry is already nginx's own, so per-client buckets
  work and a forged `X-Real-IP` is ignored. nginx only: the old app still sees
  one shared bucket until the app is released.
- Check once both are live: 31 requests with a wrong bearer token from one
  machine end in `429`, and a valid token from another machine still answers
  `200`. Installing the nginx file follows the steps in
  [Install on the VM](#install-on-the-vm-a-person).

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
