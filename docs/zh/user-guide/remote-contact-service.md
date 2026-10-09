# 使用远程文件

**入口：Add Data → Remote project or file…**。填写 HTTP/HTTPS 地址，不要填写服务器上的 `/data/…` 路径。

| 你的需求 | 选择方式 | 数据在哪里处理 |
| --- | --- | --- |
| 大型 `.cool/.mcool`，减少本地内存占用 | **远程计算（推荐）** | 服务器读取矩阵、生成热图；客户端负责交互和编辑 |
| 打开远程 AGP、PAF、GFA、覆盖度或普通项目目录 | **文件链接** | 完整下载到本地缓存，再由桌面端加载 |

## 远程计算：三步连接，不填 token

需要 Linux 服务启动包；获取和构建方式见[部署参考](../reference/remote-service.md)。已有服务地址时，直接按管理员提供的连接方式进入第 3 步。

### 1. 在服务器启动服务

将矩阵和 AGP 放在同一目录，建议使用相同前缀：

```text
/data/project/sample.mcool
/data/project/sample.agp
```

进入解压后的服务启动包目录，运行：

```bash
./cstudio --no-token /data/project/sample.mcool
```

服务在后台运行，只监听服务器的 `127.0.0.1:8787`。无 token 模式会按端口保存，之后重启仍然生效。已有服务运行时，先执行 `./cstudio stop` 再切换启动方式。

### 2. 在自己的电脑建立 SSH 隧道

在**本地终端**运行，将 `user@server` 换成自己的 SSH 用户名和服务器地址：

```bash
ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 user@server
```

保持此终端打开；没有输出是正常的。已有相同隧道时无需重复运行。

### 3. 在 C-Studio 中连接

打开 **Add Data → Remote project or file…**，填写：

| 字段 | 填写内容 |
| --- | --- |
| Remote URL | `http://127.0.0.1:18787/v1/datasets/project` |
| Bearer token | **留空** |

点击 **Open**。状态栏出现 `Server rendered contact map` 表示正在使用服务器生成的热图。

空组装会话会自动加载服务器上的配套 AGP，之后即可拖动、缩放和编辑。**保存结果到本地，不会覆盖服务器原文件。**

## 文件链接：粘贴即可打开

在同一连接窗口填入文件或目录链接，例如：

```text
https://server.example/project/sample.agp
https://server.example/project/
```

点击 **Open**。只有服务器要求认证时才填写 token。

- **文件链接**：只加载该文件，保留其他已加载数据。
- **目录链接**：需要服务器提供目录列表；识别并加载 AGP、矩阵、PAF、GFA 和覆盖度。打开新项目目录会替换当前工作区，先保存编辑。
- **直接链接到 `.cool/.mcool` 会完整下载矩阵**；希望把矩阵计算留在服务器时，使用上面的远程计算方式。

## 常见问题

| 问题 | 怎么处理 |
| --- | --- |
| AGP 没有自动加载 | 与矩阵放在同一目录：优先同名前缀，否则目录内只能有一个 `.agp`。已有组装会保留；要切换时先保存，再清空数据并重新连接。 |
| 刚添加或修改了远程文件 | 在服务器停止服务，再按第 1 步启动。 |
| 本地 `18787` 端口已占用 | 已有相同隧道就直接连接；否则将命令里的本地端口改为 `18788`，同时修改 Remote URL。 |
| 不用 SSH、直接连接服务器 | 停止服务后用 `./cstudio --token /data/project/sample.mcool` 启动，填写输出的 URL 和 token。 |
| 能直接在浏览器中操作吗？ | 当前启动包只提供数据服务；请在 C-Studio 中连接。网页界面需要另行部署。 |

在服务器查看或停止服务：

```bash
./cstudio status
./cstudio stop
```

服务器重启后需重新启动服务。首次读取新区域可能较慢，后续访问会复用缓存。更多配置见[远程服务部署与缓存](../reference/remote-service.md)。
