#!/usr/bin/env bash
# In-guest half of the monthly OS security patch for the PostgreSQL VM (docs/postgres-patching.md).
# deploy/patch-postgres-vm.ps1 sends this file verbatim as the managed run command `patch-os` once the temporary
# egress window is open; the run command's named parameters MARKDOC_PATCH_MODE (security | full | rollback),
# MARKDOC_ROLLBACK_PACKAGE and MARKDOC_ROLLBACK_VERSION arrive as environment variables. Run by hand it patches
# security-only. Output stays far below the run command's 4 KB cap: one line per stage, the apt chatter goes to
# /var/log/markdoc-os-patch.log (and /var/log/apt/history.log as always). Last line: `os-patch=ok upgraded=<n>
# reboot=<required|none> running=<kernel> installed=<kernel>` or `os-patch=failed ... stage=<s>`; both also reach
# syslog facility local0 with tag markdoc-os-patch, which the backup-failure alert watches.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l

MODE="${MARKDOC_PATCH_MODE:-security}"
ROLLBACK_PACKAGE="${MARKDOC_ROLLBACK_PACKAGE:-}"; ROLLBACK_VERSION="${MARKDOC_ROLLBACK_VERSION:-}"
LOG="${MARKDOC_PATCH_LOG:-/var/log/markdoc-os-patch.log}"
stage=start

fail() {
  local status=$?
  logger -p local0.err -t markdoc-os-patch "os-patch=failed mode=$MODE stage=$stage exit=$status"
  echo "--- tail of $LOG"
  tail -c 1500 "$LOG" 2>/dev/null || true
  echo "os-patch=failed mode=$MODE stage=$stage exit=$status"
  exit "$status"
}
die() { logger -p local0.err -t markdoc-os-patch "os-patch=failed mode=$MODE stage=arguments"; echo "os-patch=failed mode=$MODE stage=arguments $*" >&2; exit 2; }
trap fail ERR

installed_packages() { dpkg-query -W -f='${binary:Package}\t${Version}\n' | sort; }
newest_kernel() { ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's#.*/vmlinuz-##' | sort -V | tail -n 1 || true; }

case "$MODE" in
  security|full) ;;
  rollback)
    [[ "$ROLLBACK_PACKAGE" =~ ^[a-z0-9][a-z0-9.+-]*$ && "$ROLLBACK_VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9.:~+-]*$ ]] ||
      die 'MARKDOC_ROLLBACK_PACKAGE=<package> and MARKDOC_ROLLBACK_VERSION=<version> are required'
    ;;
  *) die "unknown MARKDOC_PATCH_MODE '$MODE'" ;;
esac

logger -p local0.info -t markdoc-os-patch "os-patch=start mode=$MODE"
{ echo; echo "=== os-patch $(date -u +%FT%TZ) mode=$MODE rollback=$ROLLBACK_PACKAGE=$ROLLBACK_VERSION"; } >>"$LOG"
echo "os-patch=start mode=$MODE at=$(date -u +%FT%TZ) host=$(hostname) log=$LOG"

kernel_before="$(uname -r)"
pg_before="$(dpkg-query -W -f='${Version}' postgresql-16 2>/dev/null || echo none)"
before="$(installed_packages)"
echo "postgresql-16-before=$pg_before pg_isready=$(pg_isready -q && echo ok || echo not-ready)"

stage=apt-update
apt-get -q update >>"$LOG" 2>&1

stage=upgrade
case "$MODE" in
  security)
    # Security-only: Ubuntu's Allowed-Origins are noble-security and ESM, never PGDG; Automatic-Reboot stays off.
    unattended-upgrade -v >>"$LOG" 2>&1
    ;;
  full)
    # Plain upgrade never installs new packages, so the PGDG postgresql metapackage cannot pull a new major
    # in; a new major would need dist-upgrade/full-upgrade, which this script never runs.
    apt-get -y -q upgrade >>"$LOG" 2>&1
    ;;
  rollback)
    pkg="$ROLLBACK_PACKAGE"; ver="$ROLLBACK_VERSION"
    if ! apt-get -y -q install --allow-downgrades "$pkg=$ver" >>"$LOG" 2>&1; then
      # Superseded versions leave the Ubuntu pockets; Launchpad's librarian keeps every published .deb.
      arch="$(dpkg --print-architecture)"; file="${pkg}_${ver#*:}_${arch}.deb"
      curl -fsSL -o "/tmp/$file" "https://launchpad.net/ubuntu/+archive/primary/+files/$file" ||
        { file="${pkg}_${ver#*:}_all.deb"; curl -fsSL -o "/tmp/$file" "https://launchpad.net/ubuntu/+archive/primary/+files/$file"; }
      apt-get -y -q install --allow-downgrades "/tmp/$file" >>"$LOG" 2>&1
      rm -f "/tmp/$file"
    fi
    apt-mark hold "$pkg" >>"$LOG" 2>&1
    echo "rollback=$pkg=$ver held=$pkg (apt-mark unhold $pkg once the regression is fixed)"
    ;;
esac

stage=postgres
after="$(installed_packages)"
changed="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | awk -F '\t' '{print $1"="$2}')"
upgraded="$(printf '%s' "$changed" | grep -c . || true)"
pg_after="$(dpkg-query -W -f='${Version}' postgresql-16 2>/dev/null || echo none)"
for _ in $(seq 1 12); do pg_isready -q && break; sleep 5; done   # a PostgreSQL minor restarts the cluster from its postinst
pg_isready -q
echo "changed=$upgraded $(printf '%s' "$changed" | tr '\n' ' ' | head -c 1500)"
echo "postgresql-16-after=$pg_after pg_isready=ok"

stage=needrestart
if command -v needrestart >/dev/null; then
  echo "needrestart: $(needrestart -b 2>/dev/null | grep -E '^NEEDRESTART-(KSTA|KCUR|KEXP|SVC):' | tr '\n' ' ' | head -c 800)"
fi

stage=reboot-check
reboot=none; [ -f /var/run/reboot-required ] && reboot=required
summary="os-patch=ok upgraded=$upgraded reboot=$reboot running=$kernel_before installed=$(newest_kernel)"
logger -p local0.info -t markdoc-os-patch "$summary"
echo "$summary"
