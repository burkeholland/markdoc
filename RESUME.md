# Resuming Markdoc after a machine wipe

What Markdoc keeps on the box, where it lives, what the snapshot contains, and how to get back
to a running `http://localhost:3000` from GitHub plus one snapshot. The factory-wide script
(`burkeholland/factory-resume/bootstrap.ps1`, owned by the board team) clones every repo under
`$FACTORY_ROOT`, restores the latest `factory-state` snapshot, re-registers scheduled tasks,
starts services and then runs `scripts/live/resume-check.ps1` from this repo. Everything
Markdoc-specific it relies on is described here.

## State on this machine

All paths are siblings of the repo under the factory root (`$FACTORY_ROOT`, default: the parent
folder of this checkout; `Get-FactoryRoot` in `scripts/live/common.ps1`).

| Piece | Where | Recreatable? |
| --- | --- | --- |
| Source | `markdoc/` (this repo, branch `main`) | From GitHub `burkeholland/markdoc` |
| Live worktree | `markdoc-live/` **and** `markdoc-live-b/` — a pair of detached worktrees; `promote.ps1` compiles the new sha in the idle one and hands :3000 over to it, so the live one alternates. `markdoc-data/live.json` (`{ root, sha, port, promotedAt }`) says which is live; without it, `markdoc-live/` (`Get-LiveRoot` in `common.ps1`) | Yes, `resume-check.ps1` creates `markdoc-live`; `promote.ps1` creates the twin on first use |
| Live env | `<live worktree>/.env.local` (copied into the twin on every promote) — `AUTH_SECRET`, `AUTH_DEV_LOGIN=1`, `PGLITE_DATA_DIR`, `BACKUP_TOKEN` | Yes, `resume-check.ps1` writes it; `AUTH_SECRET` comes back from the snapshot's sealed copy when there is one (see Secrets below) |
| **Data** | `markdoc-data/pglite/` — the embedded PGlite database (~39 MB, ~1050 files): documents, versions, assets, comments, notifications, users, API tokens | **Only from the snapshot** |
| Snapshot | `markdoc-data/snapshots/latest/` — current hot backup (`markdoc-pglite.tar.gz` + `manifest.json`), rewritten every 15 min; `markdoc-data/snapshots/<yyyyMMdd-HHmmss>/` — the last 3 copies | Recreated by the "Markdoc snapshot" task while the server runs |
| Log | `markdoc-data/live.log` for `markdoc-live`, `markdoc-data/live-b.log` for `markdoc-live-b` (+ `.1` rotation) — `==== start-live <ts>` on every start, `==== exit code N <ts>` when the server process ends, `> [exit] …` lines from the server itself (signal, crash, uptime); `markdoc-data/watchdog.log` — one line per watchdog restart; `markdoc-data/watchdog.state`, `markdoc-data/promote.lock` — transient | Disposable |
| Scheduled tasks | "Markdoc live server" (per user, at logon) → `markdoc-live\scripts\live\start-live.ps1`; "Markdoc snapshot" (per user, every 15 min) → `snapshot-data.ps1 -Latest`; "Markdoc watchdog" (per user, every 1 min) → `watchdog.ps1` (see below) | `scripts/live/install-autostart.ps1` registers all three (`-Only watchdog` for one), `-Uninstall` removes all three |
| Ports | 3000 live; 3001 loopback standby during a promote; 3100/31xx Playwright; 32xx–39xx dev servers (`npm run dev:port`) | — |

Nothing else. No external database, no cloud storage; GitHub publish/login use per-user tokens
that are not on disk outside `.env.local`.

## What goes in the snapshot

Nominated: **the PGlite database as a hot backup tarball**, not the raw folder. PGlite is a
single-process Postgres; copying `markdoc-data/pglite/` while the server runs is not guaranteed
consistent, and stopping the server for every snapshot costs ~40 s of downtime each time.
Instead the running server exposes `GET /api/admin/backup`, which runs a `CHECKPOINT` and returns
PGlite's own `dumpDataDir()` (a tar of PGDATA) gzipped. The tar walk is synchronous inside the one
PGlite process, so no query can interleave: the copy is consistent without a stop.

`scripts/live/snapshot-data.ps1` (read-only for the server, ~2–35 s for 40 MB) writes:

