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
| Log | `markdoc-data/live.log` (+ `.1` rotation) | Disposable |
| Scheduled task | "Markdoc live server" (per user, at logon) → `markdoc-live\scripts\live\start-live.ps1` | `scripts/live/install-autostart.ps1` |
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

`scripts/live/snapshot-data.ps1 -Out <dir>` (read-only for the server, ~8 s for 40 MB) writes:

- `<dir>\markdoc-pglite.tar.gz` — the backup
- `<dir>\manifest.json` — `{ sha, takenAt, bytes, documents, users, port, file, sha256, durationMs }`
  (`sha` is the live worktree's HEAD; `documents` counts non-deleted documents)

The board's snapshot job should call it every few minutes; it exits 1 (and writes nothing) when the
server is down or the token is wrong, so the previous snapshot stays intact. Token resolution:
`-Token`, else `$env:BACKUP_TOKEN`, else `BACKUP_TOKEN=` in `markdoc-live\.env.local`.

If the server is stopped anyway (e.g. the box is going down), a plain `robocopy /MIR` of
`markdoc-data\pglite` is also a valid snapshot — a stopped PGlite directory is consistent — and
`restore-data.ps1` is not needed for it: copy it back to `PGLITE_DATA_DIR` before starting.

## Restore

`scripts/live/restore-data.ps1 -From <dir>` — stops the live server, moves the current
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
5. `../markdoc-data/pglite` present, else restored from `$env:FACTORY_SNAPSHOT` (folder with the tarball + manifest); without a snapshot it warns that the server will start empty
6. scheduled task "Markdoc live server" registered (runs `install-autostart.ps1` if not)
7. `/api/health` 200 with `db:true` within 180 s (`start-live.ps1` if not)
8. `GET /api/admin/backup?meta=1` with the token; `GET /api/documents` with the dev login (handle `resume-check`, `-CheckLogin` to change) answers 200

Manual order after a wipe, if not using bootstrap.ps1:

```powershell
git clone https://github.com/burkeholland/markdoc C:\Dev\ai-experiments\factory\markdoc
cd C:\Dev\ai-experiments\factory\markdoc; npm ci
$env:FACTORY_SNAPSHOT = '<folder with markdoc-pglite.tar.gz + manifest.json>'
.\scripts\live\resume-check.ps1          # creates ../markdoc-live, tells you the .env.local lines
# paste them into ..\markdoc-live\.env.local, then:
.\scripts\live\resume-check.ps1          # restores data, registers the task, starts :3000
```
