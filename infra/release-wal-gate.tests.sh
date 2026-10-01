#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gate="${MARKDOC_RELEASE_WAL_GATE_TEST_SOURCE:-$root/infra/release-wal-gate.sh}"
operation='12345678-1234-4abc-8def-1234567890ab'
wal='000000010000000300000025'
archive_object="${wal}-0123456789abcdef0123456789abcdef01234567.gz"
passed=0
suite_root="$(mktemp -d)"
trap 'rm -rf -- "$suite_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local expected="$2"
  local message="$3"
  grep -Fqx "$expected" "$file" || fail "$message"
  passed=$((passed + 1))
}

assert_no_scratch() {
  local case_dir="$1"
  if find "$case_dir/root/var/lib/postgresql" -maxdepth 1 \
    -name "markdoc-release-wal.${operation}.*" -print -quit | grep -q .; then
    fail 'owned scratch residue remained'
  fi
  test -f "$case_dir/root/var/lib/postgresql/markdoc-restore-check.protected/sentinel" ||
    fail 'protected restore-check evidence was touched'
  passed=$((passed + 2))
}

make_case() {
  local case_dir
  case_dir="$(mktemp -d "$suite_root/case.XXXXXX")"
  mkdir -p \
    "$case_dir/bin" \
    "$case_dir/root/run/lock" \
    "$case_dir/root/var/lib/postgresql" \
    "$case_dir/root/usr/lib/postgresql/16/bin" \
    "$case_dir/primary/pg_wal/archive_status" \
    "$case_dir/root/var/lib/postgresql/markdoc-restore-check.protected"
  : >"$case_dir/root/var/lib/postgresql/markdoc-restore-check.protected/sentinel"
  : >"$case_dir/events"

  cat >"$case_dir/bin/sudo" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = -u ]; then
  shift 2
fi
exec "$@"
STUB

  cat >"$case_dir/bin/df" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'Avail\n'
if [ "${TEST_SQL_SPACE_DROP:-}" != '' ] && [ -f "$TEST_EVENTS.sql-ready-count" ]; then
  if [ "$TEST_SQL_SPACE_DROP" = persistent ] || [ ! -f "$TEST_EVENTS.space-breached" ]; then
    if [ ! -f "$TEST_EVENTS.space-breached" ]; then
      cp "$TEST_EVENTS.sql-ready-count" "$TEST_EVENTS.space-breached"
    fi
    printf '1024\n'
    exit 0
  fi
fi
if [ "${TEST_SPACE_DROP:-0}" = 1 ] && grep -q '^restore$' "$TEST_EVENTS"; then
  printf '1024\n'
else
  printf '%s\n' "${TEST_FREE_BYTES:-8589934592}"
fi
STUB

  cat >"$case_dir/bin/flock" <<'STUB'
#!/usr/bin/env bash
if [ "${TEST_LOCK_FAIL:-0}" = 1 ]; then
  exit 1
fi
exit 0
STUB

  cat >"$case_dir/bin/chown" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat >"$case_dir/bin/install" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
target="${!#}"
: >"$target"
STUB

  cat >"$case_dir/bin/psql" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
