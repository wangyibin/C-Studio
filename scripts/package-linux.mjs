import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion } from "./release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function validateLinuxBinary(path) {
  const header = Buffer.alloc(64);
  const descriptor = openSync(path, "r");
  let length;
  try {
    length = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (length < 64 || header.toString("latin1", 0, 4) !== "\x7fELF") {
    throw new Error(`Not a Linux ELF executable: ${path}`);
  }
  if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 62) {
    throw new Error(`Linux application must be x86-64: ${path}`);
  }
}

export function linuxReleaseNames(version) {
  const name = `C-Studio_${version}_amd64`;
  return [`${name}.deb`, `${name}.AppImage`];
}

export function linuxReleaseAssets(bundle, version) {
  const [deb, appimage] = linuxReleaseNames(version);
  const paths = [join(bundle, "deb", deb), join(bundle, "appimage", appimage)];
  for (const path of paths) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`Missing or empty Linux release asset: ${path}`);
    }
  }
  return paths;
}

function run(command, args, capture = false, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1", ...env },
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})${capture ? `: ${result.stderr?.trim()}` : ""}`);
  }
  return result.stdout?.trim();
}

function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("package-linux requires a native Linux x86-64 environment. Use Ubuntu 22.04 or the GitHub desktop packaging workflow.");
  }
  const version = releaseVersion(root, process.env.RELEASE_TAG || "");
  const target = "x86_64-unknown-linux-gnu";
  if (!run("rustc", ["-vV"], true).split("\n").some((line) => line.trim() === `host: ${target}`)) {
    throw new Error(`package-linux requires a native ${target} Rust toolchain.`);
  }
  // GTK/WebKit come from the host distribution; Pixi supplies Node and Rust.
  run("pkg-config", ["--print-errors", "--exists", "gtk+-3.0", "webkit2gtk-4.1"]);
  const require = createRequire(import.meta.url);
  const targetDirectory = join(root, "src-tauri/target", target);
  // A native build does not need Tauri's rustup-based --target validation.
  // Cargo's target-dir keeps the same layout with Pixi-managed Rust as well.
  run(process.execPath, [
    require.resolve("@tauri-apps/cli/tauri.js"),
    "build", "--features", "portable-hdf5", "--bundles", "deb,appimage",
    "--", "--locked", "--target-dir", targetDirectory,
  ], false, {
    // Pixi's Linux Rust activates a Conda linker with its own glibc sysroot.
    // GTK and WebKit use the distribution's libc, so use its C linker too.
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "/usr/bin/cc",
  });
  const release = join(targetDirectory, "release");
  const executable = join(release, "c-studio");
  validateLinuxBinary(executable);
  const dependencies = run("ldd", [executable], true);
  if (/not found|\.pixi\/|libhdf5/.test(dependencies)) {
    throw new Error(`Unexpected Linux runtime dependency:\n${dependencies}`);
  }
  const [deb, appimage] = linuxReleaseAssets(join(release, "bundle"), version);
  validateLinuxBinary(appimage);
  if (run("dpkg-deb", ["--field", deb, "Architecture"], true) !== "amd64"
    || run("dpkg-deb", ["--field", deb, "Version"], true) !== version) {
    throw new Error("Linux Debian package architecture or version does not match the release.");
  }
  console.log(`Linux x86-64 packages ready:\n  ${deb}\n  ${appimage}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
