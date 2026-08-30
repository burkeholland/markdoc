#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

STANZA='markdoc'
STORAGE_ACCOUNT='__STORAGE_ACCOUNT__'
STORAGE_CONTAINER='__STORAGE_CONTAINER__'
PG_DATA="$(sudo -u postgres psql -Atc 'show data_directory')"

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg postgresql-common
install -d -m 0755 /usr/share/postgresql-common/pgdg
curl -fsS https://www.postgresql.org/media/keys/ACCC4CF8.asc |
  gpg --dearmor --yes --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  >/etc/apt/sources.list.d/pgdg.list
# PGDG stays a pgbackrest-only source: Ubuntu's postgresql-16 keeps taking its minors from noble-security/noble-updates,
# and nothing else from apt.postgresql.org (its postgresql/postgresql-client metapackages point at a newer major) becomes
# an apt candidate, so neither the monthly OS patch nor a rerun of this script can change the PostgreSQL major.
cat >/etc/apt/preferences.d/markdoc-pgdg <<'EOF'
Package: *
Pin: origin apt.postgresql.org
Pin-Priority: 100

Package: pgbackrest
Pin: origin apt.postgresql.org
Pin-Priority: 500
EOF
apt-get update
apt-get install -y --no-install-recommends pgbackrest
pgbackrest_version="$(pgbackrest version | awk '{print $2}')"
if ! dpkg --compare-versions "$pgbackrest_version" ge '2.58'; then
  echo 'pgBackRest 2.58 or newer is required for Azure managed identity.' >&2
  exit 1
fi

install -d -o postgres -g postgres -m 0750 \
  /etc/pgbackrest \
  /var/lib/pgbackrest \
  /var/log/pgbackrest \
  /var/spool/pgbackrest

cat >/etc/pgbackrest/pgbackrest.conf <<EOF
[${STANZA}]
pg1-path=${PG_DATA}

[global]
repo1-type=azure
repo1-path=/markdoc
repo1-azure-account=${STORAGE_ACCOUNT}
repo1-azure-container=${STORAGE_CONTAINER}
repo1-azure-key-type=auto
repo1-retention-full=7
archive-async=y
spool-path=/var/spool/pgbackrest
start-fast=y
process-max=2
log-level-console=info
log-level-file=detail
EOF
chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
chmod 0640 /etc/pgbackrest/pgbackrest.conf

cat >/usr/local/lib/markdoc-storage-upload <<'UPLOAD'
#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo 'usage: markdoc-storage-upload <file> <blob-path> <content-type>' >&2
  exit 2
fi

file="$1"
blob_path="$2"
content_type="$3"
storage_account='__STORAGE_ACCOUNT__'
storage_container='__STORAGE_CONTAINER__'
token_url='http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F'
token="$(
  curl -fsS -H 'Metadata: true' "$token_url" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
)"

curl -fsS --retry 5 --retry-all-errors -X PUT \
  -H "Authorization: Bearer ${token}" \
  -H 'x-ms-version: 2023-11-03' \
  -H "x-ms-date: $(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S GMT')" \
  -H 'x-ms-blob-type: BlockBlob' \
  -H "Content-Type: ${content_type}" \
  --data-binary "@${file}" \
  "https://${storage_account}.blob.core.windows.net/${storage_container}/${blob_path}"

unset token
UPLOAD
sed -i \
  -e "s/__STORAGE_ACCOUNT__/${STORAGE_ACCOUNT}/g" \
  -e "s/__STORAGE_CONTAINER__/${STORAGE_CONTAINER}/g" \
  /usr/local/lib/markdoc-storage-upload
chmod 0755 /usr/local/lib/markdoc-storage-upload

cat >/usr/local/sbin/markdoc-logical-backup <<'LOGICAL'
#!/usr/bin/env bash
set -euo pipefail

trap 'logger -p local0.err -t markdoc-logical-backup "logical-backup=failed"' ERR

database_size="$(psql -Atc "select pg_database_size('markdoc')")"
free_bytes="$(df --output=avail -B1 /var/lib/postgresql | tail -n 1 | tr -d ' ')"
required_bytes="$((database_size + 2 * 1024 * 1024 * 1024))"
if [ "$free_bytes" -lt "$required_bytes" ]; then
  echo 'Insufficient free disk space for a logical backup.' >&2
  exit 1