query="${!#}"
case "$query" in
  'show data_directory')
    printf '%s\n' "$TEST_PRIMARY_DATA"
    ;;
  *pg_create_restore_point*)
    [[ "$query" == *"markdoc_release_1234567812344abc8def1234567890ab"* ]]
    printf '%s|%s\n' "${TEST_CAPTURE:-3/25002220}" "${TEST_WAL:-000000010000000300000025}"
    printf 'capture\n' >>"$TEST_EVENTS"
    ;;
  *pg_switch_wal*)
    printf 'switch\n' >>"$TEST_EVENTS"
    if [ "${TEST_ARCHIVE:-1}" = 1 ]; then
      : >"$TEST_PRIMARY_DATA/pg_wal/archive_status/${TEST_WAL:-000000010000000300000025}.done"
    fi
    printf '3/26000000\n'
    ;;
  *server_version_num*)
    printf '16\n'
    ;;
  *wal_segment_size*)
    printf '16777216\n'
    ;;
  *'not pg_is_in_recovery()'*)
    ready_count_file="$TEST_EVENTS.sql-ready-count"
    ready_count=0
    if [ -f "$ready_count_file" ]; then
      ready_count="$(cat "$ready_count_file")"
    fi
    ready_count=$((ready_count + 1))
    printf '%s\n' "$ready_count" >"$ready_count_file"
    if [ "$ready_count" -lt "${TEST_SQL_READY_AFTER:-1}" ]; then
      exit 2
    fi
    printf '%s\n' "${TEST_SQL_READY:-ready}"
    printf 'sql-ready\n' >>"$TEST_EVENTS"
    ;;
  *pg_last_wal_replay_lsn*)
    printf '%s|%s\n' "${TEST_REPLAY:-3/25003333}" "${TEST_REACHED:-1}"
    printf 'replay\n' >>"$TEST_EVENTS"
    ;;
  *)
    exit 71
    ;;
esac
STUB

  cat >"$case_dir/bin/pgbackrest" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
command=''
lock_timeout=''
restore_type=''
restore_target=''
restore_set=''
for argument in "$@"; do
  case "$argument" in
    info|repo-ls|restore) command="$argument" ;;
    --lock-timeout=*) lock_timeout="${argument#--lock-timeout=}" ;;
    --pg1-path=*) data_dir="${argument#--pg1-path=}" ;;
    --type=*) restore_type="${argument#--type=}" ;;
    --target=*) restore_target="${argument#--target=}" ;;
    --set=*) restore_set="${argument#--set=}" ;;
  esac
done
case "$command" in
  info)
    printf 'archive-info\n' >>"$TEST_EVENTS"
    if [ "${TEST_ARCHIVE_INFO_FAIL:-0}" = 1 ]; then
      exit 74
    fi
    printf '%s\n' \
      "${TEST_BACKUP_INFO:-}"
    if [ -z "${TEST_BACKUP_INFO:-}" ]; then
      printf '%s\n' '[{"archive":[{"database":{"id":1,"repo-key":1},"id":"16-1"}],"backup":[{"label":"20260930-023424F","database":{"repo-key":1},"timestamp":{"stop":1790735673},"info":{"size":38587596},"archive":{"start":"000000010000000300000024"}}],"name":"markdoc"}]'
    fi
    ;;
  repo-ls)
    printf 'archive-object\n' >>"$TEST_EVENTS"
    if [ "${TEST_REPO_ARCHIVE:-1}" = 1 ]; then
      printf '{"%s":{"type":"file","size":16777216,"time":1788782400}}\n' \
        "${TEST_REPO_OBJECT:-${TEST_WAL:-000000010000000300000025}-0123456789abcdef0123456789abcdef01234567.gz}"
    else
      printf '{".":{"type":"path"}}\n'
    fi
    ;;
  restore)
    printf 'restore\n' >>"$TEST_EVENTS"
    test -z "$lock_timeout"
    test "$restore_type" = name
    test "$restore_target" = markdoc_release_1234567812344abc8def1234567890ab
    printf '%s\n' "$restore_set" >"$TEST_EVENTS.backup-set"
    if [ "${TEST_RESTORE_SLEEP:-0}" = 1 ]; then
      sleep 30
    fi
    if [ "${TEST_RESTORE_FAIL:-0}" = 1 ]; then
      exit 72
    fi
    test -n "${data_dir:-}"
    : >"$data_dir/postgresql.auto.conf"
    : >"$data_dir/PG_VERSION"
    ;;
  *)
    exit 75
    ;;
esac
STUB

  cat >"$case_dir/root/usr/lib/postgresql/16/bin/pg_ctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
data_dir=''
action=''
server_log=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -D) data_dir="$2"; shift 2 ;;
    -l) server_log="$2"; shift 2 ;;
    start|stop) action="$1"; shift ;;
    *) shift ;;
  esac
