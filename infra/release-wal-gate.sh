#!/usr/bin/env bash

run_markdoc_release_wal_gate() {
  set -euo pipefail

  if [ "$#" -ne 1 ]; then
    echo 'usage: release-wal-gate.sh <operation-id>' >&2
    return 2
  fi

  operation_id="$1"
  if ! [[ "$operation_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo 'operation id must be a UUID' >&2
    return 2
  fi

  test_root="${MARKDOC_RELEASE_WAL_GATE_TEST_ROOT:-}"
  lock_file='/run/lock/markdoc-release-wal-gate.lock'
  scratch_parent='/var/lib/postgresql'
  archive_timeout=300
  restore_timeout=600
  start_timeout=240
  recovery_timeout=600
  query_timeout=30
  stop_timeout=45
  if [ -n "$test_root" ]; then
    if [[ "$test_root" != /* ]] || [ "$test_root" = / ]; then
      echo 'test root must be an absolute non-root directory' >&2
      return 2
    fi
    lock_file="${test_root}/run/lock/markdoc-release-wal-gate.lock"
    scratch_parent="${test_root}/var/lib/postgresql"
    archive_timeout="${MARKDOC_RELEASE_WAL_GATE_ARCHIVE_TIMEOUT:-2}"
    restore_timeout="${MARKDOC_RELEASE_WAL_GATE_RESTORE_TIMEOUT:-10}"
    start_timeout="${MARKDOC_RELEASE_WAL_GATE_START_TIMEOUT:-10}"
    recovery_timeout="${MARKDOC_RELEASE_WAL_GATE_RECOVERY_TIMEOUT:-10}"
    query_timeout="${MARKDOC_RELEASE_WAL_GATE_QUERY_TIMEOUT:-5}"
    stop_timeout="${MARKDOC_RELEASE_WAL_GATE_STOP_TIMEOUT:-5}"
  elif [ "$(id -u)" -ne 0 ]; then
    echo 'release WAL gate must run as root' >&2
    return 1
  fi
  local timeout_value
  for timeout_value in "$archive_timeout" "$restore_timeout" "$start_timeout" "$recovery_timeout" "$query_timeout" "$stop_timeout"; do
    if ! [[ "$timeout_value" =~ ^[1-9][0-9]{0,3}$ ]]; then
      echo 'release WAL gate timeout is invalid' >&2
      return 2
    fi
  done
  if [ ! -d "$(dirname "$lock_file")" ] || [ ! -d "$scratch_parent" ]; then
    echo 'release WAL gate runtime directories are unavailable' >&2
    return 1
  fi

  stage='lock'
  scratch_root=''
  data_dir=''
  socket_dir=''
  control_file=''
  native_log=''
  server_log=''
  pg_bin=''
  active_pid=''
  owned_postgres_pid=''
  finalized=false
  endpoint=''
  wal_object=''
  archive_object=''
  replay_lsn=''
  gate_saved_stderr=''
  space_guard_active=false
  space_failed=false
  space_failure=''
  production_reserve=$((2 * 1024 * 1024 * 1024))
  unset MARKDOC_RELEASE_WAL_GATE_OPERATION
  local restore_point="markdoc_release_${operation_id//-/}"

  cleanup_owned() {
    local failed=0
    local attempt
    if [ -n "$active_pid" ] && kill -0 "$active_pid" 2>/dev/null; then
      kill -TERM "$active_pid" 2>/dev/null || true
      for attempt in $(seq 1 10); do
        kill -0 "$active_pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$active_pid" 2>/dev/null; then
        kill -KILL "$active_pid" 2>/dev/null || failed=1
      fi
      wait "$active_pid" 2>/dev/null || true
      active_pid=''
    fi

    if [ -n "$data_dir" ] && { [ -n "$owned_postgres_pid" ] || [ -f "$data_dir/postmaster.pid" ]; }; then
      if [ -n "$pg_bin" ] && [ -x "$pg_bin/pg_ctl" ]; then
        timeout --signal=TERM --kill-after=5s "${stop_timeout}s" \
          sudo -u postgres "$pg_bin/pg_ctl" -D "$data_dir" -m immediate -w stop \
          >/dev/null 2>&1 || true
      fi
      if [ -z "$owned_postgres_pid" ] && [ -f "$data_dir/postmaster.pid" ]; then
        owned_postgres_pid="$(sed -n '1p' "$data_dir/postmaster.pid" 2>/dev/null || true)"
      fi
      if [[ "$owned_postgres_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owned_postgres_pid" 2>/dev/null; then
        local command_line=''
        command_line="$(tr '\0' ' ' <"/proc/${owned_postgres_pid}/cmdline" 2>/dev/null || true)"
        if [[ "$command_line" == *"$data_dir"* ]]; then
          kill -TERM "$owned_postgres_pid" 2>/dev/null || true
          for attempt in $(seq 1 10); do
            kill -0 "$owned_postgres_pid" 2>/dev/null || break
            sleep 1
          done
          if kill -0 "$owned_postgres_pid" 2>/dev/null; then
            kill -KILL "$owned_postgres_pid" 2>/dev/null || failed=1
          fi
        else
          failed=1
        fi
      fi
    fi

    if [ -n "$scratch_root" ]; then
      local prefix="${scratch_parent}/markdoc-release-wal.${operation_id}."
      local suffix="${scratch_root#"$prefix"}"
      if [ "$scratch_root" = "${prefix}${suffix}" ] && [[ "$suffix" =~ ^[A-Za-z0-9]{6}$ ]]; then
        if [[ "$owned_postgres_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owned_postgres_pid" 2>/dev/null; then
          failed=1
        else
          rm -rf -- "$scratch_root" || failed=1
          [ ! -e "$scratch_root" ] || failed=1
        fi
      else
        failed=1
      fi
    fi
    return "$failed"
  }

  on_exit() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$finalized" != true ]; then
      local cleaned=true
      local diagnostics=''
      diagnostics="$(collect_server_diagnostics)" ||
        diagnostics="markdoc-release-wal-log:${operation_id}:ERROR:diagnostics-unavailable"
      cleanup_owned || cleaned=false
      printf 'markdoc-release-wal-failed:%s:%s:cleanup=%s\n' \
        "$operation_id" "$stage" "$cleaned"
      if [ -n "$space_failure" ]; then
        printf 'markdoc-release-wal-space:%s:%s\n' "$operation_id" "$space_failure"
      fi
      if [ -n "$diagnostics" ]; then
        printf '%s\n' "$diagnostics"
      fi
      [ "$status" -ne 0 ] || status=1
    fi
    return "$status"
  }

  collect_server_diagnostics() {
    [ -n "$server_log" ] && [ -s "$server_log" ] || return 0
    timeout --signal=TERM --kill-after=1s 5s python3 -c '
import os
import re
import sys

reasons = (
    ("No space left on device", "disk-full"),
    ("Cannot allocate memory", "no-memory"),
    ("out of memory", "no-memory"),
    ("recovery ended before configured recovery target was reached", "recovery-target-unreached"),
    ("requested recovery stop point is before consistent recovery point", "recovery-target-before-consistency"),
    ("could not locate a valid checkpoint record", "invalid-checkpoint"),
    ("could not restore file", "wal-unavailable"),
    ("Permission denied", "permission-denied"),
    ("Input/output error", "io-error"),
)
with open(sys.argv[1], "rb") as stream:
    stream.seek(max(0, os.fstat(stream.fileno()).st_size - 16384))
    tail = stream.read(16384).decode("utf-8", errors="replace")
entries = []
for line in tail.splitlines():
    match = re.search(r"(?:^| )(WARNING|ERROR|FATAL|PANIC):\s+(.*)", line)
    if match is None:
        continue
    reason = next((code for text, code in reasons if text in match[2]), "message-withheld")
    entries.append(f"markdoc-release-wal-log:{sys.argv[2]}:{match[1]}:{reason}")
print("\n".join(entries[-10:]), end="\n" if entries else "")
' "$server_log" "$operation_id"
  }

  check_space() {
    local minimum="$1"
    local free_bytes=''
    if ! free_bytes="$(timeout --signal=TERM --kill-after=1s 5s \
      df --output=avail -B1 "$scratch_parent" | tail -n 1 | tr -d '[:space:]')" ||
      ! [[ "$free_bytes" =~ ^[0-9]{1,18}$ ]]; then
      stage='space'
      space_failed=true
      space_failure='reason=unavailable'
      return 1
    fi
    if [ "$free_bytes" -lt "$minimum" ]; then
      stage='space'
      space_failed=true
      space_failure="available=${free_bytes}:required=${minimum}:reserve=${production_reserve}"
      return 1
    fi
  }

  wait_active() {
    local status=0
    local poll
    if [ "$space_guard_active" = true ]; then
      check_space "$production_reserve" || return 1
      while kill -0 "$active_pid" 2>/dev/null; do
        check_space "$production_reserve" || return 1
        for poll in $(seq 1 10); do
          kill -0 "$active_pid" 2>/dev/null || break
          sleep 0.1
        done
      done
    fi
    wait "$active_pid" || status=$?
    active_pid=''
    return "$status"
  }

  run_capture() {
    local seconds="$1"
    shift
    : >"$control_file"
    : >"$native_log"
    timeout --signal=TERM --kill-after=10s "${seconds}s" "$@" \
      >"$control_file" 2>"$native_log" &
    active_pid=$!
    wait_active
  }

  run_silent() {
    local seconds="$1"
    shift
    : >"$native_log"
    timeout --signal=TERM --kill-after=10s "${seconds}s" "$@" \
      >"$native_log" 2>&1 &
    active_pid=$!
    wait_active
  }

  read_control() {
    tr -d '\r\n' <"$control_file"
  }

  printf 'markdoc-release-wal-operation:%s\n' "$operation_id"
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  exec {gate_saved_stderr}>&2
  exec 2>/dev/null

  exec 9>"$lock_file"
  flock -n 9

  stage='capture'
  scratch_root="$(mktemp -d "${scratch_parent}/markdoc-release-wal.${operation_id}.XXXXXX")"
  chmod 0700 "$scratch_root"
  chown postgres:postgres "$scratch_root"
  data_dir="$scratch_root/data"
  socket_dir="$scratch_root/socket"
  mkdir "$data_dir" "$socket_dir"
  chmod 0700 "$data_dir" "$socket_dir"
  chown postgres:postgres "$data_dir" "$socket_dir"
  control_file="$scratch_root/control"
  native_log="$scratch_root/command.log"
  server_log="$scratch_root/postgres.log"
  install -o postgres -g postgres -m 0600 /dev/null "$control_file"
  install -o postgres -g postgres -m 0600 /dev/null "$native_log"
  install -o postgres -g postgres -m 0600 /dev/null "$server_log"

  run_capture "$query_timeout" sudo -u postgres psql -X -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c 'show data_directory'
  local primary_data
  primary_data="$(read_control)"
  if [[ "$primary_data" != /* ]] || [ ! -d "$primary_data/pg_wal/archive_status" ]; then
    return 1
  fi

  run_capture "$query_timeout" sudo -u postgres psql -X -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c \
    "with endpoint as materialized (select pg_create_restore_point('${restore_point}') as lsn) select upper(lsn::text) || '|' || pg_walfile_name(lsn) from endpoint"
  local capture
  capture="$(read_control)"
  IFS='|' read -r endpoint wal_object <<<"$capture"
  if ! [[ "$endpoint" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] ||
    ! [[ "$wal_object" =~ ^[0-9A-F]{24}$ ]]; then
    return 1
  fi
  printf 'markdoc-release-wal-capture:%s:%s:%s\n' \
    "$operation_id" "$endpoint" "$wal_object"

  stage='switch'
  run_silent "$query_timeout" sudo -u postgres psql -X -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c 'select pg_switch_wal()'
  printf 'markdoc-release-wal-switch:%s:true\n' "$operation_id"

  stage='archive'
  local archive_marker="$primary_data/pg_wal/archive_status/${wal_object}.done"
  local archive_deadline=$((SECONDS + archive_timeout))
  while [ ! -f "$archive_marker" ] || [ -L "$archive_marker" ]; do
    if [ "$SECONDS" -ge "$archive_deadline" ]; then
      return 1
    fi
    sleep 1
  done

  local archive_remaining=$((archive_deadline - SECONDS))
  if [ "$archive_remaining" -le 0 ]; then
    return 1
  fi
  if [ "$archive_remaining" -gt "$query_timeout" ]; then
    archive_remaining="$query_timeout"
  fi
  run_capture "$archive_remaining" sudo -u postgres pgbackrest \
    --stanza=markdoc \
    --repo=1 \
    --output=json \
    --log-level-console=off \
    info
  local archive_id
  archive_id="$(python3 -c '
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
if (
    not isinstance(result, list)
    or len(result) != 1
    or result[0].get("name") != "markdoc"
):
    raise SystemExit(1)
archives = [
    archive.get("id")
    for archive in result[0].get("archive", [])
    if archive.get("database", {}).get("repo-key") == 1
]
if (
    len(archives) != 1
    or not isinstance(archives[0], str)
    or re.fullmatch(r"[0-9]+(?:\.[0-9]+)?-[1-9][0-9]*", archives[0]) is None
):
    raise SystemExit(1)
print(archives[0])
' "$control_file")"

  local archive_path="archive/markdoc/${archive_id}/${wal_object:0:16}"
  while [ -z "$archive_object" ]; do
    archive_remaining=$((archive_deadline - SECONDS))
    if [ "$archive_remaining" -le 0 ]; then
      return 1
    fi
    if [ "$archive_remaining" -gt "$query_timeout" ]; then
      archive_remaining="$query_timeout"
    fi
    run_capture "$archive_remaining" sudo -u postgres pgbackrest \
      --stanza=markdoc \
      --repo=1 \
      --output=json \
      --log-level-console=off \
      repo-ls "$archive_path"
    archive_object="$(python3 -c '
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
if not isinstance(result, dict):
    raise SystemExit(1)
pattern = re.compile(
    re.escape(sys.argv[2]) + r"-[0-9a-f]{40}(?:\.(?:bz2|gz|lz4|zst))?"
)
matches = [
    name
    for name, metadata in result.items()
    if (
        isinstance(name, str)
        and isinstance(metadata, dict)
        and metadata.get("type") == "file"
        and pattern.fullmatch(name) is not None
    )
]
if len(matches) > 1:
    raise SystemExit(1)
if matches:
    print(matches[0])
' "$control_file" "$wal_object")"
    if [ -z "$archive_object" ]; then
      sleep 1
    fi
  done
  printf 'markdoc-release-wal-archive:%s:%s:%s\n' \
    "$operation_id" "$wal_object" "$archive_object"

  run_capture "$query_timeout" sudo -u postgres psql -X -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c \
    "select current_setting('server_version_num')::int / 10000"
  local pg_major
  pg_major="$(read_control)"
  if ! [[ "$pg_major" =~ ^[1-9][0-9]?$ ]]; then
    return 1
  fi
  pg_bin="/usr/lib/postgresql/${pg_major}/bin"
  if [ -n "$test_root" ]; then
    pg_bin="${test_root}${pg_bin}"
  fi
  [ -x "$pg_bin/pg_ctl" ]

  stage='space'
  space_failure='reason=unavailable'
  run_capture "$query_timeout" sudo -u postgres psql -X -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c "select pg_size_bytes(current_setting('wal_segment_size'))"
  local wal_segment_size
  wal_segment_size="$(read_control)"
  run_capture "$query_timeout" sudo -u postgres pgbackrest \
    --stanza=markdoc --repo=1 --output=json --log-level-console=off info
  local restore_budget
  restore_budget="$(python3 -c '
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    result = json.load(stream)
if not isinstance(result, list) or len(result) != 1 or result[0].get("name") != "markdoc":
    raise SystemExit(1)
backups = [
    backup for backup in result[0].get("backup", [])
    if backup.get("database", {}).get("repo-key") == 1
]
if not backups or any(type(b.get("timestamp", {}).get("stop")) is not int for b in backups):
    raise SystemExit(1)
latest = max(b["timestamp"]["stop"] for b in backups)
backups = [b for b in backups if b["timestamp"]["stop"] == latest]
if len(backups) != 1:
    raise SystemExit(1)
backup = backups[0]
label = backup.get("label")
size = backup.get("info", {}).get("size")
start = backup.get("archive", {}).get("start")
if (
    not isinstance(label, str)
    or re.fullmatch(r"[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?", label) is None
    or type(size) is not int or size <= 0
    or backup.get("error", False) is not False
    or not isinstance(start, str) or re.fullmatch(r"[0-9A-F]{24}", start) is None
    or re.fullmatch(r"[0-9]{1,10}", sys.argv[3]) is None
):
    raise SystemExit(1)
segment_size = int(sys.argv[3])
if not 1048576 <= segment_size <= 1073741824 or segment_size & (segment_size - 1):
    raise SystemExit(1)
segments_per_id = 4294967296 // segment_size
end = sys.argv[2]
def segment_number(wal):
    low = int(wal[16:], 16)
    if low >= segments_per_id:
        raise SystemExit(1)
    return int(wal[8:16], 16) * segments_per_id + low
if start[:8] != end[:8] or segment_number(start) > segment_number(end):
    raise SystemExit(1)
# Budget the full archive span even if PostgreSQL recycles segments during replay.
wal_bytes = (segment_number(end) - segment_number(start) + 3) * segment_size
required = size + wal_bytes + int(sys.argv[4])
if required >= 10**18:
    raise SystemExit(1)
print(f"{label}|{required}")
' "$control_file" "$wal_object" "$wal_segment_size" "$production_reserve")"
  local backup_set
  local required_bytes
  IFS='|' read -r backup_set required_bytes <<<"$restore_budget"
  check_space "$required_bytes"
  space_failure=''
  space_guard_active=true

  stage='restore'
  run_silent "$restore_timeout" sudo -u postgres pgbackrest \
    --stanza=markdoc \
    --repo=1 \
    --set="$backup_set" \
    --pg1-path="$data_dir" \
    --archive-mode=off \
    --type=name \
    --target="$restore_point" \
    --target-action=promote \
    restore
  printf 'markdoc-release-wal-restore:%s:true\n' "$operation_id"

  run_capture "$query_timeout" python3 -c \
    'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
  local scratch_port
  scratch_port="$(read_control)"
  if ! [[ "$scratch_port" =~ ^[1-9][0-9]{3,4}$ ]] ||
    [ "$scratch_port" -lt 1024 ] || [ "$scratch_port" -gt 65535 ]; then
    return 1
  fi

  cat >"$data_dir/postgresql.conf" <<CONF
data_directory = '$data_dir'
hba_file = '$data_dir/pg_hba.conf'
ident_file = '$data_dir/pg_ident.conf'
port = $scratch_port
listen_addresses = ''
unix_socket_directories = '$socket_dir'
ssl = off
archive_mode = off
max_connections = 10
hot_standby = off
logging_collector = off
log_min_messages = warning
log_min_error_statement = panic
CONF
  printf 'local all all peer\n' >"$data_dir/pg_hba.conf"
  : >"$data_dir/pg_ident.conf"
  chmod 0600 "$data_dir/postgresql.conf" "$data_dir/pg_hba.conf" "$data_dir/pg_ident.conf"
  chown postgres:postgres \
    "$data_dir/postgresql.conf" "$data_dir/pg_hba.conf" "$data_dir/pg_ident.conf"

  stage='start'
  run_silent "$start_timeout" sudo -u postgres "$pg_bin/pg_ctl" \
    -D "$data_dir" -l "$server_log" -w -t "$start_timeout" start
  owned_postgres_pid="$(sed -n '1p' "$data_dir/postmaster.pid" 2>/dev/null || true)"
  if ! [[ "$owned_postgres_pid" =~ ^[1-9][0-9]*$ ]]; then
    return 1
  fi
  stage='sql-ready'
  local recovery_deadline=$((SECONDS + recovery_timeout))
  while true; do
    local recovery_remaining=$((recovery_deadline - SECONDS))
    if [ "$recovery_remaining" -le 0 ]; then
      return 1
    fi
    if [ "$recovery_remaining" -gt "$query_timeout" ]; then
      recovery_remaining="$query_timeout"
    fi
    if run_capture "$recovery_remaining" sudo -u postgres psql -X \
      -h "$socket_dir" -p "$scratch_port" -d postgres \
      -v ON_ERROR_STOP=1 -Atq -c \
      "select case when not pg_is_in_recovery() and current_setting('archive_mode') = 'off' and current_setting('listen_addresses') = '' then 'ready' else 'not-ready' end"; then
      if [ "$(read_control)" = ready ]; then
        break
      fi
      [ "$space_failed" != true ] || return 1
    fi
    if [ -z "$test_root" ] &&
      [[ "$owned_postgres_pid" =~ ^[1-9][0-9]*$ ]] &&
      ! kill -0 "$owned_postgres_pid" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  printf 'markdoc-release-wal-sql-ready:%s:true\n' "$operation_id"

  stage='replay'
  run_capture "$query_timeout" sudo -u postgres psql -X \
    -h "$socket_dir" -p "$scratch_port" -d postgres \
    -v ON_ERROR_STOP=1 -Atq -c \
    "select upper(coalesce(pg_last_wal_replay_lsn()::text, '')) || '|' || case when pg_last_wal_replay_lsn() >= '${endpoint}'::pg_lsn then '1' else '0' end"
  local replay_result
  local replay_reached
  replay_result="$(read_control)"
  IFS='|' read -r replay_lsn replay_reached <<<"$replay_result"
  if ! [[ "$replay_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] || [ "$replay_reached" != 1 ]; then
    return 1
  fi
  printf 'markdoc-release-wal-replay:%s:%s:%s\n' \
    "$operation_id" "$endpoint" "$replay_lsn"

  stage='cleanup'
  cleanup_owned
  scratch_root=''
  data_dir=''
  socket_dir=''
  owned_postgres_pid=''
  exec 2>&$gate_saved_stderr
  exec {gate_saved_stderr}>&-
  printf 'markdoc-release-wal-cleanup:%s:true\n' "$operation_id"
  printf 'markdoc-release-wal-ready:%s:%s:%s:%s:%s\n' \
    "$operation_id" "$endpoint" "$wal_object" "$archive_object" "$replay_lsn"
  MARKDOC_RELEASE_WAL_GATE_OPERATION="$operation_id"
  finalized=true
  trap - EXIT INT TERM
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -eq 1 ]; then
    run_markdoc_release_wal_gate "$1"
  elif [ "$#" -ne 5 ]; then
    echo 'usage: release-wal-gate.sh <operation-id>' >&2
    exit 2
  fi
fi
