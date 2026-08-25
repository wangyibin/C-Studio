import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

let command;
let args;

if (process.platform === "win32") {
  const require = createRequire(import.meta.url);
  // Modern Node releases reject spawning Windows .cmd shims directly.
  command = process.execPath;
  args = [
    require.resolve("@tauri-apps/cli/tauri.js"),
    "build",
    "--target",
    "x86_64-pc-windows-msvc",
    "--features",
    "portable-hdf5",
    "--bundles",
    "nsis,msi",
  ];
} else if (process.platform === "darwin") {
  command = "bash";
  args = ["scripts/package-windows-from-macos.sh"];
} else {
  console.error(
    "error: package-windows supports native Windows builds and the experimental macOS NSIS cross-build only",
  );
  process.exit(1);
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`error: failed to start ${command}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
