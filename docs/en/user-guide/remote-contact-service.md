# Using remote files

**Open Add Data → Remote project or file…** and enter an HTTP/HTTPS URL, not a server filesystem path such as `/data/…`.

| What you need | Choose | Where processing happens |
| --- | --- | --- |
| Large `.cool/.mcool` files with less client memory use | **Remote computation (recommended)** | Server reads the matrix and renders heatmaps; client handles interaction and editing |
| Remote AGP, PAF, GFA, coverage, or an ordinary project directory | **File URL** | Full download to the local cache, then loading in the desktop app |

## Remote computation: three steps, no token

You need a Linux server package; see the [deployment reference](../reference/remote-service.md) for build and distribution details. If a service is already available, follow your administrator's connection instructions and proceed to step 3.

### 1. Start the service on the server

Place the matrix and AGP in the same directory, preferably with matching basenames:

```text
/data/project/sample.mcool
/data/project/sample.agp
```

From the extracted server package directory, run:

```bash
./cstudio --no-token /data/project/sample.mcool
```

The service runs in the background and listens only on the server's `127.0.0.1:8787`. The no-token setting is saved per port and retained across restarts. If a service is already running, run `./cstudio stop` before changing its startup mode.

### 2. Open an SSH tunnel on your computer

Run this in your **local terminal**, replacing `user@server` with your SSH username and server address:

```bash
ssh -N -L 127.0.0.1:18787:127.0.0.1:8787 user@server
```

Keep this terminal open; no output is normal. Skip this command if the same tunnel is already running.

### 3. Connect in C-Studio

Open **Add Data → Remote project or file…** and enter:

| Field | Value |
| --- | --- |
| Remote URL | `http://127.0.0.1:18787/v1/datasets/project` |
| Bearer token | **Leave empty** |

Click **Open**. `Server rendered contact map` in the status bar confirms server-side heatmap rendering.

An empty assembly session automatically loads the companion AGP from the server. You can then pan, zoom, and edit. **Save results locally; saving does not overwrite the server files.**

## File URLs: paste and open

Enter a file or directory URL in the same dialog, for example:

```text
https://server.example/project/sample.agp
https://server.example/project/
```

Click **Open**. Enter a token only if that server requires one.

- **File URL:** loads that file while keeping other loaded data.
- **Directory URL:** requires a server directory listing; discovers AGP, contact maps, PAF, GFA, and coverage. Opening a new project directory replaces the workspace, so save edits first.
- **A direct `.cool/.mcool` URL downloads the entire matrix.** Use remote computation above to keep matrix processing on the server.

## Common questions

| Question | What to do |
| --- | --- |
| AGP did not load automatically | Put it beside the matrix: a matching basename takes priority; otherwise there must be only one `.agp` in that directory. Existing assemblies are kept. To switch, save edits, clear loaded data, and reconnect. |
| Added or changed a remote file | Stop the service on the server, then start it again as in step 1. |
| Local port `18787` is in use | Reuse an existing matching tunnel; otherwise change the local port to `18788` in both the SSH command and Remote URL. |
| Connecting directly without SSH | Stop the service, start with `./cstudio --token /data/project/sample.mcool`, then use the printed URL and token. |
| Can I operate it directly in a browser? | The current package serves the data API. Connect in C-Studio; a browser UI needs a separate frontend deployment. |

Check or stop the service on the server:

```bash
./cstudio status
./cstudio stop
```

Start the service again after a server reboot. The first read of a new region may take longer; subsequent reads reuse cached results. More settings: [Remote service deployment and caching](../reference/remote-service.md).
