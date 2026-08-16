# Installation

C-Studio currently has source-build and packaging workflows for macOS and
Windows. A stable, signed public installer is not yet established in this
checkout, so the source build is the reproducible path documented here.

## Prerequisites

=== "macOS"

    Install:

    - [Pixi](https://pixi.sh/latest/installation/)
    - Xcode Command Line Tools

=== "Windows"

    Install:

    - [Pixi](https://pixi.sh/latest/installation/)
    - Visual Studio C++ Build Tools with **Desktop development with C++**

Pixi installs the pinned Node.js, Rust, CMake, and Ninja packaging toolchain.
The Xcode and Visual Studio components remain system prerequisites because they
provide each operating system's native compiler, SDK, and packaging tools.

## Run from a source checkout

Open a terminal in the application repository—the directory containing
`package.json` and `src-tauri/`—then run:

```bash
pixi install -e package
pixi run --locked -e package tauri-dev
```

The Pixi development task enables `portable-hdf5`, so Cargo builds and
statically links HDF5 with zlib support. No system HDF5 installation is
required.

## Build a macOS Apple Silicon package

Run this on an Apple Silicon Mac:

```bash
pixi install -e package
pixi run --locked -e package package-macos
```

Outputs are written below
`src-tauri/target/aarch64-apple-darwin/release/bundle/`.

The command uses ad-hoc signing, not Apple Developer ID notarization. macOS may
require right-clicking the app and choosing **Open** the first time.

## Build Windows installers

Run this on a Windows x86-64 machine in PowerShell:

```powershell
pixi install -e package
pixi run --locked -e package package-windows
```

The NSIS `.exe` and WiX `.msi` installers are written below
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. They are unsigned and
may trigger Microsoft SmartScreen.

## Verify a development checkout

```bash
pixi run --locked -e package package-test
pixi run --locked -e package package-frontend
pixi run --locked -e package package-rust-check
```

Passing these checks establishes software correctness for the covered tests; it
does not establish biological validity on a new dataset.
