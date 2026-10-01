#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_file="${MARKDOC_DEPLOY_IMAGE_TEST_SOURCE:-$root/infra/deploy-vm-image.sh}"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
passed=0
operation_id='12345678-1234-4abc-8def-1234567890ab'
registry='registry.example.test'
current="sha256:$(printf 'a%.0s' {1..64})"
previous="sha256:$(printf 'b%.0s' {1..64})"
old="sha256:$(printf 'c%.0s' {1..64})"
used="sha256:$(printf 'd%.0s' {1..64})"
other="sha256:$(printf 'e%.0s' {1..64})"
protected='sha256:21546bc69066d93d3c7844af139e7925b3b838c4c63bb6fd87ae840abfb7c313'

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_line() {
  grep -Fxq "$2" "$1" || fail "$3"
  passed=$((passed + 1))
}

for helper in require_image_space retain_release_images capture_previous_image; do
  sed -n "/^${helper}() {/,/^}/p" "$source_file" >"$test_dir/$helper.sh"
  test -s "$test_dir/$helper.sh" || fail "missing $helper behavior"
  source "$test_dir/$helper.sh"
done

df() {
  printf 'Avail\n%s\n' "${TEST_FREE_BYTES:-8589934592}"
}
docker() {
  printf '%s\n' "$*" >>"$test_dir/events"
  case "$1 $2" in
    'images --no-trunc')
      printf '%s\n' "$current" "$previous" "$old" "$used" "$other" "$protected"
      ;;
    'image inspect')
      if [[ "$*" == *'{{.Id}}'* ]]; then
        [ -n "${!#}" ] || return 1
        [ "${TEST_PREVIOUS_INSPECT_FAIL:-0}" = 0 ] || return 1
        printf '%s\n' "${TEST_PREVIOUS_ID:-$previous}"
        return 0
      fi
      case "${!#}" in
        "$other") printf 'another.example.test/unrelated:latest\n' ;;
        *) printf '%s/markdoc@%s\n' "$registry" "${!#}" ;;
      esac
      ;;
    'ps -a')
      if [[ "$*" == *'name=^/markdoc-app$'* ]]; then
        [ "${TEST_PREVIOUS_PS_FAIL:-0}" = 0 ] || return 1
        if [ "${TEST_PREVIOUS_EMPTY:-0}" != 1 ]; then
          printf 'stopped-image\n'
        fi
      elif [[ "$*" == *"ancestor=$used"* ]]; then
        printf 'another-container\n'
      fi
      ;;
    'ps --filter')
      [ "${TEST_PREVIOUS_PS_FAIL:-0}" = 0 ] || return 1
      ;;
    rmi*)
      test "${TEST_RMI_FAIL:-0}" = 0
      ;;
    *) fail 'unexpected Docker operation' ;;
  esac
}
export -f df docker fail
export test_dir current previous old used other protected registry
mkdir "$test_dir/bin"
for command in df docker; do
  printf '#!/usr/bin/env bash\n%s "$@"\n' "$command" >"$test_dir/bin/$command"
  chmod +x "$test_dir/bin/$command"
done
export PATH="$test_dir/bin:$PATH"

: >"$test_dir/events"
capture_previous_image
test "$previous_id" = "$previous" || fail 'stopped container image was not retained for rollback'
passed=$((passed + 1))
for unavailable in TEST_PREVIOUS_EMPTY=1 TEST_PREVIOUS_PS_FAIL=1 \
  TEST_PREVIOUS_INSPECT_FAIL=1 TEST_PREVIOUS_ID=malformed; do
  if ! env "$unavailable" bash -c '
    set -euo pipefail
    source "$test_dir/capture_previous_image.sh"
    capture_previous_image
    test -z "$previous_id"
    printf "release-can-continue\n"
  ' >"$test_dir/previous-result"; then
    fail 'unavailable previous image blocked a repair release'
  fi
  assert_line "$test_dir/previous-result" 'release-can-continue' \
    'previous-image failure did not preserve release execution'
done

test_pre_pull_lookup_allows_repair() {
  sed -n '/^require_image_space pull /,/^rollback_dir=/p' "$source_file" |
    sed '$d' >"$test_dir/pre-pull-lookup.sh"
  test -s "$test_dir/pre-pull-lookup.sh" || fail 'pre-pull lookup call site is missing'
  for scenario in TEST_PREVIOUS_EMPTY=0 TEST_PREVIOUS_EMPTY=1 TEST_PREVIOUS_PS_FAIL=1; do
    if ! env "$scenario" bash -c '
      set -euo pipefail
      source "$test_dir/require_image_space.sh"
      source "$test_dir/capture_previous_image.sh"
      source "$test_dir/pre-pull-lookup.sh"
      printf "release-can-continue\n"
    ' >"$test_dir/pre-pull-result"; then
      fail "test_pre_pull_lookup_allows_repair: $scenario blocked a repair release"
    fi
    assert_line "$test_dir/pre-pull-result" 'release-can-continue' \
      'pre-pull lookup did not preserve release execution'
  done
}
test_pre_pull_lookup_allows_repair

