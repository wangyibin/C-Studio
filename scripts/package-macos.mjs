import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.error("error: package-macos can only run on macOS");
  process.exit(1);
}

// Build for the native architecture so the Rust target and the Pixi dylibs
// bundled below always match, on both Intel and Apple Silicon Macs.
const nativeTargets = {
  arm64: "aarch64-apple-darwin",
  x64: "x86_64-apple-darwin",
};
const target = nativeTargets[process.arch];
if (!target) {
  console.error(`error: unsupported macOS architecture: ${process.arch}`);
  process.exit(1);
}

const projectRoot = process.cwd();
const environmentPrefix = process.env.CONDA_PREFIX
  ? resolve(process.env.CONDA_PREFIX)
  : resolve(projectRoot, ".pixi", "envs", "package");
const bundledLibiconv = resolve(environmentPrefix, "lib", "libiconv.2.dylib");

if (!existsSync(bundledLibiconv)) {
  console.error(
    `error: portable macOS build dependency is missing: ${bundledLibiconv}`,
  );
  process.exit(1);
}

// portable-hdf5 links against the Pixi environment's libiconv. Bundle that
// exact ABI-compatible dylib so release apps resolve it inside the bundle
// instead of relying on the build-machine RPATH or macOS' older system ABI.
const macBundle = {
  frameworks: [bundledLibiconv],
};
if (process.env.APPLE_SIGNING_IDENTITY === "-") {
  macBundle.entitlements = resolve(
    projectRoot,
    "src-tauri",
    "entitlements.ad-hoc.plist",
  );
}
const bundleOverlay = JSON.stringify({
  bundle: {
    macOS: macBundle,
  },
});
const result = spawnSync(
  "npm",
  [
    "run",
    "tauri",
    "--",
    "build",
    "--target",
    target,
    "--features",
    "portable-hdf5",
    "--bundles",
    "app,dmg",
    "--config",
    bundleOverlay,
  ],
  {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(`error: failed to start macOS packaging: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
