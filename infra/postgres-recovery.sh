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

health_file="$(mktemp /var/lib/postgresql/markdoc-backup-health.XXXXXX.json)"
trap 'rm -f "$health_file"' EXIT
trap 'logger -p local0.err -t markdoc-backup-monitor "backup-health=failed"' ERR

info="$(pgbackrest --stanza=markdoc --output=json info)"
archive_failed="$(
  psql -Atc "
    select case
      when last_failed_time is null then 0
      when last_archived_time is null or last_failed_time > last_archived_time then 1
      else 0
    end
    from pg_stat_archiver
  "
)"

python3 - "$health_file" "$info" "$archive_failed" <<'PY'
import datetime
import json
import sys

path, raw_info, archive_failed = sys.argv[1:]
info = json.loads(raw_info)
if not info or info[0].get("status", {}).get("code") != 0:
    raise SystemExit("pgBackRest repository is not healthy")

backups = info[0].get("backup", [])
if not backups:
    raise SystemExit("pgBackRest has no recoverable backup")

latest_backup = max(item["timestamp"]["stop"] for item in backups)
age_seconds = int(datetime.datetime.now(datetime.timezone.utc).timestamp()) - latest_backup
if age_seconds > 26 * 60 * 60:
    raise SystemExit("latest pgBackRest backup is stale")
if archive_failed != "0":
    raise SystemExit("PostgreSQL WAL archiving has an unresolved failure")

logical_marker = "/var/lib/pgbackrest/logical-last-success"
try:
    logical_age_seconds = int(
        datetime.datetime.now(datetime.timezone.utc).timestamp()
        - __import__("os").stat(logical_marker).st_mtime
    )
except FileNotFoundError:
    raise SystemExit("no successful logical backup has been recorded")
if logical_age_seconds > 26 * 60 * 60:
    raise SystemExit("latest logical backup is stale")

restore_marker = "/var/lib/pgbackrest/restore-last-success"
try:
    restore_age_seconds = int(
        datetime.datetime.now(datetime.timezone.utc).timestamp()
        - __import__("os").stat(restore_marker).st_mtime
    )
except FileNotFoundError:
    raise SystemExit("no successful scratch restore has been recorded")
if restore_age_seconds > 8 * 24 * 60 * 60:
    raise SystemExit("latest scratch restore verification is stale")

payload = {
    "ok": True,
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "latest_backup_epoch": latest_backup,
    "latest_backup_age_seconds": age_seconds,
    "latest_logical_backup_age_seconds": logical_age_seconds,
    "latest_restore_age_seconds": restore_age_seconds,
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(payload, stream, separators=(",", ":"))
PY

/usr/local/lib/markdoc-storage-upload \
  "$health_file" \
  'health/backup-latest.json' \
  'application/json'
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
pg_bin="/usr/lib/postgresql/\$(pg_config --version | awk '{print \$2}' | cut -d. -f1)/bin"
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
logger -p local0.info -t markdoc-restore-check 'restore-check=ok'
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
Description=Monitor Markdoc PostgreSQL recovery health every five minutes

[Timer]
OnBootSec=5m
OnUnitActiveSec=5m
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

systemctl daemon-reload
systemctl enable --now \
  markdoc-pgbackrest-full.timer \
  markdoc-logical-backup.timer \
  markdoc-backup-monitor.timer \
  markdoc-restore-check.timer
sudo -u postgres /usr/local/sbin/markdoc-backup-monitor
