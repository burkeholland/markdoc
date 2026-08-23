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
| Live worktree | `markdoc-live/` — detached at the promoted sha (`git worktree add --detach ../markdoc-live main`) | Yes, `resume-check.ps1` creates it |
| Live env | `markdoc-live/.env.local` — `AUTH_SECRET`, `AUTH_DEV_LOGIN=1`, `PGLITE_DATA_DIR`, `BACKUP_TOKEN` | Secrets: see below |
| **Data** | `markdoc-data/pglite/` — the embedded PGlite database (~39 MB, ~1050 files): documents, versions, assets, comments, notifications, users, API tokens | **Only from the snapshot** |
| Snapshot | `markdoc-data/snapshots/latest/` — current hot backup (`markdoc-pglite.tar.gz` + `manifest.json`), rewritten every 15 min; `markdoc-data/snapshots/<yyyyMMdd-HHmmss>/` — the last 3 copies | Recreated by the "Markdoc snapshot" task while the server runs |
| Log | `markdoc-data/live.log` (+ `.1` rotation) | Disposable |
| Scheduled tasks | "Markdoc live server" (per user, at logon) → `markdoc-live\scripts\live\start-live.ps1`; "Markdoc snapshot" (per user, every 15 min) → `snapshot-data.ps1 -Latest` | `scripts/live/install-autostart.ps1` registers both, `-Uninstall` removes both |
| Ports | 3000 live; 3100/31xx Playwright; 32xx–39xx dev servers (`npm run dev:port`) | — |

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
`scripts\live`, re-run `install-autostart.ps1` from `markdoc-live` so both tasks point at the
permanent location rather than a review worktree.

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

## Secrets to re-enter (`markdoc-live\.env.local`)

| Key | What | How to regenerate |
| --- | --- | --- |
| `AUTH_SECRET` | Auth.js session signing key | Any long random string; `resume-check.ps1` prints a fresh one. Changing it signs everyone out — fine. |
| `AUTH_DEV_LOGIN` | `1` — sign in with any handle, no GitHub | Just `1` |
| `PGLITE_DATA_DIR` | Absolute path of the data dir | `<FACTORY_ROOT>\markdoc-data\pglite` |
| `BACKUP_TOKEN` | Gate for `/api/admin/backup` | Any long random string; `resume-check.ps1` prints one. Must match what the snapshot job passes. |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` / `GITHUB_TOKEN` | Only for GitHub login and publish | Optional on :3000 (dev login is used). GitHub OAuth app settings / `gh auth token`. |

`resume-check.ps1` lists missing keys with ready-to-paste lines and never writes the file itself.

## Checklist: `scripts/live/resume-check.ps1` (`npm run resume-check`)

Exits 0 when Markdoc is back; prints a checklist and exits 1 at the first hard failure. Fixes what
it safely can unless `-DryRun`:

1. repo present; if `$env:FACTORY_MANIFEST` points at the board's manifest, HEAD == its markdoc sha (else skipped)
2. `node`, `npm`, `git` on PATH
3. `../markdoc-live` exists and is detached (created with `git worktree add --detach` if missing; `npm ci --ignore-scripts` if `node_modules` is missing); warns when it is behind `main` (that is `promote.ps1`'s job)
4. `.env.local` has `AUTH_SECRET`, `AUTH_DEV_LOGIN`, `PGLITE_DATA_DIR` (hard) and `BACKUP_TOKEN` (warning) — prints the lines to add
5. `../markdoc-data/pglite` present, else restored from `$env:FACTORY_SNAPSHOT` or, when that is unset, `../markdoc-data/snapshots/latest` (folder with the tarball + manifest); without a tarball in either it warns that the server will start empty
6. scheduled tasks "Markdoc live server" and "Markdoc snapshot" registered (runs `install-autostart.ps1` if either is missing)
7. `/api/health` 200 with `db:true` within 180 s (`start-live.ps1` if not)
8. `GET /api/admin/backup?meta=1` with the token; `GET /api/documents` with the dev login (handle `resume-check`, `-CheckLogin` to change) answers 200
9. `../markdoc-data/snapshots/latest/manifest.json` exists and is < 30 min old — a **warning** only, since right after a restore the first run of the snapshot task may be up to 15 min away (`Start-ScheduledTask 'Markdoc snapshot'` forces one)

Manual order after a wipe, if not using bootstrap.ps1:

```powershell
git clone https://github.com/burkeholland/markdoc C:\Dev\ai-experiments\factory\markdoc
cd C:\Dev\ai-experiments\factory\markdoc; npm ci
# the folder with markdoc-pglite.tar.gz + manifest.json; from factory-state that is
# <factory-state>\projects\markdoc\markdoc-data\snapshots\latest (or copy it to ..\markdoc-data\snapshots\latest and skip this)
$env:FACTORY_SNAPSHOT = '<factory-state>\projects\markdoc\markdoc-data\snapshots\latest'
.\scripts\live\resume-check.ps1          # creates ../markdoc-live, tells you the .env.local lines
# paste them into ..\markdoc-live\.env.local, then:
.\scripts\live\resume-check.ps1          # restores data, registers both tasks, starts :3000
# and put the board's root nomination back so the next factory-state snapshot carries the data again:
#   <FACTORY_ROOT>\factory-state.nominate.json  ->  {"markdoc":["markdoc-data/snapshots/latest"]}
```
