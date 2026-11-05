# Installation

C-Studio's desktop builds target macOS Apple Silicon / Intel, Windows x86-64,
and Linux x86-64. Most users
should install a package from the [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)
page. Building from source is only needed for development or for testing a
specific checkout.

## Install a release package

=== "macOS (Apple Silicon / Intel)"

    1. Open [GitHub Releases](https://github.com/wangyibin/C-Studio/releases) and select the latest release.
    2. Download the `.dmg` package (preferred), or the `.app.zip` archive. Choose `aarch64` / `arm64` for Apple Silicon or `x64` for Intel.
    3. Open the downloaded package and move `C-Studio.app` to **Applications**.
    4. Start C-Studio from **Applications**.

    Current macOS packages are ad-hoc signed and are not notarized. After
    verifying that the file came from the official release page, macOS may
    require you to Control-click the app and choose **Open** the first time.

=== "Windows (x86-64)"

    1. Open [GitHub Releases](https://github.com/wangyibin/C-Studio/releases) and select the latest release.
    2. Download the Windows x64 NSIS `.exe` installer (preferred), or the `.msi` package.
    3. Run the installer and follow its prompts.

    Current Windows packages are unsigned and may trigger Microsoft
    SmartScreen. Only continue after verifying that the installer came from
    the official release page.

=== "Linux (x86-64)"

    Open [GitHub Releases](https://github.com/wangyibin/C-Studio/releases) and choose
    a release containing the Linux `amd64` packages. Builds use Ubuntu 22.04 as
    the baseline and require a graphical desktop session.

    On Ubuntu / Debian, download the `.deb` package and run in its directory:

    ```bash
    sudo apt install ./C-Studio_*_amd64.deb
    ```

    Start **C-Studio** from the applications menu, or run `c-studio` in a terminal.
    HDF5 is included in the application; APT installs the system runtime dependencies.

    To use the AppImage without installing the application:

    ```bash
    chmod +x C-Studio_*_amd64.AppImage
    ./C-Studio_*_amd64.AppImage
    ```

    If FUSE is unavailable, run `./C-Studio_*_amd64.AppImage --appimage-extract-and-run`.
    Linux ARM64 desktop packages are not provided.

## For developers: run or build from source

### Prerequisites

=== "macOS"

    Install:

    - [Pixi](https://pixi.sh/latest/installation/)
    - Xcode Command Line Tools

=== "Windows"

    Install:

    - [Pixi](https://pixi.sh/latest/installation/)
    - Visual Studio C++ Build Tools with **Desktop development with C++**

=== "Linux (Ubuntu 22.04 x86-64)"

    Install [Pixi](https://pixi.sh/latest/installation/), then install the
    [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux)
    and packaging tools:

    ```bash
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends \
      build-essential pkg-config curl wget file patchelf \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
      libayatana-appindicator3-dev librsvg2-dev libfuse2
    ```

Pixi installs the pinned Node.js, Rust, CMake, and Ninja packaging toolchain.
Native compilers, SDKs, and Linux GTK / WebKitGTK remain system prerequisites.

### Run from a source checkout

Open a terminal in the application repository—the directory containing
`package.json` and `src-tauri/`—then run:

```bash
pixi install -e package
pixi run --locked -e package tauri-dev
```

The Pixi development task enables `portable-hdf5`, so Cargo builds and
statically links HDF5 with zlib support. No system HDF5 installation is
required.

### Build a macOS Apple Silicon package

Run this on an Apple Silicon Mac:

```bash
pixi install -e package
pixi run --locked -e package package-macos
```

Outputs are written below
`src-tauri/target/aarch64-apple-darwin/release/bundle/`.

The command uses ad-hoc signing, not Apple Developer ID notarization. macOS may
require right-clicking the app and choosing **Open** the first time.

### Build Windows installers

Run this on a Windows x86-64 machine in PowerShell:

```powershell
pixi install -e package
pixi run --locked -e package package-windows
```

The NSIS `.exe` and WiX `.msi` installers are written below
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`. They are unsigned and
may trigger Microsoft SmartScreen.

### Build Linux packages

After installing the Linux prerequisites, run on Linux x86-64:

```bash
pixi install -e package
pixi run --locked -e package package-linux
```

The `.deb` and `.AppImage` files are written to the `deb/` and `appimage/`
subdirectories of `src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/`.
The task verifies the x86-64 executables, Debian version and architecture, and
both output files. Use Ubuntu 22.04 for release builds: building on a newer
distribution can raise the minimum runtime library versions.
The task uses `/usr/bin/cc` to link against the distribution's GTK and WebKitGTK
libraries, avoiding a mismatch with Pixi's separate glibc sysroot.

On an Apple Silicon Mac with Rosetta, Docker Desktop with Buildx, and the
Windows cross-packaging tools, run `pixi run --locked -e package release-local`
to build both macOS architectures, Windows and Linux together. The packages
are collected in `output/releases/v<version>/`; the Windows package is an
NSIS `.exe`. After pushing the matching tag to GitHub, create a Release and
upload the packages and `SHA256SUMS` from that directory.

### Verify a development checkout

```bash
pixi run --locked -e package package-test
pixi run --locked -e package package-frontend
pixi run --locked -e package package-rust-check
```

Passing these checks establishes software correctness for the covered tests; it
does not establish biological validity on a new dataset.
