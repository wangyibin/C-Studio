#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this cross-packaging task is only supported on macOS" >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "$script_dir/.." && pwd)
cd "$project_root"

missing_tools=()
for tool in cargo-xwin makensis clang-cl llvm-rc lld-link wine; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing_tools+=("$tool")
  fi
done

if (( ${#missing_tools[@]} > 0 )); then
  printf 'error: missing Windows cross-packaging tools: %s\n' "${missing_tools[*]}" >&2
  cat >&2 <<'EOF'

Install the external tools, then run the Pixi task again:

  cargo install --locked cargo-xwin
  brew install nsis
  brew install --cask wine-stable

Pixi supplies clang-cl, llvm-rc, lld-link, CMake, Ninja, Rust, and the Windows
Rust standard library. The macOS cross-build can create NSIS installers only;
use Windows or the GitHub workflow when an MSI package is required.
EOF
  exit 1
fi

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/cstudio-windows-cross.XXXXXX")
cleanup_temporary_dir() {
  rm -rf -- "$temporary_dir"
}
trap cleanup_temporary_dir EXIT

# Tauri's Unix NSIS bundler may look for wine64 even when Homebrew exposes the
# universal Wine launcher only as `wine`.
if ! command -v wine64 >/dev/null 2>&1; then
  printf '%s\n' '#!/bin/sh' 'exec wine "$@"' >"$temporary_dir/wine64"
  chmod +x "$temporary_dir/wine64"
  export PATH="$temporary_dir:$PATH"
fi

if [[ -z "${WINEPREFIX:-}" ]]; then
  export WINEPREFIX="$temporary_dir/wine-prefix"
fi
export WINEDEBUG="${WINEDEBUG:--all}"
export MVK_CONFIG_LOG_LEVEL="${MVK_CONFIG_LOG_LEVEL:-0}"
export CFLAGS="${CFLAGS:--Wno-implicit-function-declaration}"
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$project_root/src-tauri/target/xwin-cache}"

run_windows_build() {
  npm run tauri -- build \
    --runner cargo-xwin \
    --target x86_64-pc-windows-msvc \
    --features portable-hdf5 \
    --config src-tauri/tauri.windows-cross.conf.json
}

set +e
run_windows_build
build_status=$?
set -e

if (( build_status == 0 )); then
  exit 0
fi

# hdf5-src currently prefixes the cross-compiled MSVC archive with `lib`,
# while hdf5-sys searches for `hdf5.lib`. Add a generated-target alias and
# retry only when this exact compatibility case was created by the first pass.
hdf5_alias_created=false
target_build_dir="src-tauri/target/x86_64-pc-windows-msvc/release/build"
while IFS= read -r hdf5_library; do
  hdf5_directory=${hdf5_library%/*}
  hdf5_alias="$hdf5_directory/hdf5.lib"
  if [[ ! -e "$hdf5_alias" ]]; then
    ln -s libhdf5.lib "$hdf5_alias"
    hdf5_alias_created=true
  fi
done < <(find "$target_build_dir" -path '*/out/lib/libhdf5.lib' -type f -print 2>/dev/null)

if [[ "$hdf5_alias_created" != true ]]; then
  exit "$build_status"
fi

echo "Retrying after adding the generated portable-HDF5 MSVC library alias..."
run_windows_build