- `<dir>\markdoc-pglite.tar.gz` — the backup
- `<dir>\manifest.json` — `{ sha, takenAt, bytes, documents, users, port, file, sha256, durationMs }`
  (`sha` is the live worktree's HEAD; `documents` counts non-deleted documents)
- `<dir>\auth-secret.enc.json` — `AUTH_SECRET` from `markdoc-live\.env.local`, **sealed** under `FACTORY_STATE_KEY`
  (`scripts/live/env-vault.mjs`: scrypt → AES-256-GCM, random salt and iv per file; base64 fields in a small JSON).
  Written only when that key is in the snapshot task's environment and `.env.local` has the value; otherwise the
  script says so and the snapshot is still good. Never the value in the clear — factory-state refuses secrets.

With `-Latest` (the default when `-Out` is omitted) `<dir>` is `markdoc-data\snapshots\latest`, written
**atomically**: the download goes to `latest.tmp`, then `latest` → `prev`, `latest.tmp` → `latest`,
`prev` deleted — anything copying `latest` sees the old complete folder, a brief absence, or the new
complete folder, never a half-written tarball. It also keeps the newest 3 timestamped copies in
`markdoc-data\snapshots\<yyyyMMdd-HHmmss>\` and prunes older ones. `-Out <dir>` writes anywhere else
and touches nothing under `snapshots\`.

It exits 1 (and leaves `latest` untouched) when the server is down or the token is wrong. `/api/health`
is polled once a second for up to 60 s (`-HealthTimeoutSec`) until it answers `db:true` — a cold
Next.js server compiles the route on the first hit and used to fail a single short probe. Token
resolution: `-Token`, else `$env:BACKUP_TOKEN`, else `BACKUP_TOKEN=` in `markdoc-live\.env.local`.

### Every 15 minutes, and where it lands in factory-state

The per-user scheduled task **"Markdoc snapshot"** (`install-autostart.ps1`; trigger: once, repeating
every 15 min indefinitely, 10-min execution cap, overlapping runs ignored) runs
`powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\scripts\live\snapshot-data.ps1 -Latest`.
Force one with `Start-ScheduledTask 'Markdoc snapshot'`. After promoting a commit that contains
`scripts\live`, re-run `install-autostart.ps1` from `markdoc-live` so all three tasks point at the
permanent location rather than a review worktree.

## Watchdog: every minute, restart :3000 when it died silently

On 2026-08-25 15:42 the live server stopped answering with nothing in `live.log` and stayed down for
3.5 min, until an unrelated promote restarted it. The per-user scheduled task **"Markdoc watchdog"**
(`install-autostart.ps1`; trigger: once, repeating every 1 min, 10-min execution cap, overlapping runs
ignored) runs `scripts\live\watchdog.ps1`, which does one `GET /api/health` on :3000 with a 10 s timeout:

- 200 → nothing (no log line on a healthy tick); if the previous tick restarted the server it appends
  `<ts> ok after restart in N s` to `markdoc-data\watchdog.log` and clears its state.
- non-200 / refused → one miss, kept in `markdoc-data\watchdog.state`. On the **second miss in a row** it
  runs `start-live.ps1` (idempotent) and appends `<ts> down -> restarted (…)` or
  `<ts> down -> restart FAILED: <reason>`. Worst case from death to back: two ticks + the start (~2–3 min).
- It never acts while `markdoc-data\promote.lock` exists and is younger than 10 min — `promote.ps1` holds
  that file for its whole run (a stale one from a crashed promote is ignored) — nor while the newest
  `==== start-live` marker in `live.log` is younger than 180 s (a cold start answers nothing for ~90 s).

Rehearse against a copy, never the real server: `.\watchdog.ps1 -Root <copy worktree> -Port 3993 -DataRoot <tmp>`
(state, log and lock all live under `-DataRoot`). `Get-Content ..\markdoc-data\watchdog.log` shows every
restart it made; `live.log` carries the matching `==== exit code N <ts>` marker (written by `run-live.cmd`
when the server process ends, for any reason) and, when the process had a chance to say so, a
`> [exit] <signal|uncaughtException|unhandledRejection|exiting with code N> after <uptime>` line from
`server/index.ts`. A `==== exit code` marker with no `> [exit]` line before it means the process was
killed from outside (TerminateProcess — no Node handler runs).

The board's own 15-minute factory-state snapshot has no pre-command hook: it only copies folders that
are already fresh, which is why `latest` is a fixed name rewritten atomically. How it is nominated:

- `<repo>/snapshot.json` (this repo: `{"paths":[],"sqlite":[]}`) can only name paths **inside** the
  repo — `board/lib/snapshot.js readRepoNominations` rejects any `..` segment ("paths must stay inside
  the repo"). Markdoc keeps no state in the repo, so the file is intentionally empty.
- The data folder is nominated from the **root** file `<FACTORY_ROOT>\factory-state.nominate.json`:
  `{"markdoc":["markdoc-data/snapshots/latest"]}` (section 4a of `board/tools/state/snapshot.ps1`,
  paths relative to the factory root). The board robocopies it (`/MIR`) to
  **`<factory-state>\projects\markdoc\markdoc-data\snapshots\latest\`** — exactly one tarball + manifest,
  not a growing pile. That root file is not in any repo; after a wipe, `bootstrap.ps1` / the board
  team restore it, or recreate it by hand with the line above.

If the server is stopped anyway (e.g. the box is going down), a plain `robocopy /MIR` of
`markdoc-data\pglite` is also a valid snapshot — a stopped PGlite directory is consistent — and
`restore-data.ps1` is not needed for it: copy it back to `PGLITE_DATA_DIR` before starting.

## Promoting without downtime (`scripts/live/promote.ps1 -Sha <sha>`)

The live server alternates between `markdoc-live` and `markdoc-live-b`. A promote never stops the running server
until its replacement is compiled:

1. in the idle twin: `git checkout --detach <sha>`, `npm ci --ignore-scripts` if `package*.json` changed, delete `.next`,
   copy the live `.env.local`, start `npm run dev` with `STANDBY_PORT=3001` — `server/index.ts` comes up on
   `127.0.0.1:3001` against an **in-memory** PGlite (the real data dir is single-writer and still open in the old process);
2. warm it: `/api/health` until `ok:true,db:true`, then `/`, a dev login + `POST /api/documents`, `/d/<that id>`,
   `/api/documents?q=`, `/api/templates`, `/api/mcp`. A 500 or no answer here is a failed build: `ROLLBACK REASON` is
   printed, the standby is stopped and the old server was never touched;
3. handover: stop the old worktree's node processes, `POST http://127.0.0.1:3001/_standby/takeover` — the standby
   closes the throwaway database, opens `PGLITE_DATA_DIR`, listens on :3000 (retrying while the port is released) and
   closes :3001 — then `/api/health` on :3000 is polled and `markdoc-data/live.json` is rewritten. Measured gap on a
   copy: 0.5–1.9 s of no listener (the board tolerates two missed minutes). If the takeover fails, the old worktree is
   restarted with `start-live.ps1 -Restart` (a cold start, ~40 s).

Rehearse against a copy, never :3000: two detached worktrees `<dir>\live` and `<dir>\live-b` with their own
`node_modules`, `-Root <dir>\live -DataRoot <dir>\data -Port 3991 -StandbyPort 3992 -AnyRef`, and
`node scripts/live/promote-gap.mjs --port 3991 --seconds 300` in a second shell prints the longest run of non-200
answers. Open editors reconnect on their own (y-websocket backoff); the old process is stopped hard, so its last
≤ 1.5 s of unflushed Yjs stores are re-sent by the clients after they reconnect.
## Restore

`scripts/live/restore-data.ps1 [-From <dir>]` — `-From` defaults to `markdoc-data\snapshots\latest`;
after a factory-state restore pass `-From <factory-state>\projects\markdoc\markdoc-data\snapshots\latest`
(or copy that folder to `markdoc-data\snapshots\latest` first). It stops the live server, moves the current
`markdoc-data\pglite` to `pglite.bak-<timestamp>` (never deleted), extracts the tarball with
PGlite's own `loadDataDir` loader (`restore-data.mjs`), restarts via `start-live.ps1`, then checks
`/api/health` `db:true`, `GET /api/admin/backup?meta=1` document count == manifest, and that
`GET /api/documents` answers with the dev login. `-SkipServer` does only the data-dir part (first
restore before the server exists; `resume-check.ps1` uses this). `-DataDir` / `-Root` / `-Port`
override the defaults. **Never** point it at a directory a running server has open.

Verified round trip: dev server on :3911 with a temp `PGLITE_DATA_DIR`, two documents created,
`snapshot-data.ps1`, data dir deleted, `restore-data.ps1 -SkipServer`, server restarted →
the two documents are back (also covered by `src/app/api/admin/backup.test.ts`, which restores the
tarball in memory).

## Secrets (generated automatically by `resume-check.ps1`)

A fresh box needs **nothing from a human** for Markdoc: every value in `markdoc-live\.env.local`
is either a fresh random string or derived from the paths, so step 4 of `resume-check.ps1`
creates the file (or appends only the missing keys — existing values are never changed) and
prints the *names* it wrote (values stay in the file; the board's backup scrub refuses a log that
carries one). `-DryRun` prints what it would write instead.

| Key | What | Where the value comes from |
| --- | --- | --- |
| `AUTH_SECRET` | Auth.js session signing key | **Reused** from `<snapshot>\auth-secret.enc.json` when the snapshot has one and `FACTORY_STATE_KEY` is set (`env-vault.mjs open`), so nobody is signed out by a restore. Otherwise a fresh random string — the script then warns `users will be signed out once`: every browser lands on the signed-out page once and its old cookie is cleared by the first response (#1139), no error logged. |
| `AUTH_DEV_LOGIN` | `1` — sign in with any handle, no GitHub | Just `1` |
| `PGLITE_DATA_DIR` | Absolute path of the data dir | `<FACTORY_ROOT>\markdoc-data\pglite` |
| `BACKUP_TOKEN` | Gate for `/api/admin/backup` | Fresh random string. The snapshot job reads it from the same file, so they always match. |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` / `GITHUB_TOKEN` | Only for GitHub login and publish | **Optional, human-provided** if wanted; not needed on :3000 (dev login is used). GitHub OAuth app settings / `gh auth token`. Not written by the script. |

If the server was already running when the keys were written (started without them, or with
other values), `resume-check.ps1` restarts it via `start-live.ps1 -Restart` so it reads the new
file; otherwise the running server's `BACKUP_TOKEN` would differ from `.env.local`.

## Checklist: `scripts/live/resume-check.ps1` (`npm run resume-check`)

Exits 0 when Markdoc is back; prints a checklist and exits 1 at the first hard failure. Fixes what
it safely can unless `-DryRun`:

1. repo present; if `$env:FACTORY_MANIFEST` points at the board's manifest, HEAD == its markdoc sha (else skipped)
2. `node`, `npm`, `git` on PATH
3. `../markdoc-live` exists and is detached (created with `git worktree add --detach` if missing; `npm ci --ignore-scripts` if `node_modules` is missing); warns when it is behind `main` (that is `promote.ps1`'s job)
4. `.env.local` has `AUTH_SECRET`, `AUTH_DEV_LOGIN`, `PGLITE_DATA_DIR`, `BACKUP_TOKEN` — missing keys are written (file created or lines appended, existing values untouched) and their names printed; `AUTH_SECRET` is taken from the snapshot's `auth-secret.enc.json` when `FACTORY_STATE_KEY` can open it (`[ok] AUTH_SECRET - reused …`), else regenerated with a `[warn] … users will be signed out once`; a server that was already running is restarted so it reads them
5. `../markdoc-data/pglite` present, else restored from `$env:FACTORY_SNAPSHOT` or, when that is unset, `../markdoc-data/snapshots/latest` (folder with the tarball + manifest); without a tarball in either it warns and the server starts with an empty database (PGlite creates the folder) — not a failure
6. scheduled tasks "Markdoc live server", "Markdoc snapshot" and "Markdoc watchdog" registered (runs `install-autostart.ps1` if any is missing)
7. `/api/health` 200 with `db:true` within 180 s (`start-live.ps1` if not)
8. `GET /api/admin/backup?meta=1` with the token; `GET /api/documents` with the dev login (handle `resume-check`, `-CheckLogin` to change) answers 200
9. `../markdoc-data/snapshots/latest/manifest.json` exists and is < 30 min old — a **warning** only, since right after a restore the first run of the snapshot task may be up to 15 min away (`Start-ScheduledTask 'Markdoc snapshot'` forces one)

Manual order after a wipe, if not using bootstrap.ps1 (one run, unattended):

```powershell
git clone https://github.com/burkeholland/markdoc C:\Dev\ai-experiments\factory\markdoc
cd C:\Dev\ai-experiments\factory\markdoc; npm ci
# the folder with markdoc-pglite.tar.gz + manifest.json; from factory-state that is
# <factory-state>\projects\markdoc\markdoc-data\snapshots\latest (or copy it to ..\markdoc-data\snapshots\latest and skip this)
$env:FACTORY_SNAPSHOT = '<factory-state>\projects\markdoc\markdoc-data\snapshots\latest'
.\scripts\live\resume-check.ps1          # creates ../markdoc-live, writes .env.local, restores data, registers both tasks, starts :3000
# rehearse against scratch folders instead of the real ones: -LiveRoot <dir> -DataRoot <dir> -Port <n>
# and put the board's root nomination back so the next factory-state snapshot carries the data again:
#   <FACTORY_ROOT>\factory-state.nominate.json  ->  {"markdoc":["markdoc-data/snapshots/latest"]}
```
