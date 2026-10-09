#!/usr/bin/env bash
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$repo"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x86_64 ;;
  Linux-aarch64|Linux-arm64) platform=linux-aarch64 ;;
  *) echo 'Build this distribution on Linux x86_64 or ARM64.' >&2; exit 1 ;;
esac
cargo build --release --locked --manifest-path crates/cstudio-server/Cargo.toml --features portable-hdf5
version=$(awk -F '"' '/^version = / {print $2; exit}' crates/cstudio-server/Cargo.toml)
name="cstudio-server-v${version}-${platform}"
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
mkdir -p "$stage/$name" output/server-packages
cp crates/cstudio-server/target/release/cstudio-server tools/cstudio-server/cstudio "$stage/$name/"
cp tools/cstudio-server/README.md "$stage/$name/"
chmod +x "$stage/$name/cstudio" "$stage/$name/cstudio-server"
tar -C "$stage" -czf "output/server-packages/$name.tar.gz" "$name"
(cd output/server-packages && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
printf 'Package: %s/output/server-packages/%s.tar.gz\n' "$repo" "$name"
