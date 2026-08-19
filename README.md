# C-Studio

C-Studio is a desktop application for inspecting and editing genome assemblies,
built with Tauri 2, React, and Rust.

![overview](docs/C-Studio_Figure1_overview.png)

## Documentation

- [English documentation](https://wangyibin.github.io/C-Studio/latest/)
- [中文文档](https://wangyibin.github.io/C-Studio/zh/latest/)

The documentation follows the bilingual, versioned C-Phasing layout. Zensical
builds the English and Chinese sources separately, while Mike retains released
versions on the `gh-pages` branch. Install
[Pixi](https://pixi.sh/latest/installation/) once, then build both languages
from the application repository:

```bash
pixi install -e docs
pixi run --locked -e docs docs-build
pixi run --locked -e docs docs-serve
```

Open `http://127.0.0.1:8000/` for English or
`http://127.0.0.1:8000/zh/` for Chinese.

## Development

Pixi provides the pinned Node.js, Rust, CMake, and Ninja toolchain. The npm and
Cargo lock files continue to pin the application's JavaScript and Rust source
dependencies. Install the package environment and start the development
application with:

```bash
pixi install -e package
pixi run --locked -e package tauri-dev
```

The Pixi development and release tasks enable `portable-hdf5`, which builds and
statically links HDF5 with zlib support. Neither developers nor end users need
to install HDF5 separately.

## Manual packaging

Download the source code using **Code → Download ZIP** on GitHub and extract the
archive, or clone the repository with Git. Open a terminal in the extracted
C-Studio application directory before running the commands below. Install
[Pixi](https://pixi.sh/latest/installation/) first; it installs the shared
packaging toolchain from `pixi.lock`.

Release packaging enables `portable-hdf5`, which builds and statically links
HDF5 with zlib support. The generated application therefore does not require a
separate HDF5 installation on the end user's computer.

### macOS

Install the following prerequisites:

- Pixi
- Xcode Command Line Tools

Run this on an Apple Silicon Mac to build the ARM64 package:

```bash
pixi install -e package
pixi run --locked -e package package-macos
```

The generated files are placed under:

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/macos/C-Studio.app
src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
```

Open the DMG and drag C-Studio into the Applications folder. The command above
uses ad-hoc signing, not Apple notarization, so macOS may still require
right-clicking the application and selecting **Open** on first launch.

### Windows

For production packages, perform the Windows build on a Windows x86-64
computer. Install the following prerequisites:

- Pixi
- Visual Studio C++ Build Tools with **Desktop development with C++**

Open PowerShell in the C-Studio application directory and run:

```powershell
pixi install -e package
pixi run --locked -e package package-windows
```

The generated installers are placed under:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi
```

Install C-Studio using either the NSIS `.exe` installer or the WiX `.msi`
package.

#### Experimental Windows NSIS build from macOS

The same Pixi task can cross-compile the Windows x64 application and NSIS
installer on macOS. MSI packages cannot be produced on macOS. In addition to
Pixi and Xcode Command Line Tools, install the external tools that are not
available from conda-forge for macOS:

```bash
cargo install --locked cargo-xwin
brew install nsis
brew install --cask wine-stable
```

Then run:

```bash
pixi install -e package
pixi run --locked -e package package-windows
```

Pixi supplies the cross-compilation Clang/LLVM linker tools and Windows Rust
standard library. The generated installer is placed under:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

Cross-compilation is less thoroughly tested than a native Windows build. Test
the installer and all file-open/save dialogs on a real Windows computer before
distribution. Use the GitHub workflow below when an MSI installer or a native
Windows build is required. `cargo-xwin` caches the downloaded Windows SDK under
`src-tauri/target/xwin-cache`. If a stale local proxy causes an error mentioning
`127.0.0.1`, disable or correct that proxy and rerun the task.
