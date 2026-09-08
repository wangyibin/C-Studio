# 远程项目和文件

C-Studio 桌面端可以直接打开 HTTP/HTTPS 项目目录或文件链接，不要求远程机器安装
C-Studio 服务。选择 **Add Data → Remote project or file…** 后，可以输入：

```text
http://host.example/project/
http://host.example/project/input.mcool
```

项目地址需要返回常见的 HTML 目录清单。C-Studio 会识别同一目录中的 `.agp`、
`.cool/.mcool`、`.depth/.bedgraph/.bg`、`.paf` 和 `.gfa` 文件，下载到应用缓存，再按
本地项目相同的顺序加载。输入具体文件链接时只下载并加载该文件，不清除已经打开的
其他数据。直接文件链接不猜测含义不明确的 `.txt` 文件。

这种方式会完整下载所选文件，适合项目共享、普通静态文件服务器和中小型数据。下载由
桌面后端执行，因此目录服务器不需要配置 CORS。受保护的静态服务器可以使用连接窗口中
的 bearer token。

## 大文件按需读取

对于不适合完整下载的大型 `.cool` 或 `.mcool`，C-Studio 也可以通过只读的
`cstudio-server` HTTP API 打开接触矩阵。桌面端只读取一次元数据，随后在浏览时按需
请求 overview 和当前可见的 tiles。

按需读取服务目前只覆盖接触矩阵；AGP、PAF、GFA 和 coverage 通过上述静态链接下载后导入。

## 构建服务

在 C-Studio 源码目录运行：

```bash
cargo build --release \
  --manifest-path crates/cstudio-server/Cargo.toml \
  --features portable-hdf5
```

`portable-hdf5` 会在构建时编译 HDF5 和 zlib，因此服务端机器不需要另外安装 HDF5
运行库。生成的程序位于 `crates/cstudio-server/target/release/`。

## 在本机启动

```bash
crates/cstudio-server/target/release/cstudio-server \
  --dataset example=/absolute/path/to/input.mcool
```

默认只监听 `127.0.0.1:8787`。在 C-Studio 中选择
**Add Data → Remote project or file…**，输入：

```text
http://127.0.0.1:8787/v1/datasets/example
```

可以重复使用 `--dataset ID=PATH` 发布多个白名单文件。客户端不能传入任意服务器
文件路径。

## 提供给另一台机器

创建一个只含高强度 bearer token 的文本文件，然后在私有网络接口启动服务：

```bash
crates/cstudio-server/target/release/cstudio-server \
  --bind 0.0.0.0:8787 \
  --token-file /absolute/path/to/cstudio-token.txt \
  --dataset example=/absolute/path/to/input.mcool
```

在 C-Studio 连接窗口输入同一 token。token 只保存在当前应用的内存中，不会写入项目文件。

如果流量会离开可信私有网络，应在服务前配置 HTTPS 反向代理，并使用 `https://`
数据集地址。明文 HTTP 中的 bearer token 可能被截获。除非显式传入
`--allow-unauthenticated-remote`，服务会拒绝“非本机监听且无 token”的配置。

## API 边界

API v1 提供：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/v1/health` | 存活状态与 API 版本 |
| `GET` | `/v1/datasets` | 已注册数据集 |
| `GET` | `/v1/datasets/{id}/metadata` | 格式、大小、分辨率和染色体/来源 |
| `POST` | `/v1/datasets/{id}/overview` | 有大小上限的导航概览 |
| `POST` | `/v1/datasets/{id}/tiles` | 稀疏二进制 `CST1` 接触矩阵 tiles |

客户端会随视图请求发送当前由 AGP 得到的布局，因此服务端投影与桌面工作区中的顺序、
方向和来源区间一致。数据集始终只读，没有修改源文件的 API。

## 远程端要求

- 服务进程需要读取每个已注册 `.cool`/`.mcool` 文件及穿过其父目录的权限。
- 服务运行期间保持数据文件不变；更新文件时应重启服务，而不是原位覆盖。
- 开放所选端口，并确保桌面端可以访问对外提供的主机名。
- 如果服务超出单台可信工作站使用范围，用反向代理提供 TLS、访问日志、限流和组织认证。

当前实现会复用单个 C-Studio 服务进程内已有的 reader cache，但尚未提供分布式 tile
缓存、可恢复的离线下载，或文本证据格式的远程导入。
