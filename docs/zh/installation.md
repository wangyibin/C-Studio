# 安装

C-Studio 当前提供 macOS 和 Windows 的源码构建与打包流程。此检出版本尚未建立
稳定且带签名的公开安装包，因此下面将源码构建作为可复现路径。

## 依赖

=== "macOS"

    安装：

    - Node.js 22 与 npm
    - 通过 `rustup` 安装 Rust
    - Xcode Command Line Tools
    - CMake
    - 普通开发构建所需的本机 HDF5

=== "Windows"

    安装：

    - Node.js 22 与 npm
    - 带 MSVC 工具链的 Rust
    - Visual Studio C++ Build Tools，并选择 **Desktop development with C++**
    - CMake

    Windows 安装包可以构建，但项目目录、接触矩阵、PAF 和覆盖度的若干原生
    文件选择器目前仅在 macOS 实现。参见[当前限制](reference/limitations.md)。

## 从源码运行

在包含 `package.json` 和 `src-tauri/` 的应用仓库目录中打开终端，然后运行：

```bash
npm ci
npm run tauri dev
```

开发构建使用主机上的 HDF5。发布打包使用 `portable-hdf5` 特性，将 HDF5 与
zlib 静态链接到应用中。

## 构建 macOS 通用安装包

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
APPLE_SIGNING_IDENTITY="-" npm run tauri -- build \
  --target universal-apple-darwin \
  --features portable-hdf5 \
  --bundles app,dmg
```

输出位于 `src-tauri/target/universal-apple-darwin/release/bundle/`。

该命令使用临时签名，而不是 Apple Developer ID 公证。macOS 首次启动时可能需要
右键应用并选择**打开**。

## 构建 Windows 安装包

在 Windows x86-64 机器的 PowerShell 中运行：

```powershell
rustup target add x86_64-pc-windows-msvc
npm ci
npm run tauri -- build `
  --target x86_64-pc-windows-msvc `
  --features portable-hdf5 `
  --bundles nsis,msi
```

NSIS `.exe` 与 WiX `.msi` 位于
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`。它们当前没有正式签名，
可能触发 Microsoft SmartScreen。

## 验证开发检出版本

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

这些检查通过，只能说明对应测试覆盖的软件行为正确，并不能证明新数据集上的
生物学有效性。