fi

backup_file="$(mktemp /var/lib/postgresql/markdoc-logical.XXXXXX.dump)"
trap 'rm -f "$backup_file"' EXIT
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

pg_dump --format=custom --compress=9 --file="$backup_file" markdoc
/usr/local/lib/markdoc-storage-upload \
  "$backup_file" \
  "logical/markdoc-${timestamp}.dump" \
  'application/octet-stream'
install -o postgres -g postgres -m 0640 /dev/null /var/lib/pgbackrest/logical-last-success
logger -p local0.info -t markdoc-logical-backup 'logical-backup=ok'
LOGICAL
chmod 0755 /usr/local/sbin/markdoc-logical-backup

cat >/usr/local/sbin/markdoc-backup-monitor <<'MONITOR'
#!/usr/bin/env bash
set -euo pipefail
cd /

health_file="$(mktemp /var/lib/postgresql/markdoc-backup-health.XXXXXX.json)"
trap 'rm -f "$health_file"' EXIT
trap 'logger -p local0.err -t markdoc-backup-monitor "backup-health=failed"' ERR

info="$(pgbackrest --stanza=markdoc --output=json info)"
archive_stats="$(
  psql -AtF '|' -c "
    select
      coalesce(extract(epoch from last_archived_time)::bigint, 0),
      coalesce(extract(epoch from last_failed_time)::bigint, 0),
      failed_count
    from pg_stat_archiver
  "
)"
IFS='|' read -r last_archived_epoch last_failed_epoch archive_failed_count <<<"$archive_stats"

pg_data="$(psql -Atc 'show data_directory')"
archive_status_dir="${MARKDOC_ARCHIVE_STATUS_DIR:-${pg_data}/pg_wal/archive_status}"
archive_pending_count=0
archive_pending_bytes=0
archive_pending_oldest_epoch=0
while IFS= read -r status_file; do
  if ! status_epoch="$(stat -c %Y "$status_file" 2>/dev/null)"; then
    continue
  fi
  archive_pending_count="$((archive_pending_count + 1))"
  if [ "$archive_pending_oldest_epoch" -eq 0 ] || [ "$status_epoch" -lt "$archive_pending_oldest_epoch" ]; then
    archive_pending_oldest_epoch="$status_epoch"
  fi
  wal_file="${pg_data}/pg_wal/$(basename "$status_file" .ready)"
  if [ -f "$wal_file" ]; then
    if wal_bytes="$(stat -c %s "$wal_file" 2>/dev/null)"; then
      archive_pending_bytes="$((archive_pending_bytes + wal_bytes))"
    fi
  fi
done < <(find "$archive_status_dir" -maxdepth 1 -type f -name '*.ready' -print)

spool_dir='/var/spool/pgbackrest/archive/markdoc/out'
archive_spool_file_count=0
archive_spool_bytes=0
if [ -d "$spool_dir" ]; then
  archive_spool_file_count="$(find "$spool_dir" -maxdepth 1 -type f | wc -l)"
  archive_spool_bytes="$(find "$spool_dir" -maxdepth 1 -type f -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')"
fi

archive_max_age_seconds="${MARKDOC_ARCHIVE_MAX_AGE_SECONDS:-300}"
test_stale="${MARKDOC_MONITOR_TEST_STALE:-0}"
health_ok="$(
python3 - \
  "$health_file" \
  "$info" \
  "$last_archived_epoch" \
  "$last_failed_epoch" \
  "$archive_failed_count" \
  "$archive_pending_count" \
  "$archive_pending_bytes" \
  "$archive_pending_oldest_epoch" \
  "$archive_spool_file_count" \
  "$archive_spool_bytes" \
  "$archive_max_age_seconds" \
  "$test_stale" <<'PY'
import datetime
import json
import os
import sys