done
test -n "$data_dir"
printf 'pg_ctl-%s\n' "$action" >>"$TEST_EVENTS"
if [ "$action" = start ]; then
  printf '%s\n' "$server_log" >"$TEST_EVENTS.server-log"
  if [ "${TEST_SERVER_SIGNAL:-0}" = 1 ]; then
    printf '2026-10-01 01:01:01 UTC [42] LOG: startup process (PID 123) was terminated by signal 9: Killed private-token\n' >>"$server_log"
    printf '2026-10-01 01:01:01 UTC [42] LOG: startup process (PID 123) was terminated by signal 15: Terminated private-token\n' >>"$server_log"
    printf '2026-10-01 01:01:01 UTC [42] LOG: aborting startup due to startup process failure\n' >>"$server_log"
    printf 'LOG: arbitrary private-token private-document-content\n' >>"$server_log"
    printf 'LOG: startup process (PID 123) was terminated by signal 999: private-token\n' >>"$server_log"
  fi
  if [ "${TEST_SERVER_ERROR:-0}" = 1 ]; then
    for _ in $(seq 1 400); do
      printf 'DETAIL: private-token private-document-content private-password\n' >>"$server_log"
    done
    for _ in $(seq 1 15); do
      printf '2026-10-01 01:01:00 UTC [42] FATAL: recovery ended before configured recovery target was reached\n' >>"$server_log"
    done
    printf '2026-10-01 01:01:01 UTC [42] PANIC: could not write to file "token=private-token database=user-content": No space left on device\n' >>"$server_log"
    printf 'DETAIL: password=private-password token=private-token user-content\n' >>"$server_log"
    printf 'STATEMENT: select private-document-content\n' >>"$server_log"
    printf 'FATAL: private-password private-token private-document-content\n' >>"$server_log"
    printf 'markdoc-release-wal-ready:forged-secret-evidence\n' >>"$server_log"
    printf 'password=private-command-secret\n' >&2
  fi
  if [ "${TEST_START_FAIL:-0}" = 1 ]; then
    exit 73
  fi
  printf '999999\n' >"$data_dir/postmaster.pid"
else
  rm -f "$data_dir/postmaster.pid"
fi
STUB

  chmod +x "$case_dir/bin/"* "$case_dir/root/usr/lib/postgresql/16/bin/pg_ctl"
  printf '%s\n' "$case_dir"
}

run_gate() {
  local case_dir="$1"
  shift
  env \
    PATH="$case_dir/bin:$PATH" \
    MARKDOC_RELEASE_WAL_GATE_TEST_ROOT="$case_dir/root" \
    MARKDOC_RELEASE_WAL_GATE_ARCHIVE_TIMEOUT=3 \
    MARKDOC_RELEASE_WAL_GATE_RECOVERY_TIMEOUT=2 \
    TEST_PRIMARY_DATA="$case_dir/primary" \
    TEST_EVENTS="$case_dir/events" \
    "$@" \
    bash "$gate" "$operation" >"$case_dir/output" 2>"$case_dir/error"
}

test_sql_reserve() {
  local mode
  local case_dir
  local modes="${1:-transient persistent}"
  for mode in $modes; do
    case_dir="$(make_case)"
    if run_gate "$case_dir" TEST_SQL_SPACE_DROP="$mode" \
      TEST_SQL_READY_AFTER=3 MARKDOC_RELEASE_WAL_GATE_RECOVERY_TIMEOUT=8; then
      fail "$mode SQL reserve breach was accepted"
    fi
    assert_contains "$case_dir/output" \
      "markdoc-release-wal-failed:$operation:space:cleanup=true" \
      "$mode SQL reserve breach did not stop owned work"
    test -f "$case_dir/events.space-breached" || fail 'SQL reserve case did not reach a breach'
    test "$(cat "$case_dir/events.sql-ready-count")" = \
      "$(cat "$case_dir/events.space-breached")" ||
      fail "$mode reserve breach launched another SQL poll"
    grep -q '^replay$' "$case_dir/events" && fail 'replay ran after a SQL reserve breach'
    passed=$((passed + 2))
    assert_no_scratch "$case_dir"
  done
}

