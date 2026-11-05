# 安装

C-Studio 桌面版的构建目标包括 macOS（Apple Silicon / Intel）、Windows x86-64
和 Linux x86-64。大多数用户应直接从
[GitHub Releases](https://github.com/wangyibin/C-Studio/releases) 下载并安装；只有开发
或需要测试特定源码检出版本时才需要从源码构建。

## 从 Release 安装

=== "macOS（Apple Silicon / Intel）"

    1. 打开 [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)，选择最新版本。
    2. 下载 `.dmg` 安装包（推荐）或 `.app.zip` 归档包。Apple Silicon 选择 `aarch64` / `arm64`，Intel 选择 `x64`。
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

=== "Linux（x86-64）"

    打开 [GitHub Releases](https://github.com/wangyibin/C-Studio/releases)，选择包含
    Linux `amd64` 安装包的版本。Linux 版以 Ubuntu 22.04 为构建基线，需要图形桌面环境。

    Ubuntu / Debian 用户下载 `.deb` 后，在下载目录运行：

    ```bash
    sudo apt install ./C-Studio_*_amd64.deb
    ```

    安装后从应用菜单打开 **C-Studio**，或在终端运行 `c-studio`。
    HDF5 已包含在应用中，APT 会安装所需的系统运行库。

    也可以下载 AppImage，直接运行：

    ```bash
    chmod +x C-Studio_*_amd64.AppImage
    ./C-Studio_*_amd64.AppImage
    ```

    如果系统缺少 FUSE，可运行 `./C-Studio_*_amd64.AppImage --appimage-extract-and-run`。
    暂不提供 Linux ARM64 桌面安装包。

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

=== "Linux（Ubuntu 22.04 x86-64）"

    安装 [Pixi](https://pixi.sh/latest/installation/)，然后安装
    [Tauri 的 Linux 依赖](https://v2.tauri.app/start/prerequisites/#linux)及打包工具：

    ```bash
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends \
      build-essential pkg-config curl wget file patchelf \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
      libayatana-appindicator3-dev librsvg2-dev libfuse2
    ```

Pixi 会安装固定版本的 Node.js、Rust、CMake 与 Ninja 打包工具链。原生编译器、
SDK，以及 Linux 的 GTK / WebKitGTK 仍需通过系统安装。

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

### 构建 Linux 安装包

安装上述 Linux 依赖后，在 Linux x86-64 机器上运行：

```bash
pixi install -e package
pixi run --locked -e package package-linux
```

`.deb` 与 `.AppImage` 分别位于
`src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/` 下的 `deb/` 和
`appimage/` 目录。脚本会检查可执行文件架构、Debian 包的版本和架构，并确认两种
安装包均已生成。发布包使用 Ubuntu 22.04 构建；在更新的发行版上构建，可能
提高运行所需的系统库版本。
打包任务使用系统的 `/usr/bin/cc` 链接 GTK 和 WebKitGTK，避免与 Pixi 自带的
glibc 构建环境混用。

在装有 Rosetta、Docker Desktop（含 Buildx）及 Windows 交叉打包工具的 Apple Silicon
Mac 上，运行 `pixi run --locked -e package release-local` 可一次生成两个 macOS
架构、Windows 和 Linux 的全部桌面安装包，输出到 `output/releases/v<版本号>/`。

### 验证开发检出版本

```bash
pixi run --locked -e package package-test
pixi run --locked -e package package-frontend
pixi run --locked -e package package-rust-check
```

这些检查通过，只能说明对应测试覆盖的软件行为正确，并不能证明新数据集上的
生物学有效性。
