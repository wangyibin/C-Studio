# C-Studio server · 简易启动

Download the Linux x86_64 or ARM64 package matching your server, then extract it.
下载与你的服务器架构匹配的 Linux 压缩包，解压后进入目录：

```bash
./cstudio /data/project/input.mcool
```

The launcher creates a private bearer token, starts the server in the background,
and prints the URL and token. Paste them into **Add Data → Remote project or file…**
in an updated C-Studio client. Load the matching AGP to edit the assembly.
启动器自动生成连接密码并在后台运行，复制输出的 URL 和 Bearer token 到客户端即可。
普通用户可运行，不需要 sudo、Rust、Node.js 或桌面环境。

```bash
./cstudio status           # Show connection details / 查看连接信息
./cstudio stop             # Stop / 停止
./cstudio /data/b.mcool 8788  # Another dataset on another port / 另开一个数据集
```

State and logs are stored in `$XDG_STATE_HOME/cstudio-server/<port>` or
`~/.local/state/cstudio-server/<port>`. The password is reused across restarts.
The process keeps running after the terminal closes on hosts that allow background
user processes. It does **not** automatically restart after a reboot. On a managed
cluster, run it under the site's approved scheduler or service policy.
退出终端后可继续运行（取决于服务器用户进程策略），重启服务器后需重新执行启动命令。

Use this direct HTTP mode on a trusted private network. Public access needs an HTTPS
reverse proxy. The launcher cannot open a firewall or infer a public proxy address;
if the printed address is unreachable, use the server's reachable private IP and
allow the selected port. The service only exposes the named matrix, not arbitrary files.
此方式用于可信内网；公网访问需要 HTTPS 代理。启动器不会修改防火墙。

## Maintainers / 开发者

Build a distribution on Linux with `bash scripts/package-server.sh` from the repo root.
The manual `Package C-Studio server` GitHub workflow builds both Linux architectures;
packages appear in its artifacts. The workflow does not publish a release.
Linux compilation needs Rust, a C/C++ toolchain and CMake. These are build-time
requirements; users of the resulting package do not need them. Bundled HDF5/zlib
are built via `portable-hdf5`; the executable still requires compatible Linux system libraries.