(
    path,
    raw_info,
    last_archived_epoch,
    last_failed_epoch,
    archive_failed_count,
    archive_pending_count,
    archive_pending_bytes,
    archive_pending_oldest_epoch,
    archive_spool_file_count,
    archive_spool_bytes,
    archive_max_age_seconds,
    test_stale,
) = sys.argv[1:]
now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
last_archived_epoch = int(last_archived_epoch)
last_failed_epoch = int(last_failed_epoch)
archive_failed_count = int(archive_failed_count)
archive_pending_count = int(archive_pending_count)
archive_pending_bytes = int(archive_pending_bytes)
archive_pending_oldest_epoch = int(archive_pending_oldest_epoch)
archive_spool_file_count = int(archive_spool_file_count)
archive_spool_bytes = int(archive_spool_bytes)
archive_max_age_seconds = int(archive_max_age_seconds)
test_stale = test_stale == "1"

info = json.loads(raw_info)
errors = []
if not info or info[0].get("status", {}).get("code") != 0:
    errors.append("pgBackRest repository is not healthy")

backups = info[0].get("backup", []) if info else []
if not backups:
    errors.append("pgBackRest has no recoverable backup")
    latest_backup = 0
    age_seconds = None
else:
    latest_backup = max(item["timestamp"]["stop"] for item in backups)
    age_seconds = now - latest_backup
    if age_seconds > 26 * 60 * 60:
        errors.append("latest pgBackRest backup is stale")

archive_age_seconds = now - last_archived_epoch if last_archived_epoch else None
if test_stale:
    archive_age_seconds = archive_max_age_seconds + 1
if archive_age_seconds is None:
    errors.append("PostgreSQL has no successful WAL archive")
elif archive_pending_count and archive_age_seconds > archive_max_age_seconds:
    errors.append("latest PostgreSQL WAL archive is stale")
if last_failed_epoch and (
    not last_archived_epoch or last_failed_epoch > last_archived_epoch
):
    errors.append("PostgreSQL WAL archiving has an unresolved failure")

archive_pending_oldest_age_seconds = (
    now - archive_pending_oldest_epoch if archive_pending_oldest_epoch else None
)
if test_stale:
    archive_pending_count = max(archive_pending_count, 1)
    archive_pending_oldest_age_seconds = archive_max_age_seconds + 1
if (
    archive_pending_oldest_age_seconds is not None
    and archive_pending_oldest_age_seconds > archive_max_age_seconds
):
    errors.append("PostgreSQL WAL archive backlog is stale")

logical_marker = "/var/lib/pgbackrest/logical-last-success"
try:
    logical_age_seconds = int(now - os.stat(logical_marker).st_mtime)
except FileNotFoundError:
    errors.append("no successful logical backup has been recorded")
    logical_age_seconds = None
if logical_age_seconds is not None and logical_age_seconds > 26 * 60 * 60:
    errors.append("latest logical backup is stale")

restore_marker = "/var/lib/pgbackrest/restore-last-success"
try:
    restore_age_seconds = int(now - os.stat(restore_marker).st_mtime)
except FileNotFoundError:
    errors.append("no successful scratch restore has been recorded")
    restore_age_seconds = None
if restore_age_seconds is not None and restore_age_seconds > 8 * 24 * 60 * 60:
    errors.append("latest scratch restore verification is stale")

payload = {
    "ok": not errors,
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "latest_backup_epoch": latest_backup,
    "latest_backup_age_seconds": age_seconds,
    "latest_logical_backup_age_seconds": logical_age_seconds,
    "latest_restore_age_seconds": restore_age_seconds,
    "archive_last_success_epoch": last_archived_epoch or None,
    "archive_age_seconds": archive_age_seconds,
    "archive_max_age_seconds": archive_max_age_seconds,
    "archive_failed_count": archive_failed_count,
    "archive_has_unresolved_failure": bool(
        last_failed_epoch
        and (not last_archived_epoch or last_failed_epoch > last_archived_epoch)
    ),
    "archive_pending_count": archive_pending_count,
    "archive_pending_bytes": archive_pending_bytes,
    "archive_pending_oldest_age_seconds": archive_pending_oldest_age_seconds,
    "archive_spool_status_file_count": archive_spool_file_count,
    "archive_spool_status_bytes": archive_spool_bytes,
    "test_mode": test_stale,
}
if errors:
    payload["errors"] = errors
with open(path, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, separators=(",", ":"))
print("true" if not errors else "false")
PY
)"

health_blob='health/backup-latest.json'
if [ "$test_stale" = '1' ]; then
  health_blob='health/backup-test-latest.json'
fi
/usr/local/lib/markdoc-storage-upload \
  "$health_file" \
  "$health_blob" \
  'application/json'