test_server_signal() {
  local case_dir
  case_dir="$(make_case)"
  if run_gate "$case_dir" TEST_SQL_READY=not-ready TEST_SERVER_SIGNAL=1; then
    fail 'signal diagnostic fixture returned success'
  fi
  assert_contains "$case_dir/output" \
    "markdoc-release-wal-log:$operation:LOG:killed-by-signal-9" \
    'scratch startup signal-9 kill was not diagnosed'
  assert_contains "$case_dir/output" \
    "markdoc-release-wal-log:$operation:LOG:killed-by-signal-15" \
    'scratch startup signal-15 kill was not diagnosed'
  assert_contains "$case_dir/output" \
    "markdoc-release-wal-log:$operation:LOG:startup-aborted" \
    'scratch startup abort was not diagnosed'
  test "$(grep -c '^markdoc-release-wal-log:' "$case_dir/output")" = 3 ||
    fail 'unknown or invalid signal LOG text was forwarded'
  grep -Eq 'private-|signal-999' "$case_dir/output" &&
    fail 'signal diagnostics exposed unvalidated log content'
  passed=$((passed + 2))
  assert_no_scratch "$case_dir"
}

case "${MARKDOC_RELEASE_WAL_GATE_REVIEW_CASE:-all}" in
  reserve) test_sql_reserve; printf 'SQL reserve regression passed\n'; exit 0 ;;
  reserve-persistent) test_sql_reserve persistent; printf 'persistent SQL reserve regression passed\n'; exit 0 ;;
  signals) test_server_signal; printf 'signal diagnostic regression passed\n'; exit 0 ;;
  all) test_sql_reserve; test_server_signal ;;
  *) fail 'unknown focused review case' ;;
esac

success_dir="$(make_case)"
run_gate "$success_dir"
expected_success="$success_dir/expected"
cat >"$expected_success" <<EOF
markdoc-release-wal-operation:$operation
markdoc-release-wal-capture:$operation:3/25002220:$wal
markdoc-release-wal-switch:$operation:true
markdoc-release-wal-archive:$operation:$wal:$archive_object
markdoc-release-wal-restore:$operation:true
markdoc-release-wal-sql-ready:$operation:true
markdoc-release-wal-replay:$operation:3/25002220:3/25003333
markdoc-release-wal-cleanup:$operation:true
markdoc-release-wal-ready:$operation:3/25002220:$wal:$archive_object:3/25003333
EOF
cmp -s "$expected_success" "$success_dir/output" || fail 'success evidence was not exact and ordered'
passed=$((passed + 1))
test "$(tr '\n' ',' <"$success_dir/events")" = \
  'capture,switch,archive-info,archive-object,archive-info,restore,pg_ctl-start,sql-ready,replay,pg_ctl-stop,' ||
  fail 'recovery operations did not run in the required order'
passed=$((passed + 1))
assert_no_scratch "$success_dir"
assert_contains "$success_dir/events.backup-set" '20260930-023424F' \
  'restore did not pin the same backup that was measured for the disk budget'

space_dir="$(make_case)"
if run_gate "$space_dir" TEST_FREE_BYTES=436326400; then
  fail 'near-full production filesystem was accepted for scratch restore'
fi
assert_contains "$space_dir/output" \
  "markdoc-release-wal-failed:$operation:space:cleanup=true" \
  'insufficient scratch space did not fail closed'
grep -q '^restore$' "$space_dir/events" && fail 'low-space gate started a restore'
assert_contains "$space_dir/output" \
  "markdoc-release-wal-space:$operation:available=436326400:required=2253180108:reserve=2147483648" \
  'low-space failure did not preserve its exact budget and production reserve'
assert_no_scratch "$space_dir"

invalid_space_dir="$(make_case)"
if run_gate "$invalid_space_dir" TEST_FREE_BYTES=unknown; then
  fail 'invalid filesystem free-space result was accepted'
fi
assert_contains "$invalid_space_dir/output" \
  "markdoc-release-wal-failed:$operation:space:cleanup=true" \
  'unknown free space did not fail closed'
