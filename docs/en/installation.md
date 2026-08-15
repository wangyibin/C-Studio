# Installation

C-Studio currently has source-build and packaging workflows for macOS and
Windows. A stable, signed public installer is not yet established in this
checkout, so the source build is the reproducible path documented here.

## Prerequisites

=== "macOS"

    Install:

    - Node.js 22 and npm
    - Rust through `rustup`
    - Xcode Command Line Tools
    - CMake
    - a host HDF5 installation for ordinary development builds

=== "Windows"

    Install:

    - Node.js 22 and npm
    - Rust with the MSVC toolchain
    - Visual Studio C++ Build Tools with **Desktop development with C++**
    - CMake

    The Windows package can be built, but several native project/contact/PAF/
    coverage file pickers are currently macOS-only. See
    [current limitations](reference/limitations.md).

## Run from a source checkout

Open a terminal in the application repository—the directory containing
`package.json` and `src-tauri/`—then run:

```bash
npm ci
npm run tauri dev
```

Development builds use the HDF5 installation available on the host. The
`portable-hdf5` feature is intended for release packaging and statically links
HDF5 with zlib support.

## Build a macOS universal package

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
APPLE_SIGNING_IDENTITY="-" npm run tauri -- build \
  --target universal-apple-darwin \
  --features portable-hdf5 \
  --bundles app,dmg
```

Outputs are written below
`src-tauri/target/universal-apple-darwin/release/bundle/`.

The command uses ad-hoc signing, not Apple Developer ID notarization. macOS may
require right-clicking the app and choosing **Open** the first time.

## Build Windows installers

Run this on a Windows x86-64 machine in PowerShell:

```powershell
rustup target add x86_64-pc-windows-msvc
npm ci
npm run tauri -- build `
  --target x86_64-pc-windows-msvc `
  --features portable-hdf5 `
  --bundles nsis,msi
```

The NSIS `.exe` and WiX `.msi` installers are written below
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. They are unsigned and
may trigger Microsoft SmartScreen.

## Verify a development checkout

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Passing these checks establishes software correctness for the covered tests; it
does not establish biological validity on a new dataset.