if [ "$health_ok" != 'true' ]; then
  trap - ERR
  logger -p local0.err -t markdoc-backup-monitor 'backup-health=failed'
  exit 1
fi
logger -p local0.info -t markdoc-backup-monitor 'backup-health=ok'
MONITOR
chmod 0755 /usr/local/sbin/markdoc-backup-monitor

cat >/usr/local/sbin/markdoc-restore-check <<RESTORE
#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lock/markdoc-restore-check.lock
flock -n 9 || {
  echo 'A restore verification is already running.' >&2
  exit 1
}

restore_dir="\$(mktemp -d /var/lib/postgresql/markdoc-restore-check.XXXXXX)"
result_file="\$(mktemp /var/lib/postgresql/markdoc-restore-result.XXXXXX.json)"
pg_major="\$(sudo -u postgres psql -Atc "select current_setting('server_version_num')::int / 10000")"
pg_bin="/usr/lib/postgresql/\${pg_major}/bin"
started_epoch="\$(date +%s)"
started_at="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_cluster=0

cleanup() {
  if [ "\$started_cluster" -eq 1 ] || [ -f "\$restore_dir/postmaster.pid" ]; then
    sudo -u postgres "\${pg_bin}/pg_ctl" -D "\$restore_dir" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "\$restore_dir" "\$result_file"
}
trap cleanup EXIT
trap 'logger -p local0.err -t markdoc-restore-check "restore-check=failed"' ERR

backup_size="\$(
  sudo -u postgres pgbackrest --stanza=${STANZA} --output=json info |
    python3 -c '
import json
import sys

info = json.load(sys.stdin)
backups = info[0].get("backup", [])
if not backups:
    raise SystemExit("no backup available")
print(max(backups, key=lambda item: item["timestamp"]["stop"])["info"]["size"])
'
)"
free_bytes="\$(df --output=avail -B1 /var/lib/postgresql | tail -n 1 | tr -d ' ')"
required_bytes="\$((backup_size + 2 * 1024 * 1024 * 1024))"
if [ "\$free_bytes" -lt "\$required_bytes" ]; then
  echo 'Insufficient free disk space for an isolated scratch restore.' >&2
  exit 1
fi

chown postgres:postgres "\$restore_dir" "\$result_file"
sudo -u postgres pgbackrest \
  --stanza=${STANZA} \
  --pg1-path="\$restore_dir" \
  --archive-mode=off \
  --type=immediate \
  --target-action=promote \
  restore

cat >"\$restore_dir/postgresql.conf" <<CONF
data_directory = '\$restore_dir'
hba_file = '\$restore_dir/pg_hba.conf'
ident_file = '\$restore_dir/pg_ident.conf'
port = 55432
listen_addresses = ''
unix_socket_directories = '\$restore_dir'
ssl = off
archive_mode = off
max_connections = 100
hot_standby = off
CONF
printf 'local all all trust\n' >"\$restore_dir/pg_hba.conf"
: >"\$restore_dir/pg_ident.conf"
chown postgres:postgres \
  "\$restore_dir/postgresql.conf" \
  "\$restore_dir/pg_hba.conf" \
  "\$restore_dir/pg_ident.conf"

started_cluster=1
sudo -u postgres env PGCTLTIMEOUT=7000 "\${pg_bin}/pg_ctl" \
  -D "\$restore_dir" \
  -o "-c archive_mode=off -c hot_standby=off" \
  -l "\$restore_dir/postgresql.log" \
  -w start >/dev/null

recovered=0
for attempt in \$(seq 1 1380); do
  if sudo -u postgres psql \
    -h "\$restore_dir" \
    -p 55432 \
    -d markdoc \
    -v ON_ERROR_STOP=1 \
    -Atc "select case when pg_is_in_recovery() then 0 else 1 end" \
    2>/dev/null |
    grep -qx 1; then
    recovered=1
    break
  fi
  sleep 5
done
if [ "\$recovered" -ne 1 ]; then
  echo 'Scratch PostgreSQL did not finish recovery within 115 minutes.' >&2
  exit 1
fi

completed_epoch="\$(date +%s)"
duration_seconds="\$((completed_epoch - started_epoch))"
completed_at="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "\$result_file" "\$started_at" "\$completed_at" "\$duration_seconds" <<'PY'
import json
import sys