grep -q '^restore$' "$invalid_space_dir/events" && fail 'unknown-space gate started a restore'
assert_no_scratch "$invalid_space_dir"

backup_metadata='[{"archive":[{"database":{"id":1,"repo-key":1},"id":"16-1"}],"backup":[{"label":"20260930-023424F","database":{"repo-key":1},"timestamp":{"stop":1790735673},"info":{"size":38587596},"archive":{"start":"0000000100000002000000FE"}}],"name":"markdoc"}]'
wal_budget_dir="$(make_case)"
if run_gate "$wal_budget_dir" TEST_FREE_BYTES=2684354560 TEST_BACKUP_INFO="$backup_metadata"; then
  fail 'disk budget ignored the WAL span across a log-ID boundary'
fi
assert_contains "$wal_budget_dir/output" \
  "markdoc-release-wal-space:$operation:available=2684354560:required=2890714316:reserve=2147483648" \
  'complete WAL span was not included in the measured disk budget'
grep -q '^restore$' "$wal_budget_dir/events" && fail 'WAL-budget refusal started restore'
assert_no_scratch "$wal_budget_dir"

missing_backup_dir="$(make_case)"
if run_gate "$missing_backup_dir" \
  TEST_BACKUP_INFO='[{"archive":[{"database":{"repo-key":1},"id":"16-1"}],"backup":[],"name":"markdoc"}]'; then
  fail 'missing backup metadata was accepted'
fi
assert_contains "$missing_backup_dir/output" \
  "markdoc-release-wal-failed:$operation:space:cleanup=true" \
  'missing backup did not fail at disk budgeting'
assert_contains "$missing_backup_dir/output" \
  "markdoc-release-wal-space:$operation:reason=unavailable" \
  'unverifiable backup budget did not state its reason'
assert_no_scratch "$missing_backup_dir"

timeline_dir="$(make_case)"
if run_gate "$timeline_dir" \
  TEST_BACKUP_INFO="${backup_metadata/0000000100000002000000FE/0000000200000002000000FE}"; then
  fail 'an unbudgeted timeline span was accepted'
fi
assert_contains "$timeline_dir/output" \
  "markdoc-release-wal-failed:$operation:space:cleanup=true" \
  'unsupported timeline did not fail closed before restore'
grep -q '^restore$' "$timeline_dir/events" && fail 'timeline-budget refusal started restore'
assert_no_scratch "$timeline_dir"

space_drop_dir="$(make_case)"
if run_gate "$space_drop_dir" TEST_SPACE_DROP=1 TEST_RESTORE_SLEEP=1; then
  fail 'scratch restore continued after reaching the production reserve'
fi
assert_contains "$space_drop_dir/output" \
  "markdoc-release-wal-failed:$operation:space:cleanup=true" \
  'runtime disk guard did not stop and clean owned restore work'
grep -q '^pg_ctl-start$' "$space_drop_dir/events" && fail 'runtime low-space gate started PostgreSQL'
assert_no_scratch "$space_drop_dir"

archive_dir="$(make_case)"
if run_gate "$archive_dir" TEST_ARCHIVE=0; then
  fail 'missing archive marker was accepted'
fi
assert_contains "$archive_dir/output" \
  "markdoc-release-wal-failed:$operation:archive:cleanup=true" \
  'archive timeout did not fail closed with cleanup evidence'
grep -q '^restore$' "$archive_dir/events" && fail 'restore started before exact archival'
passed=$((passed + 1))
assert_no_scratch "$archive_dir"

repo_archive_dir="$(make_case)"
if run_gate "$repo_archive_dir" TEST_REPO_ARCHIVE=0; then
  fail 'local archive acknowledgement without a repository object was accepted'
fi
assert_contains "$repo_archive_dir/output" \
  "markdoc-release-wal-failed:$operation:archive:cleanup=true" \
  'missing repository object did not fail closed with cleanup evidence'
grep -q '^restore$' "$repo_archive_dir/events" &&
  fail 'restore started before exact repository object evidence'
