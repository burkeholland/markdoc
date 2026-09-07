# Release rehearsal: build and start the candidate image in ACR before a release

> **Historical rehearsal reference:** the figures and examples below describe
> the September 1 Container Apps-era candidate, not the current release.
> [VM application releases](../README.md#production-runbook-vm-application-releases)
> now use the [VM workflow and schema requirements](vm-hosting.md).
> An ACR rehearsal creates cloud artifacts and runs a container; it is not a
> read-only documentation check. Fresh PGlite migration success does not prove
> an upgrade of the existing PostgreSQL schema, previous-image compatibility
> or backup recoverability. Any new rehearsal requires its own scoped work.

How to prove, the day before or the morning of an app-only release, that the candidate `main` commit builds into an image of the expected size, starts as `node`, applies its migrations on a fresh database, reports its own SHA on `/api/health` and exits cleanly on SIGTERM — without touching production. The README's [*Production runbook: app-only releases*](../README.md#production-runbook-app-only-releases) is the release itself; this page is the pre-release step it points to, and the release spec cites the rehearsal's ACR run ids as its build and start-up evidence. It is built from the two read-only tasks that first did this on 2026-09-01 for candidate `e74e4f39c582ca42ce3e1467e7aa671255fa01c7` (`e74e4f3`): #1501 built and measured the image (ACR run `chr`), #1514 started it once (run `chs`). Their figures are the worked example throughout; a later candidate compares with the *last release's* figures, not with these.

Docker is not installed on the factory machine; both halves run inside Azure Container Registry Tasks (`az acr build`, `az acr run`) and cost ≈ 6 minutes of ACR time in total.

## 1. Purpose

Build the exact candidate SHA as a disposable `markdoc:rehearsal-<12-char>` tag, then start that image once in ACR with the embedded PGlite database and read what it says. Nothing that serves production changes: no `az containerapp` command, no tag on a release name (`markdoc:<sha>`, `markdoc:<12-char>`, `latest`), nothing against the database VM or Key Vault — the registry gains one disposable tag and two task-run records, that is all.

It proves that the `Dockerfile` builds from a clean checkout of that SHA; that the image size sits in the expected band (§3); that the container runs as `node` (uid 1000) with `/app` owned by it; that every Drizzle migration applies on a fresh database, the newest included; that `/api/health` reports `version` = the SHA passed as `APP_VERSION`; and that SIGTERM produces the documented `[exit]` pair and exit code 0.

It cannot prove PostgreSQL-specific behaviour (the rehearsal runs on PGlite, so a migration that is valid there but not on the production server is not caught), the Key Vault `database-url` secret reference, ingress and TLS, the platform's startup-probe window, or the revision flip time — those remain the release runbook's steps 2–5.

## 2. Build

From a **clean detached worktree at the candidate SHA**, never from a working checkout:

```powershell
git fetch origin
git worktree add ../markdoc-rehearsal <full 40-char sha> --detach
cd ../markdoc-rehearsal
git status --porcelain --untracked-files=all      # no output
az acr build -r markdocacrmnd542unepl56 -t markdoc:rehearsal-<12-char> --build-arg APP_VERSION=<full 40-char sha> --file Dockerfile --no-logs .
```

No `npm ci` in the worktree: `az acr build` packs the folder as the build context (`Sending context (1.837 MiB)` at `e74e4f3`) and ACR runs the install and the build. The context must be the worktree because `.dockerignore` decides what is sent — a fixed list (`.git`, `node_modules`, `.next`, `dist`, `.data`, `.env*`, the test folders, `scripts/*.mts`, every `*.md` but the README) — so anything untracked that a working checkout accumulates (the main checkout's `markdoc-data/` folder, a `.next-e2e-<port>` build directory, scratch files) travels into the context and, through the build stage's `COPY . .`, into the image. A detached worktree holds exactly the tracked files of the SHA plus a 79-byte `.git` pointer. Remove it afterwards (`git worktree remove ../markdoc-rehearsal`).

`--no-logs` is deliberate: on Windows `az.cmd` crashes client-side at the `▲` glyph of the Next banner while streaming (cp1252 console; the README's runbook step 1 documents it) — the build in ACR continues either way. Note the run id the command prints (`Queued a build with ID: <id>`) and poll:

```powershell
az acr task list-runs -r markdocacrmnd542unepl56 --top 1 -o table
az acr task show-run -r markdocacrmnd542unepl56 --run-id <id> --query "{status:status,start:startTime,finish:finishTime}" -o json
```

`status` goes `Running` → `Succeeded` in ≈ 5 minutes (run `chr`: 5m12s on a 2-vCPU agent — build step 250.0 s + push step 57.8 s; the pre-#1467 rehearsal `chp` took 5m34s). Then read the whole log with the Azure CLI's Python entry point, the only reader that survives the glyphs:

```powershell
$env:AZ_INSTALLER='MSI'; & "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe" -X utf8 -IBm azure.cli acr task logs -r markdocacrmnd542unepl56 --run-id <id>
```

Two glyphs make this necessary, and both are in every log from now on: `▲` in the Next build banner (`▲ Next.js 16.3.3 (Turbopack)`, build log) and `✓` in `✓ Running next.config.ts took Nms`, which Next 16.3.3 prints at server start (#1514 found it in the start-up log of §4; the same `✓` also precedes `Compiled successfully` in the build log). `az.cmd` dies on either under cp1252, and `PYTHONUTF8` does not help because the bundled Python runs with `-I`.

What to check in the build log (585 lines and 29 steps at `e74e4f3`; step numbers move with the `Dockerfile`):

- `Step 4/29 : RUN npm ci` → `added 880 packages, and audited 881 packages` and `found 0 vulnerabilities`; later `RUN npm ci --omit=dev && npm cache clean --force` → `added 445 packages, and audited 446 packages` and a second `found 0 vulnerabilities`. Counts move only when `package-lock.json` did; a new advisory count is a stop.
- `Step 10/29 : RUN AUTH_SECRET=build-placeholder npm run build && rm -rf .next/cache` running in **one** container (`---> Running in <id>` … `Removing intermediate container <id>`): the `&&` means the step, and so the run, could only succeed if the `rm` exited 0, and the `.next` layer of §3 is the material proof.
- The Next summary: `✓ Compiled successfully in 30.0s`, `Finished TypeScript in 21.1s`, `✓ Generating static pages using 1 worker (19/19)`, the `Route (app)` table (68 routes, `ƒ Proxy (Middleware)`), `precompress-static: 148 .br file(s) under .next/static, 3881919 -> 1109313 B (28.6 %), brotli q11`, `dist/server.mjs 109.9kb`; `apk` ends `OK: 780.0 MiB in 200 packages` (Chromium `152.0.7977.64-r0`).
- Exactly three warn lines, none of them a stop: `npm warn deprecated @esbuild-kit/core-utils@3.3.2: Merged into tsx`, `npm warn deprecated @esbuild-kit/esm-loader@2.6.5: Merged into tsx` (drizzle-kit's loader; the README's `overrides` note) and `npm warn using --force Recommended protections disabled.` (the Dockerfile's own `npm cache clean --force`). `npm notice New major version of npm available!` is a notice, not a warn. A fourth warn line is a finding.
- The tail: `Successfully tagged markdocacrmnd542unepl56.azurecr.io/markdoc:rehearsal-<12-char>`, `rehearsal-<12-char>: digest: sha256:… size: 3678`, `Step ID: build marked as successful`, `Step ID: push marked as successful`, `Run ID: <id> was successful after 5m12s`. The push shows 12 layers `Pushed` and 4 `Layer already exists` (the `node:22-alpine` base, unchanged since revision 29).

## 3. Size

`imageSize` comes from the manifest metadata — `az acr repository show --image markdoc:<tag>` returns digest and `createdTime` but **no size** (#1501 found this; the README's runbook step 1 was corrected accordingly):

```powershell
az acr manifest list-metadata -r markdocacrmnd542unepl56 -n markdoc --query "[?contains(join(',', tags || ['']), 'rehearsal-<12-char>')].{tags:tags,digest:digest,created:createdTime,imageSize:imageSize}" -o json
az acr manifest show -r markdocacrmnd542unepl56 -n markdoc:rehearsal-<12-char> -o json     # per-layer sizes
```

The JMESPath filter works as-is through `az.cmd`; without `--query` the first command lists every manifest with its tags, which is also how you read the last release's figure. `imageSize` is the sum of the compressed layer sizes (the config blob is excluded).

Reference figures, measured 2026-09-01:

| Tag | What | `imageSize` (B) | Layers | Digest |
| --- | --- | --- | --- | --- |
| `markdoc:6e251b1d047e` | production, revision `markdoc--0000029` | **994 587 108** | 15 | `sha256:21546bc6…` |
| `markdoc:rehearsal-ee8a9dc391b4` | rehearsal before #1467 | 1 002 141 921 | 16 | `sha256:bdc57a08…` |
| `markdoc:rehearsal-e74e4f39c582` | candidate of 2026-09-01 (#1501) | **684 568 023** | 16 | `sha256:fa5143c6…` |

Candidate vs revision 29: **−310 019 085 B (−31.2 %)**, twice the estimate, because `.next/cache` had sat in two layers: the `.next` COPY layer went 174 022 837 → 18 893 703 B and the `RUN mkdir -p /app/.data && chown -R node:node /app` layer — a copy-up of every file under `/app` into its own layer — went 299 323 534 → 144 315 484 B, each ≈ −155 MB. Every other layer is byte-identical or within a few KB (the four base layers share digests with revision 29; `npm ci --omit=dev` +46 372 B for the dependency bumps since production, `dist` +8 828 B, `drizzle` +2 971 B for migration `0019`, one new 59 260 B layer for the `src/server/og/fonts` COPY of #1287). Largest first at `e74e4f3`: 337 582 914 (apk Chromium + fonts) · 144 315 484 (`chown -R` copy-up) · 125 656 904 (`npm ci --omit=dev`) · 52 629 973 (node) · 18 893 703 (`.next`).

Rule of thumb: compare with the last release's `imageSize`. With the current `Dockerfile` a candidate lands at ≈ 685 MB ± the `.next` delta — tens of KB per app-only change, a few hundred KB for a dependency bump. ≈ 995 MB again means the cache came back or the wrong commit was built: stop. When #1512 (the held `chown` copy-up trim, 0666-mode normalisation) lands, the band moves to ≈ 540 MB and *that* release's figure becomes the reference; the numbers above stay as the worked example.

## 4. Start it once

`az acr run` starts a container from the registry on an ACR agent; it needs a source context, which here is an otherwise **empty** temp folder (never the repository) holding three files. ACR mounts that folder at `/workspace` and makes it the working directory, so the script `cd`s to `/app` before starting the server. Save all three with LF line endings (`sh` fails on a CRLF `run.sh` with `: not found`) and run:

```powershell
az acr run -r markdocacrmnd542unepl56 -f task.yaml --timeout 600 --no-logs .
az acr task show-run -r markdocacrmnd542unepl56 --run-id <id> --query "{status:status,start:startTime,finish:finishTime,outputImages:outputImages}" -o json
$env:AZ_INSTALLER='MSI'; & "C:\Program Files\Microsoft SDKs\Azure\CLI2\python.exe" -X utf8 -IBm azure.cli acr task logs -r markdocacrmnd542unepl56 --run-id <id>
```

≈ 45 s (run `chs`: 43 s = ≈ 34 s image pull + 6 s script; context upload 2.2 KiB); `outputImages` is `null` — nothing is pushed or tagged. The log read needs the Python entry point for the `✓` line of §2.

`task.yaml` — one `cmd` step; `$Registry` is ACR's alias for the registry's login server:

```yaml
version: v1.1.0
steps:
  - id: rehearsal
    cmd: $Registry/markdoc:rehearsal-<12-char> sh /workspace/run.sh
    timeout: 540
```

`run.sh` — POSIX `sh` (the image is Alpine: BusyBox `wget`, `date`, `du`). The environment is the smallest set the server starts with; there is no `DATABASE_URL`, so the script sets `MARKDOC_PRODUCTION_PGLITE=local-rehearsal-only`, the exact opt-in that permits this isolated production-image rehearsal to use PGlite at the image's `PGLITE_DATA_DIR` (`/app/.data/pglite`). `PGLITE_DATA_DIR` alone never permits production PGlite, and the opt-in must never be added to the deployed container. `AUTH_SECRET` is a throw-away literal typed into the script — never a value from Key Vault or `.env.local`, and the script prints variable **names** only:

```sh
#!/bin/sh
# Start the rehearsal image once with PGlite, probe it, stop it, then read the migration table.
# Runs inside the image as `node` (the Dockerfile's USER); ACR mounts this folder at /workspace.
set -u
echo "=== rehearsal start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "ID_U $(id -u)"
echo "NODE $(node --version)"
echo "PWD $(pwd)"
cd /app
echo "--- ls -ld (the four paths)"
ls -ld /app /app/.data /app/.next /app/node_modules
echo "--- ls -ld (runtime-stage COPY targets)"
ls -ld /app/dist /app/drizzle /app/next.config.ts /app/public /app/scripts/lib/dev-origins.mjs /app/src/server/og/fonts
echo "FONTS $(ls /app/src/server/og/fonts | tr '\n' ' ')"
echo "DRIZZLE_TAIL $(ls /app/drizzle | tail -n 3 | tr '\n' ' ')"
if [ -d /app/.next/cache ]; then echo "NEXT_CACHE present"; else echo "NEXT_CACHE absent"; fi
echo "NEXT_SIZE $(du -sh /app/.next | cut -f1)"
echo "ENV_NAMES $(env | cut -d= -f1 | sort | tr '\n' ' ')"   # names only, never values
export AUTH_SECRET='<any 32+ random characters, not a real secret>'
export AUTH_URL=http://127.0.0.1:3000
export MARKDOC_URL=http://127.0.0.1:3000
export MARKDOC_PRODUCTION_PGLITE=local-rehearsal-only
export AUTH_DEV_LOGIN=force
export PORT=3000
echo "--- server start $(date -u +%H:%M:%S)"
node dist/server.mjs &
pid=$!
ok=0
i=0
while [ "$i" -lt 40 ]; do
  i=$((i + 1))
  sleep 1
  if wget -qO /tmp/health.json http://127.0.0.1:3000/api/health 2>/dev/null; then
    echo "--- HEALTH_OK after ${i}s ($(date -u +%H:%M:%S))"
    cat /tmp/health.json; echo
    ok=1
    break
  fi
done
[ "$ok" = 1 ] || echo "--- HEALTH_FAILED after 40s"
echo "--- LOGIN"
wget -qO- -S http://127.0.0.1:3000/login 2>&1 | grep -m1 HTTP/
echo "--- LIVE"
wget -qO- -S 'http://127.0.0.1:3000/api/health?probe=live' 2>&1 | grep -m1 HTTP/
echo "--- LIVE_BODY"
wget -qO- 'http://127.0.0.1:3000/api/health?probe=live'; echo
echo "--- SIGTERM $(date -u +%H:%M:%S)"
kill -TERM "$pid"
wait "$pid"
echo "EXIT $?"
echo "--- MIGRATIONS (drizzle.__drizzle_migrations in the PGlite dir the server wrote)"
node /workspace/verify.mjs
echo "=== rehearsal end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`verify.mjs` — Drizzle's `migrate()` prints nothing, so the console cannot show how many migrations applied; after the server has exited the same container opens the PGlite directory it wrote and reads the migration table, matching each row's `created_at` to the `when` of the image's journal. It imports PGlite from the image's own `node_modules` by absolute path because the file lives in `/workspace`, where a bare specifier would not resolve:

```js
// Compare drizzle.__drizzle_migrations (what the server applied) with /app/drizzle/meta/_journal.json (what the image ships).
import { readFileSync } from "node:fs";

const { PGlite } = await import("file:///app/node_modules/@electric-sql/pglite/dist/index.js");
const dir = process.env.PGLITE_DATA_DIR ?? "/app/.data/pglite";
const journal = JSON.parse(readFileSync("/app/drizzle/meta/_journal.json", "utf8")).entries;
const tagByWhen = new Map(journal.map((e) => [String(e.when), e.tag]));

const db = new PGlite(dir);
const applied = (await db.query("select created_at from drizzle.__drizzle_migrations order by created_at")).rows;
console.log(`MIGRATIONS applied=${applied.length} journal=${journal.length} dir=${dir}`);
applied.forEach((row, i) => {
  const when = String(row.created_at);
  console.log(`  #${i + 1} created_at=${when} -> ${tagByWhen.get(when) ?? "NOT IN JOURNAL"}`);
});
const tables = (await db.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")).rows[0].n;
console.log(`PUBLIC_TABLES ${tables}`);
if (applied.length !== journal.length) console.log("MIGRATIONS_MISMATCH");
await db.close();
```

The migration a release carries deserves one extra read of its own: #1514 also queried `information_schema.columns` for the four columns `0019_agent_request_addressee` adds and `pg_indexes` for its index — add such a query to `verify.mjs` when the candidate carries a new migration, and drop it afterwards.

## 5. What must be true

Read the run log against this table; #1514's measurements at `e74e4f3` (run `chs`) are the reference column.

| # | Assertion | Expected | Where to read it | Measured 2026-09-01 |
| --- | --- | --- | --- | --- |
| 1 | Runs as the unprivileged user | `ID_U 1000` | the `USER node` of the `Dockerfile`; ACR must not have overridden it | `1000` |
| 2 | `/app`, `/app/.data`, `/app/.next`, `/app/node_modules` | all four `ls -ld` lines owned `node node`, `drwxr-xr-x` | the `chown -R node:node /app` layer took; PGlite can write `.data` | all four `node node` |
| 3 | Health answers | `--- HEALTH_OK after Ns` with N ≤ 40 | 3 s on a 2-vCPU agent; ≈ 12 s at revision 29 in production; the platform's startup probe allows 65 s | `after 3s` (3rd poll) |
| 4 | Health `version` | the full 40-char SHA you passed as `APP_VERSION` | `HEALTH_OK` JSON and `LIVE_BODY`; anything else means the wrong commit or a missing `--build-arg` | `e74e4f39c582ca42ce3e1467e7aa671255fa01c7` |
| 5 | Health fields | exactly `ok, db, collab, documentsLoaded, connections, latencyMs, version` with `ok:true`, `db:true` | `HEALTH_OK` JSON ([`docs/agents.md`](agents.md) documents the shape) | 7 fields, `latencyMs:1`, `documentsLoaded:0`, `connections:0` |
| 6 | `/login` | `HTTP/1.1 200 OK` under `--- LOGIN` | with `AUTH_DEV_LOGIN=force` the page renders without GitHub OAuth | `200 OK` |
| 7 | `/api/health?probe=live` | `HTTP/1.1 200 OK` under `--- LIVE`; body `{"ok":true,"probe":"live","collab":true,"version":"<sha>"}` | the Liveness probe path, no database round trip | `200 OK`, body as expected |
| 8 | Migrations | `MIGRATIONS applied=N journal=N`, N rows each `-> <tag>`, the newest tag the candidate carries named, no `MIGRATIONS_MISMATCH` | the `verify.mjs` block — **the console has no `[migrate]` line; the `__drizzle_migrations` read is the proof** | `applied=20 journal=20`, row 20 = `0019_agent_request_addressee`; its 4 columns + index present; `PUBLIC_TABLES 18` |
| 9 | Unknown `[prefix]` lines | 0 | every `[prefix]` in the log is in `docs/operations-log-lines.md` §1; between start and SIGTERM only the two `[exit]` lines appear | 0 |
| 10 | Warn/error-class lines | 0 | no `⨯`, no stack, no `[http]`, no `[db]`, no `warn`; anything else is listed in the report | 0 |
| 11 | SIGTERM handling | `> [exit] SIGTERM after <t>s; shutting down, flushing documents...` then `> [exit] process exiting with code 0 after <t>s` then `EXIT 0` | `wait $pid` prints the status; 143 without the pair means the handler did not run | pair present, `EXIT 0`, 4.8 s uptime |
| 12 | Run duration | reported | `az acr task show-run`: `startTime`/`finishTime`; the log's `Run ID: <id> was successful after Ns` | 43 s (step 40.4 s = ≈ 34 s pull + 6 s script) |
| 13 | Production untouched | yes | the `az` calls made were only `account show`, `acr build` (rehearsal tag), `acr repository show`, `acr repository show-tags`, `acr task show-run`, `acr task logs`, `acr manifest list-metadata`, `acr manifest show` and the one `acr run`; `outputImages: null`; never `az containerapp`, a release tag, `acr repository delete`, `acr import`, the VM or Key Vault | held |

A known, harmless finding to expect in the second `ls -ld` block: `next.config.ts` and `scripts/lib/dev-origins.mjs` are `-rw-rw-rw-` (0666) while directories are `0755` — the build stage's `COPY . .` kept the modes of the uploaded context tar; everything under `/app` belongs to `node`, the only user in the container. #1512 (the held `Dockerfile` task) normalises them.

**Expected start-up lines** that are not noise — the whole server output of a healthy start is these, in this order:

- `✓ Running next.config.ts took Nms` — Next 16.3.3 loading the config (the `✓` that needs the Python log reader).
- `> Markdoc ready on http://<hostname>:3000 (stable hostname; production)` and `> Collaboration WebSocket on ws://<hostname>:3000/collab` (`server/index.ts` l.265–266).
- `> Hostname alias: http://<hostname>.local:3000`, `> Loopback diagnostic: http://localhost:3000`, `> Numeric diagnostic (eth0): http://<container ip>:3000` (`server/index.ts` l.268–271) — printed whenever `HOST` is `0.0.0.0`, which the `Dockerfile` sets, so production prints them at every start too.
- On SIGTERM, the two `[exit]` lines of row 11 (`server/index.ts` l.277 and l.85).

[`docs/operations-log-lines.md`](operations-log-lines.md) has the full prefix list, what each line means and the KQL to count them in `ContainerAppConsoleLogs_CL`.

## 6. When it is red

- **The build fails.** Quote the failing step and the 30 log lines before it. The fix is a `Dockerfile` change on a branch, reviewed and merged like any other — never a `--no-cache` retry "to see if it passes", and never more than one identical rebuild (it only spends ACR minutes). The release is off until the fix is on `main`, and that `main` is then a new candidate.
- **`imageSize` ≈ 995 MB, or outside the band of §3.** The wrong commit was built (check `version` in §5 row 4 and the SHA in the worktree) or `.next/cache` is back in the image (`NEXT_CACHE present`, or the `.next` layer near 174 MB in `az acr manifest show`). Stop and find out which before anything else.
- **Health never answers 200 within 40 s** (`--- HEALTH_FAILED`), or the server exits before it does. Quote the whole run log — `> [exit] startup failed after <t>s: <stack>` names the cause — and stop the release. This is exactly the outcome the rehearsal exists to catch.
- **A `column … already exists` / `relation … does not exist` stack, or `applied < journal`.** A migration problem: the release is off until it is understood, whether the fault is in the new migration, its journal entry or a hand-edited database — never fixed by skipping the migration.
- **Anything in row 9 or 10.** A new `[prefix]` or a warn/error line is a finding for the report; whether it stops the release is the lead's call, made with the line in front of them.

The release spec cites the two run ids (build and start) as its evidence that the image builds and starts. If accepted `main` moves past the rehearsed SHA before the release, a candidate that differs only in **app-only** files — `src/`, `e2e/`, docs — does not need a second rehearsal: the release build is a fresh tagged build of the new SHA anyway, and the runbook's own health wait and `release:verify` cover the app. A change to `package.json`/`package-lock.json`, the `Dockerfile` or `.dockerignore`, `drizzle/` or `server/` does need one, at the new SHA.

## 7. Tag hygiene

`rehearsal-*` tags are disposable. Delete the ones older than a week:

```powershell
az acr repository show-tags -n markdocacrmnd542unepl56 --repository markdoc --orderby time_desc -o tsv
az acr repository delete -n markdocacrmnd542unepl56 --image markdoc:rehearsal-<12-char> --yes
```

Never delete a full-SHA or 12-char **release** tag — those manifests are the rollback path of the README's runbook step 4 (`az containerapp revision activate` needs the previous revision's image to still exist). `az acr repository delete --image` removes the manifest and every tag on it, so check with `az acr manifest list-metadata` that the rehearsal digest carries no release tag first (it never does when §2 was followed: a rehearsal build is its own manifest). Tags written on 2026-09-01, for reference: `rehearsal-ee8a9dc391b4` (1 002 141 921 B, before #1467) and `rehearsal-e74e4f39c582` (684 568 023 B).

Sources: task #1501 (ACR build `chr` of `e74e4f3`, log read, layer-by-layer measurement, 2026-09-01), task #1514 (ACR run `chs` of the same image, assertion table, start-up findings, 2026-09-01); `Dockerfile`, `.dockerignore` and `server/index.ts` at `dc87bdb`; README *Production runbook: app-only releases*; `docs/operations-log-lines.md` §1–§2.
