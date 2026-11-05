#!/usr/bin/env bash
set -euo pipefail

# Run the repository workflow against the current working tree, without binding
# Linux build output over the host's node_modules or Cargo target directories.
cstudio_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$cstudio_root"
command -v act >/dev/null || { echo 'Install act first: brew install act' >&2; exit 1; }
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }

# act uses the same container names for concurrent runs of this workflow.
# Even a dry run can clean up those containers, so allow one invocation at a time.
mkdir -p .cache/act
cstudio_lock="$cstudio_root/.cache/act/run.lock"
if ! mkdir "$cstudio_lock" 2>/dev/null; then
  echo "Local CI is already running (lock: $cstudio_lock)." >&2
  echo 'If a previous run was forcibly terminated, verify it has stopped before removing the lock directory.' >&2
  exit 1
fi
trap 'rm -f "$cstudio_lock/pid"; rmdir "$cstudio_lock"' EXIT
printf '%s\n' "$$" > "$cstudio_lock/pid"

# act does not use Docker's selected context automatically.
if [[ -z "${DOCKER_HOST:-}" ]]; then
  export DOCKER_HOST
  DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
fi
docker info >/dev/null

mkdir -p test-results/act-artifacts test-results/act-logs
cstudio_log="test-results/act-logs/$(date -u +%Y%m%dT%H%M%SZ).log"
act push \
  --workflows .github/workflows/tests.yml \
  --container-architecture linux/amd64 \
  --platform ubuntu-22.04=ghcr.io/catthehacker/ubuntu:act-22.04 \
  --concurrent-jobs 1 \
  --container-options '--cpus=4 --memory=6g' \
  --container-daemon-socket - \
  --env CARGO_BUILD_JOBS=2 \
  --env-file /dev/null --secret-file /dev/null --var-file /dev/null --input-file /dev/null \
  --action-cache-path "$cstudio_root/.cache/act/actions" \
  --cache-server-path "$cstudio_root/.cache/act/cache" \
  --artifact-server-path "$cstudio_root/test-results/act-artifacts" \
  --pull=false \
  "$@" 2>&1 | tee "$cstudio_log"
