# C-Studio

C-Studio is a desktop application for inspecting and editing genome assemblies,
built with Tauri 2, React, and Rust.

## Development

Install the frontend dependencies and start the development application with:

```bash
npm ci
npm run tauri dev
```

The default local Rust build uses the HDF5 installation available on the host
system. Release builds enable `portable-hdf5`, which statically links HDF5 with
zlib support so that end users do not need to install HDF5 separately.

## Manual packaging

Download the source code using **Code → Download ZIP** on GitHub and extract the
archive, or clone the repository with Git. Open a terminal in the extracted
C-Studio application directory before running the commands below.

Release packaging enables `portable-hdf5`, which builds and statically links
HDF5 with zlib support. The generated application therefore does not require a
separate HDF5 installation on the end user's computer.

### macOS

Install the following prerequisites:

- Node.js 22 and npm
- Rust using `rustup`
- Xcode Command Line Tools
- CMake

Install both Apple Rust targets, install the project dependencies, and build a
Universal package that runs on Apple Silicon and Intel Macs:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
APPLE_SIGNING_IDENTITY="-" npm run tauri -- build \
  --target universal-apple-darwin \
  --features portable-hdf5 \
  --bundles app,dmg
```

The generated files are placed under:

```text
src-tauri/target/universal-apple-darwin/release/bundle/macos/C-Studio.app
src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
```

Open the DMG and drag C-Studio into the Applications folder. The command above
uses ad-hoc signing, not Apple notarization, so macOS may still require
right-clicking the application and selecting **Open** on first launch.

### Windows

Perform the Windows build on a Windows x86-64 computer. Install the following
prerequisites:

- Node.js 22 and npm
- Rust with the MSVC toolchain
- Visual Studio C++ Build Tools with **Desktop development with C++**
- CMake

Open PowerShell in the C-Studio application directory and run:

```powershell
rustup target add x86_64-pc-windows-msvc
npm ci
npm run tauri -- build `
  --target x86_64-pc-windows-msvc `
  --features portable-hdf5 `
  --bundles nsis,msi
```

The generated installers are placed under:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi
```

Install C-Studio using either the NSIS `.exe` installer or the WiX `.msi`
package.

### Distribution limitations

- The macOS packages are not notarized with an Apple Developer ID certificate.
- The Windows installers are unsigned and may trigger Microsoft SmartScreen.
- Code signing and notarization should be configured before distributing the
  packages publicly.
