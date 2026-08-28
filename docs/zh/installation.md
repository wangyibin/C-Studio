# 安装

C-Studio 为 Apple Silicon macOS 和 Windows x86-64 提供桌面版。大多数用户应直接从
[GitHub Releases](https://github.com/wangyibin/C-Studio/releases) 下载并安装；只有开发
或需要测试特定源码检出版本时才需要从源码构建。

## 从 Release 安装

=== "macOS（Apple Silicon）"

    1. 打开 [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)，选择最新版本。
    2. 下载 macOS ARM64 的 `.dmg` 安装包（推荐），或 `.app.zip` 归档包。
    3. 打开下载的安装包，将 `C-Studio.app` 移到**应用程序**文件夹。
    4. 从**应用程序**文件夹启动 C-Studio。

    当前 macOS 安装包使用临时签名，尚未公证。确认文件来自官方 Release 页面后，首次
    启动时可能需要按住 Control 点按应用，并选择**打开**。

=== "Windows（x86-64）"

    1. 打开 [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)，选择最新版本。
    2. 下载 Windows x64 的 NSIS `.exe` 安装程序（推荐），或 `.msi` 安装包。
    3. 运行安装程序并按提示完成安装。

    当前 Windows 安装包未签名，可能触发 Microsoft SmartScreen。仅在确认安装程序来自
    官方 Release 页面后继续安装。

## 开发者：从源码运行或构建

### 依赖

=== "macOS"

    安装：

    - [Pixi](https://pixi.sh/latest/installation/)
    - Xcode Command Line Tools

=== "Windows"

    安装：

    - [Pixi](https://pixi.sh/latest/installation/)
    - Visual Studio C++ Build Tools，并选择 **Desktop development with C++**

Pixi 会安装固定版本的 Node.js、Rust、CMake 与 Ninja 打包工具链。Xcode 和
Visual Studio 仍是系统依赖，因为它们提供对应操作系统的原生编译器、SDK 与
打包工具。

### 从源码运行

在包含 `package.json` 和 `src-tauri/` 的应用仓库目录中打开终端，然后运行：

```bash
pixi install -e package
pixi run --locked -e package tauri-dev
```

Pixi 开发任务会启用 `portable-hdf5`，由 Cargo 构建 HDF5，并将其与 zlib
静态链接到应用中，不需要安装系统 HDF5。

### 构建 macOS Apple Silicon 安装包

请在 Apple Silicon Mac 上运行：

```bash
pixi install -e package
pixi run --locked -e package package-macos
```

输出位于 `src-tauri/target/aarch64-apple-darwin/release/bundle/`。

该命令使用临时签名，而不是 Apple Developer ID 公证。macOS 首次启动时可能需要
右键应用并选择**打开**。

### 构建 Windows 安装包

在 Windows x86-64 机器的 PowerShell 中运行：

```powershell
pixi install -e package
pixi run --locked -e package package-windows
```

NSIS `.exe` 与 WiX `.msi` 位于
`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`。它们当前没有正式签名，
可能触发 Microsoft SmartScreen。

### 验证开发检出版本

```bash
pixi run --locked -e package package-test
pixi run --locked -e package package-frontend
pixi run --locked -e package package-rust-check
```

这些检查通过，只能说明对应测试覆盖的软件行为正确，并不能证明新数据集上的
生物学有效性。
