#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo 'usage: deploy-vm-image.sh <registry> <image-by-digest> <app-version> <tenant-id> <operation-id>' >&2
  exit 2
fi

registry="$1"
image="$2"
app_version="$3"
tenant_id="$4"
operation_id="$5"
if ! [[ "$operation_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo 'operation id must be a UUID' >&2
  exit 2
fi
case "$image" in
  "${registry}/markdoc@sha256:"*) ;;
  *)
    echo 'image must be the markdoc repository on the requested registry, pinned by sha256 digest' >&2
    exit 2
    ;;
esac
if ! [[ "$app_version" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'app version must be a full Git commit SHA' >&2
  exit 2
fi
test -f /etc/markdoc/markdoc.env
test -f /etc/systemd/system/markdoc-app.service

if ! declare -F run_markdoc_release_wal_gate >/dev/null; then
  echo 'release WAL gate source is missing' >&2
  exit 1
fi
unset \
  MARKDOC_RELEASE_WAL_GATE_OPERATION \
  MARKDOC_RELEASE_WAL_GATE_TEST_ROOT \
  MARKDOC_RELEASE_WAL_GATE_ARCHIVE_TIMEOUT \
  MARKDOC_RELEASE_WAL_GATE_RESTORE_TIMEOUT \
  MARKDOC_RELEASE_WAL_GATE_START_TIMEOUT \
  MARKDOC_RELEASE_WAL_GATE_QUERY_TIMEOUT \
  MARKDOC_RELEASE_WAL_GATE_STOP_TIMEOUT
run_markdoc_release_wal_gate "$operation_id"
if [ "${MARKDOC_RELEASE_WAL_GATE_OPERATION:-}" != "$operation_id" ]; then
  echo 'release WAL recovery evidence is missing for this operation' >&2
  exit 1
fi
unset MARKDOC_RELEASE_WAL_GATE_OPERATION
printf 'markdoc-vm-image-operation:%s\n' "$operation_id"

rollback_dir="$(mktemp -d)"
chmod 0700 "$rollback_dir"
cp /etc/markdoc/markdoc.env "$rollback_dir/markdoc.env"
cp /etc/systemd/system/markdoc-app.service "$rollback_dir/markdoc-app.service"
deployment_succeeded=false

cleanup() {
  local status=$?
  trap - EXIT
  docker logout "$registry" >/dev/null 2>&1 || true
  rm -f /root/.docker/config.json
  if [ "$deployment_succeeded" != true ]; then
    cp "$rollback_dir/markdoc.env" /etc/markdoc/markdoc.env
    cp "$rollback_dir/markdoc-app.service" /etc/systemd/system/markdoc-app.service
    chmod 0600 /etc/markdoc/markdoc.env
    systemctl daemon-reload
    rollback_ready=false
    if systemctl restart markdoc-app; then
      for attempt in $(seq 1 20); do
        health="$(curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null || true)"
        if [ -n "$health" ] && python3 -c '
import json, sys
health = json.loads(sys.argv[1])
raise SystemExit(0 if all(health.get(key) is True for key in ("ok", "db", "collab")) else 1)
' "$health"; then
          rollback_ready=true
          break
        fi
        sleep 3
      done
    fi
    if [ "$rollback_ready" = true ]; then
        echo markdoc-vm-image-rollback-ready >&2
    else
      echo markdoc-vm-image-rollback-failed >&2
      status=1
    fi
  fi
  rm -rf "$rollback_dir"
  if [ "$status" -eq 0 ] && [ "$deployment_succeeded" = true ]; then
    printf '%s\n' "$health"
    echo markdoc-vm-image-ready
    printf 'markdoc-vm-image-operation-ready:%s\n' "$operation_id"
  fi
  exit "$status"
}
trap cleanup EXIT

metadata_token() {
  local resource="$1"
  local encoded
  encoded="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$resource")"
  curl -fsS -H Metadata:true \
    "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2019-08-01&resource=${encoded}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
}

aad_token="$(metadata_token 'https://management.azure.com/')"
refresh_token="$(
  curl -fsS -X POST "https://${registry}/oauth2/exchange" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=access_token' \
    --data-urlencode "service=${registry}" \
    --data-urlencode "tenant=${tenant_id}" \
    --data-urlencode "access_token=${aad_token}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])'
)"
registry_token="$(
  curl -fsS -X POST "https://${registry}/oauth2/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=refresh_token' \
    --data-urlencode "service=${registry}" \
    --data-urlencode 'scope=repository:markdoc:pull' \
    --data-urlencode "refresh_token=${refresh_token}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
)"
printf '%s' "$registry_token" | docker login "$registry" \
  --username 00000000-0000-0000-0000-000000000000 \
  --password-stdin >/dev/null
docker pull "$image"

python3 - "$app_version" <<'PY'
import pathlib
import sys

path = pathlib.Path("/etc/markdoc/markdoc.env")
version = sys.argv[1]
lines = path.read_text().splitlines()
result = []
found = False
for line in lines:
    if line.startswith("APP_VERSION="):
        result.append(f"APP_VERSION={version}")
        found = True
    else:
        result.append(line)
if not found:
    result.append(f"APP_VERSION={version}")
path.write_text("\n".join(result) + "\n")
path.chmod(0o600)
PY

cat >/etc/systemd/system/markdoc-app.service <<EOF
[Unit]
Description=Markdoc application
After=docker.service postgresql.service network-online.target
Requires=docker.service postgresql.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f markdoc-app
ExecStart=/usr/bin/docker run --name markdoc-app --network host --memory 768m --cpus 0.6 --env-file /etc/markdoc/markdoc.env ${image}
ExecStop=/usr/bin/docker stop -t 30 markdoc-app
TimeoutStartSec=300
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl restart markdoc-app

for attempt in $(seq 1 40); do
  health="$(curl -fsS http://127.0.0.1:3000/api/health 2>/dev/null || true)"
  if [ -n "$health" ] && python3 -c '
import json, sys
health = json.loads(sys.argv[1])
expected = sys.argv[2]
raise SystemExit(0 if all(health.get(key) is True for key in ("ok", "db", "collab")) and health.get("version") == expected else 1)
' "$health" "$app_version"; then
    deployment_succeeded=true
    exit 0
  fi
  sleep 3
done

journalctl -u markdoc-app --no-pager -n 100
exit 1