passed=$((passed + 1))
assert_no_scratch "$repo_archive_dir"

wrong_repo_object_dir="$(make_case)"
if run_gate "$wrong_repo_object_dir" \
  TEST_REPO_OBJECT="${wal}-0123456789abcdef0123456789abcdef0123456.gz"; then
  fail 'malformed repository object identity was accepted'
fi
assert_contains "$wrong_repo_object_dir/output" \
  "markdoc-release-wal-failed:$operation:archive:cleanup=true" \
  'malformed repository object did not fail at archive proof'
assert_no_scratch "$wrong_repo_object_dir"

archive_info_dir="$(make_case)"
if run_gate "$archive_info_dir" TEST_ARCHIVE_INFO_FAIL=1; then
  fail 'repository archive metadata failure was accepted'
fi
assert_contains "$archive_info_dir/output" \
  "markdoc-release-wal-failed:$operation:archive:cleanup=true" \
  'repository archive metadata failure did not fail closed'
assert_no_scratch "$archive_info_dir"

malformed_dir="$(make_case)"
if run_gate "$malformed_dir" TEST_CAPTURE=malformed; then
  fail 'malformed endpoint was accepted'
fi
assert_contains "$malformed_dir/output" \
  "markdoc-release-wal-failed:$operation:capture:cleanup=true" \
  'malformed endpoint did not fail at capture'
assert_no_scratch "$malformed_dir"

restore_dir="$(make_case)"
if run_gate "$restore_dir" TEST_RESTORE_FAIL=1; then
  fail 'pgBackRest failure was accepted'
fi
assert_contains "$restore_dir/output" \
  "markdoc-release-wal-failed:$operation:restore:cleanup=true" \
  'restore failure did not report owned cleanup'
assert_no_scratch "$restore_dir"

start_dir="$(make_case)"
if run_gate "$start_dir" TEST_START_FAIL=1; then
  fail 'scratch startup failure was accepted'
fi
assert_contains "$start_dir/output" \
  "markdoc-release-wal-failed:$operation:start:cleanup=true" \
  'startup failure did not report owned cleanup'
assert_no_scratch "$start_dir"

sql_retry_dir="$(make_case)"
run_gate "$sql_retry_dir" TEST_SQL_READY_AFTER=2 MARKDOC_RELEASE_WAL_GATE_RECOVERY_TIMEOUT=5
assert_contains "$sql_retry_dir/output" \
  "markdoc-release-wal-sql-ready:$operation:true" \
  'temporary SQL rejection was not retried'
test "$(cat "$sql_retry_dir/events.sql-ready-count")" = 2 ||
  fail 'SQL readiness did not retry exactly once'
passed=$((passed + 1))
assert_no_scratch "$sql_retry_dir"

sql_dir="$(make_case)"
if run_gate "$sql_dir" TEST_SQL_READY=not-ready; then
  fail 'non-ready scratch SQL was accepted'
fi
assert_contains "$sql_dir/output" \
  "markdoc-release-wal-failed:$operation:sql-ready:cleanup=true" \
  'SQL readiness failure did not report owned cleanup'
assert_no_scratch "$sql_dir"

server_log_dir="$(make_case)"
if run_gate "$server_log_dir" TEST_SQL_READY=not-ready TEST_SERVER_ERROR=1; then
  fail 'server diagnostic case returned success'
fi
assert_contains "$server_log_dir/output" \
  "markdoc-release-wal-log:$operation:PANIC:disk-full" \
  'scratch server disk-full error was lost during SQL polls or cleanup'
assert_contains "$server_log_dir/output" \
  "markdoc-release-wal-log:$operation:FATAL:recovery-target-unreached" \
  'scratch recovery target error was not retained'
assert_contains "$server_log_dir/output" \
  "markdoc-release-wal-log:$operation:FATAL:message-withheld" \
  'unrecognized server error did not explicitly withhold its content'
test "$(grep -c '^markdoc-release-wal-log:' "$server_log_dir/output")" = 10 ||
  fail 'scratch diagnostic tail was not bounded to ten entries'
