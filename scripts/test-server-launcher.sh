#!/usr/bin/env bash
# Real-process smoke test. Pass a compiled server and a small COOL/MCOOL fixture.
set -euo pipefail
[[ $# == 2 ]] || { echo 'Usage: test-server-launcher.sh SERVER DATASET' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
scratch=$(mktemp -d)
export XDG_STATE_HOME="$scratch/state"
port=${CSTUDIO_TEST_PORT:-19879}
mkdir "$scratch/package with spaces"
cp "$1" "$scratch/package with spaces/cstudio-server"
cp "$repo/tools/cstudio-server/cstudio" "$scratch/package with spaces/cstudio"
fixture_path="$scratch/input with spaces.${2##*.}"
cp "$2" "$fixture_path"
launcher="$scratch/package with spaces/cstudio"
cleanup() {
  "$launcher" stop "$port" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
"$launcher" "$fixture_path" "$port" > "$scratch/start-output"
grep -q 'C-Studio server is running' "$scratch/start-output"
state="$XDG_STATE_HOME/cstudio-server/$port"
read -r first_pid < "$state/pid"
read -r first_token < "$state/token"
[[ "$first_token" =~ ^[0-9a-f]{64}$ ]]
"$launcher" status "$port" > "$scratch/status-output"
grep -q 'Bearer token:' "$scratch/status-output"
curl --noproxy "*" -fsS -H "Authorization: Bearer $first_token" \
  "http://127.0.0.1:$port/v1/datasets/project/metadata" > "$scratch/metadata"
grep -q 'png-v1' "$scratch/metadata"
if "$launcher" "$fixture_path" "$port" > "$scratch/duplicate-output"; then
  echo 'Duplicate start unexpectedly succeeded' >&2; exit 1
fi
read -r actual_pid < "$state/pid"
[[ "$actual_pid" == "$first_pid" ]]
"$launcher" stop "$port" > "$scratch/stop-output"
grep -q 'stopped' "$scratch/stop-output"
if "$launcher" status "$port" >/dev/null; then echo 'Stopped service is still running' >&2; exit 1; fi
"$launcher" "$fixture_path" "$port" > "$scratch/restart-output"
read -r second_token < "$state/token"
[[ "$first_token" == "$second_token" ]]
"$launcher" stop "$port" > /dev/null
"$launcher" --no-token "$fixture_path" "$port" > "$scratch/no-token-output"
grep -q 'Bearer token: not required' "$scratch/no-token-output"
grep -q "http://127.0.0.1:$port/" "$scratch/no-token-output"
read -r no_token_pid < "$state/pid"
args=$(ps -ww -p "$no_token_pid" -o args=)
[[ "$args" == *"--bind 127.0.0.1:$port --dataset "* && "$args" != *"--token-file"* ]]
curl --noproxy "*" -fsS "http://127.0.0.1:$port/v1/datasets/project/metadata" > "$scratch/anonymous-metadata"
grep -q 'png-v1' "$scratch/anonymous-metadata"
"$launcher" stop "$port" > /dev/null
"$launcher" "$fixture_path" "$port" > "$scratch/no-token-restart-output"
grep -q 'Bearer token: not required' "$scratch/no-token-restart-output"
curl --noproxy "*" -fsS "http://127.0.0.1:$port/v1/datasets/project/metadata" > /dev/null
"$launcher" stop "$port" > /dev/null
"$launcher" --token "$fixture_path" "$port" > "$scratch/token-restored-output"
[[ $(curl --noproxy "*" -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/datasets/project/metadata") == 401 ]]
"$launcher" stop "$port" > /dev/null
printf 'Launcher smoke test passed: start, authenticated metadata, duplicate guard, status, stop, restart, stable token, paths with spaces.\n'
printf 'No-token mode passed: loopback listener, anonymous metadata, persistent mode, restore authentication.\n'