: >"$test_dir/events"
if TEST_FREE_BYTES=436326400 require_image_space pull 6442450944 >"$test_dir/space"; then
  fail 'low-space image pull was accepted'
fi
assert_line "$test_dir/space" \
  "markdoc-vm-image-space-failed:$operation_id:pull:available=436326400:required=6442450944:reserve=2147483648" \
  'image-pull space failure did not preserve a distinct safe reason'
test ! -s "$test_dir/events" || fail 'space check reached a Docker mutation'
passed=$((passed + 1))
TEST_FREE_BYTES=6442450944 require_image_space pull 6442450944
passed=$((passed + 1))
if TEST_FREE_BYTES=unknown require_image_space pull 6442450944 >"$test_dir/space"; then
  fail 'unknown image-pull free space was accepted'
fi
assert_line "$test_dir/space" \
  "markdoc-vm-image-space-failed:$operation_id:pull:reason=unavailable" \
  'unknown capacity did not fail explicitly'
if TEST_FREE_BYTES=2147483647 require_image_space activate 2147483648 >"$test_dir/space"; then
  fail 'image activation was accepted below the production reserve'
fi
assert_line "$test_dir/space" \
  "markdoc-vm-image-space-failed:$operation_id:activate:available=2147483647:required=2147483648:reserve=2147483648" \
  'pre-activation reserve failure was not distinct'

: >"$test_dir/events"
retain_release_images "$current" "$previous"
assert_line "$test_dir/events" "rmi $old" 'unused old Markdoc image was not removed'
test "$(grep -c '^rmi ' "$test_dir/events")" = 1 ||
  fail 'retention removed a kept, used, or unrelated image'
grep -Eq 'rmi .* (-f|--force)|system prune|volume prune' "$test_dir/events" &&
  fail 'retention used force or broad pruning'
passed=$((passed + 2))

if TEST_RMI_FAIL=1 retain_release_images "$current" "$previous"; then
  fail 'retention removal failure was hidden'
fi
passed=$((passed + 1))
if retain_release_images bad-id "$previous"; then
  fail 'retention accepted an unverified running image ID'
fi
passed=$((passed + 1))

healthy_finish="$(sed -n '/^    deployment_succeeded=true/,/^    exit 0/p' "$source_file")"
test -n "$healthy_finish" || fail 'healthy release completion is missing'
retain_release_images() { return 1; }
current_id="$current"
previous_id="$previous"
( eval "$healthy_finish" ) >"$test_dir/warning"
assert_line "$test_dir/warning" \
  "markdoc-vm-image-warning:$operation_id:retention-failed" \
  'retention failure did not warn while preserving successful release completion'
retain_release_images() {
  printf 'retention-called\n' >>"$test_dir/retention-called"
  return 0
}
previous_id=''
( eval "$healthy_finish" ) >"$test_dir/warning"
assert_line "$test_dir/warning" \
  "markdoc-vm-image-warning:$operation_id:retention-failed" \
  'missing previous identity did not warn after healthy repair'
test ! -e "$test_dir/retention-called" || fail 'unknown previous identity allowed image removal'
passed=$((passed + 1))

pull_guard="$(grep -n '^require_image_space pull ' "$source_file" | cut -d: -f1)"
rollback="$(grep -n '^rollback_dir=' "$source_file" | cut -d: -f1)"
authenticate="$(grep -n '^aad_token=' "$source_file" | cut -d: -f1)"
pull="$(grep -n '^docker pull ' "$source_file" | cut -d: -f1)"
activate_guard="$(grep -n '^require_image_space activate ' "$source_file" | cut -d: -f1)"
change="$(grep -n '^production_changed=true' "$source_file" | cut -d: -f1)"
test "$pull_guard" -lt "$rollback" && test "$pull_guard" -lt "$authenticate" &&
  test "$pull_guard" -lt "$pull" && test "$pull" -lt "$activate_guard" &&
  test "$activate_guard" -lt "$change" || fail 'disk guards do not precede mutable release work'
passed=$((passed + 1))

sed -n '/^cleanup() {/,/^}/p' "$source_file" >"$test_dir/cleanup.sh"
source "$test_dir/cleanup.sh"
if (
  docker() { return 0; }
  rm() { return 0; }
  cp() { printf 'copy\n' >>"$test_dir/production-events"; }
  chmod() { printf 'chmod\n' >>"$test_dir/production-events"; }
  systemctl() { printf 'systemctl\n' >>"$test_dir/production-events"; }
  rollback_dir="$test_dir/rollback"
  deployment_succeeded=false
  production_changed=false
  set +e
  false
  cleanup
); then
  fail 'pre-activation refusal lost its original failure status'
fi
test ! -e "$test_dir/production-events" || fail 'pre-activation refusal rolled back/restarted an unchanged app'
passed=$((passed + 1))

printf 'VM image space/retention tests passed: %s assertions\n' "$passed"