if grep -Eq 'private-|user-content|forged-secret|password=|token=' \
  "$server_log_dir/output" "$server_log_dir/error"; then
  fail 'server or command logs leaked secret/user-controlled text'
fi
test "$(cat "$server_log_dir/events.server-log")" != \
  "$(dirname "$(cat "$server_log_dir/events.server-log")")/command.log" ||
  fail 'server and per-command stderr share one log file'
test "$(wc -c <"$server_log_dir/output")" -lt 4096 ||
  fail 'failure output exceeded the Azure guest-output tail limit'
passed=$((passed + 3))
assert_no_scratch "$server_log_dir"

replay_dir="$(make_case)"
if run_gate "$replay_dir" TEST_REPLAY=3/24000000 TEST_REACHED=0; then
  fail 'replay behind the endpoint was accepted'
fi
assert_contains "$replay_dir/output" \
  "markdoc-release-wal-failed:$operation:replay:cleanup=true" \
  'replay-behind failure did not report owned cleanup'
assert_no_scratch "$replay_dir"

lock_dir="$(make_case)"
if run_gate "$lock_dir" TEST_LOCK_FAIL=1; then
  fail 'lock contention was accepted'
fi
assert_contains "$lock_dir/output" \
  "markdoc-release-wal-failed:$operation:lock:cleanup=true" \
  'lock contention did not fail before work'
test ! -s "$lock_dir/events" || fail 'lock contention reached a database phase'
passed=$((passed + 1))
assert_no_scratch "$lock_dir"

signal_dir="$(make_case)"
env \
  PATH="$signal_dir/bin:$PATH" \
  MARKDOC_RELEASE_WAL_GATE_TEST_ROOT="$signal_dir/root" \
  MARKDOC_RELEASE_WAL_GATE_ARCHIVE_TIMEOUT=3 \
  TEST_PRIMARY_DATA="$signal_dir/primary" \
  TEST_EVENTS="$signal_dir/events" \
  TEST_RESTORE_SLEEP=1 \
  bash "$gate" "$operation" >"$signal_dir/output" 2>"$signal_dir/error" &
signal_pid=$!
for _ in $(seq 1 200); do
  grep -q '^restore$' "$signal_dir/events" && break
  sleep 0.05
done
if ! grep -q '^restore$' "$signal_dir/events"; then
  cat "$signal_dir/output" >&2
  fail 'signal case did not reach restore'
fi
kill -TERM "$signal_pid"
if wait "$signal_pid"; then
  fail 'terminated gate returned success'
fi
assert_contains "$signal_dir/output" \
  "markdoc-release-wal-failed:$operation:restore:cleanup=true" \
  'signal path did not clean owned restore state'
assert_no_scratch "$signal_dir"

deploy_source="$root/infra/deploy-vm-image.sh"
receipt_line="$(grep -n 'MARKDOC_RELEASE_WAL_GATE_OPERATION' "$deploy_source" | head -n 1 | cut -d: -f1)"
rollback_line="$(grep -n '^rollback_dir=' "$deploy_source" | cut -d: -f1)"
metadata_line="$(grep -n '^aad_token=' "$deploy_source" | cut -d: -f1)"
if [ "$receipt_line" -ge "$rollback_line" ] || [ "$receipt_line" -ge "$metadata_line" ]; then
  fail 'deployment can mutate or authenticate before checking recovery evidence'
fi
passed=$((passed + 1))

rm -rf \
  "$success_dir" "$archive_dir" "$repo_archive_dir" "$wrong_repo_object_dir" \
  "$archive_info_dir" "$malformed_dir" "$restore_dir" "$start_dir" "$sql_retry_dir" "$sql_dir" \
  "$replay_dir" "$lock_dir" "$signal_dir"
rm -rf "$space_dir" "$invalid_space_dir" "$space_drop_dir" "$server_log_dir"
rm -rf "$wal_budget_dir" "$missing_backup_dir" "$timeline_dir"

printf 'release WAL gate tests passed: %s assertions\n' "$passed"