path, started_at, completed_at, duration_seconds = sys.argv[1:]
with open(path, "w", encoding="utf-8") as stream:
    json.dump(
        {
            "ok": True,
            "started_at": started_at,
            "completed_at": completed_at,
            "duration_seconds": int(duration_seconds),
        },
        stream,
        separators=(",", ":"),
    )
PY

/usr/local/lib/markdoc-storage-upload \
  "\$result_file" \
  'health/restore-latest.json' \
  'application/json'
install -o postgres -g postgres -m 0640 /dev/null /var/lib/pgbackrest/restore-last-success
logger -p local0.info -t markdoc-restore-check "restore-check=ok duration-seconds=\$duration_seconds"
printf 'restore-check=ok duration-seconds=%s completed-at=%s\n' \
  "\$duration_seconds" \
  "\$completed_at"
RESTORE
chmod 0755 /usr/local/sbin/markdoc-restore-check

cat >/etc/systemd/system/markdoc-pgbackrest-full.service <<'EOF'
[Unit]
Description=Markdoc daily pgBackRest full backup
After=postgresql.service network-online.target

[Service]
Type=oneshot
User=postgres
Group=postgres
ExecStart=/usr/bin/pgbackrest --stanza=markdoc --type=full backup
EOF

cat >/etc/systemd/system/markdoc-pgbackrest-full.timer <<'EOF'
[Unit]
Description=Run the Markdoc pgBackRest full backup daily

[Timer]
OnCalendar=*-*-* 02:30:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

cat >/etc/systemd/system/markdoc-logical-backup.service <<'EOF'
[Unit]
Description=Markdoc daily logical PostgreSQL backup
After=postgresql.service network-online.target

[Service]
Type=oneshot
User=postgres
Group=postgres
ExecStart=/usr/local/sbin/markdoc-logical-backup
EOF

cat >/etc/systemd/system/markdoc-logical-backup.timer <<'EOF'
[Unit]
Description=Run the Markdoc logical PostgreSQL backup daily

[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

cat >/etc/systemd/system/markdoc-backup-monitor.service <<'EOF'
[Unit]
Description=Verify Markdoc PostgreSQL backup freshness and archive health
After=postgresql.service network-online.target

[Service]
Type=oneshot
User=postgres
Group=postgres
ExecStart=/usr/local/sbin/markdoc-backup-monitor
EOF

cat >/etc/systemd/system/markdoc-backup-monitor.timer <<'EOF'
[Unit]
Description=Monitor Markdoc PostgreSQL recovery health every two minutes

[Timer]
OnBootSec=2m
OnUnitActiveSec=2m
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF

cat >/etc/systemd/system/markdoc-restore-check.service <<'EOF'
[Unit]
Description=Prove a Markdoc PostgreSQL backup in an isolated scratch cluster
After=postgresql.service network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/markdoc-restore-check
TimeoutStartSec=2h
EOF

cat >/etc/systemd/system/markdoc-restore-check.timer <<'EOF'
[Unit]
Description=Run the Markdoc scratch restore proof weekly

[Timer]
OnCalendar=Sun *-*-* 05:00:00 UTC
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
EOF

for attempt in $(seq 1 30); do
  if sudo -u postgres pgbackrest --stanza="$STANZA" stanza-create; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo 'pgBackRest repository access did not become ready' >&2
    exit 1
  fi
  sleep 10
done

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
alter system set wal_level = 'replica';
alter system set archive_mode = 'on';
alter system set archive_command = 'pgbackrest --stanza=markdoc archive-push %p';
alter system set archive_timeout = '240s';
SQL
systemctl restart postgresql

sudo -u postgres pgbackrest --stanza="$STANZA" check
sudo -u postgres pgbackrest --stanza="$STANZA" --type=full backup
sudo -u postgres /usr/local/sbin/markdoc-logical-backup
/usr/local/sbin/markdoc-restore-check
sudo -u postgres /usr/local/sbin/markdoc-backup-monitor

systemctl daemon-reload
systemctl enable --now \
  markdoc-pgbackrest-full.timer \
  markdoc-logical-backup.timer \
  markdoc-backup-monitor.timer \
  markdoc-restore-check.timer
echo 'recovery-verification=ok'
