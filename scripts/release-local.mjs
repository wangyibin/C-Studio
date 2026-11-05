import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { linuxReleaseNames, validateLinuxBinary } from "./package-linux.mjs";
import { releaseVersion } from "./release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, capture = false, { cwd = root, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status})${capture ? `: ${result.stderr?.trim()}` : ""}`);
  return result.stdout?.trim();
}

function pixi(environment, task) {
  run("pixi", ["run", "--locked", "-e", environment, task]);
}

function buildLinux(staging, version) {
  const context = ["--context", "desktop-linux"];
  const info = spawnSync("docker", [...context, "info"], { stdio: "ignore" });
  if (info.error) throw info.error;
  if (info.status !== 0) run("docker", ["desktop", "start"]);

  // Pass proxy values through the environment instead of putting credentials
  // in command lines. Loopback proxies live on the Mac, outside the builder.
  const env = { ...process.env };
  const proxyArgs = [];
  for (const name of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    const value = env[name] || env[name.toUpperCase()];
    if (!value) continue;
    env[name] = value;
    if (name !== "no_proxy") {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        url.hostname = "host.docker.internal";
        env[name] = url.href;
      }
    }
    proxyArgs.push("--build-arg", name);
  }
  // Export only the final scratch stage, into this run's fresh staging directory.
  run("docker", [
    ...context, "buildx", "build", "--builder", "desktop-linux", "--platform", "linux/amd64",
    "--file", join(root, "docker/release-linux.Dockerfile"), "--target", "packages",
    "--build-arg", `RELEASE_TAG=v${version}`, ...proxyArgs, "--output", ".", root,
  ], false, { cwd: staging, env });
  const [deb, appimage] = linuxReleaseNames(version);
  if (!statSync(join(staging, deb)).size) throw new Error(`Empty Linux package: ${deb}`);
  validateLinuxBinary(join(staging, appimage));
  return [deb, appimage];
}

export function validateWindowsBinary(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error(`Not a Windows executable: ${path}`);
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 6 || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0" || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error(`Windows application must be x86-64: ${path}`);
  }
}

export function writeChecksums(directory, names) {
  const lines = [...names].sort().map((name) => {
    const path = join(directory, name);
    if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error(`Missing or empty release asset: ${name}`);
    return `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}\n`;
  });
  writeFileSync(join(directory, "SHA256SUMS"), lines.join(""));
}

function sourceState() {
  return `${run("git", ["rev-parse", "HEAD"], true)}\n${run("git", ["status", "--porcelain"], true)}\n${run("git", ["diff", "HEAD", "--binary"], true)}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: pixi run --locked -e package release-local [--publish]\n\nBuild macOS ARM64 and Intel, Windows x86-64 (NSIS), and Linux x86-64 (Debian and AppImage) into output/releases/v<version>/.\n--publish creates a GitHub Release for the existing v<version> tag after all builds succeed.\nRequires Apple Silicon macOS, Rosetta, Docker Desktop with Buildx, cargo-xwin, NSIS and Wine. Publishing also requires gh.");
    return;
  }
  if (args.some((arg) => arg !== "--publish")) throw new Error(`Unknown option: ${args.join(" ")}`);
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Run release-local in the native package environment on an Apple Silicon Mac.");
  const publish = args.includes("--publish");
  const version = releaseVersion(root);
  const tag = `v${version}`;
  const initialState = sourceState();
  if (publish) {
    if (run("git", ["status", "--porcelain"], true)) throw new Error("Commit local changes before publishing a tagged release.");
    if (run("git", ["rev-parse", "HEAD"], true) !== run("git", ["rev-parse", `${tag}^{commit}`], true)) throw new Error(`Check out ${tag} before publishing.`);
    run("gh", ["auth", "status"]);
    const remoteTags = run("git", ["ls-remote", "--exit-code", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`], true).split("\n");
    const remoteCommit = (remoteTags.find((line) => line.endsWith("^{}")) || remoteTags[0]).split(/\s+/)[0];
    if (remoteCommit !== run("git", ["rev-parse", "HEAD"], true)) throw new Error(`Remote tag ${tag} points to a different commit.`);
  }
  run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
  run("pixi", ["run", "--locked", "-e", "package", "bash", "-c", "for tool in cargo-xwin makensis clang-cl llvm-rc lld-link wine; do command -v \"$tool\" >/dev/null || { echo \"Missing tool: $tool\" >&2; exit 1; }; done"]);
  const intelArch = run("pixi", ["run", "--locked", "-e", "package-intel", "node", "-p", "process.arch"], true);
  if (intelArch !== "x64") throw new Error("package-intel must run Intel Node.js under Rosetta.");
  const parent = join(root, "output/releases");
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${tag}-`));
  const assets = [];
  let buildError;
  try {
    console.log(`\n=== Building Linux x86-64 in Docker (${tag}) ===`);
    assets.push(...buildLinux(staging, version));
    for (const platform of [
      { label: "macOS ARM64", environment: "package", target: "aarch64-apple-darwin", arch: "arm64", suffix: "aarch64" },
      { label: "macOS Intel", environment: "package-intel", target: "x86_64-apple-darwin", arch: "x86_64", suffix: "x64" },
    ]) {
      console.log(`\n=== Building ${platform.label} (${tag}) ===`);
      pixi(platform.environment, "package-macos");
      const bundle = join(root, "src-tauri/target", platform.target, "release/bundle");
      const app = join(bundle, "macos/C-Studio.app");
      const appVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")], true);
      if (appVersion !== version) throw new Error(`${platform.label} bundle version is ${appVersion}, expected ${version}`);
      for (const file of ["MacOS/c-studio", "Frameworks/libiconv.2.dylib"]) run("/usr/bin/lipo", [join(app, "Contents", file), "-verify_arch", platform.arch]);
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
      const dmg = `C-Studio_${version}_${platform.suffix}.dmg`;
      run("/usr/bin/hdiutil", ["verify", join(bundle, "dmg", dmg)]);
      copyFileSync(join(bundle, "dmg", dmg), join(staging, dmg));
      const zip = `C-Studio-${platform.suffix === "aarch64" ? "arm64" : "x64"}.app.zip`;
      run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, join(staging, zip)]);
      assets.push(dmg, zip);
    }
    console.log(`\n=== Building Windows x86-64 (${tag}) ===`);
    pixi("package", "package-windows");
    const windows = join(root, "src-tauri/target/x86_64-pc-windows-msvc/release");
    // The NSIS bootstrap itself may be 32-bit; verify the application payload.
    validateWindowsBinary(join(windows, "c-studio.exe"));
    const exe = `C-Studio_${version}_x64-setup.exe`;
    copyFileSync(join(windows, "bundle/nsis", exe), join(staging, exe));
    assets.push(exe);
    if (releaseVersion(root) !== version || sourceState() !== initialState) throw new Error("Source files changed during the release build. Build again from one revision.");
    writeChecksums(staging, assets);
  } catch (error) {
    buildError = error;
  } finally {
    console.log("\n=== Restoring native macOS frontend dependencies ===");
    try { pixi("package", "package-install"); } catch (error) { buildError ??= error; }
  }
  if (buildError) throw new Error(`${buildError.message}\nIncomplete output retained at ${staging}; no release was published.`);
  const destination = join(parent, tag);
  if (existsSync(destination)) renameSync(destination, `${destination}.previous-${Date.now()}`);
  renameSync(staging, destination);
  console.log(`\nAll desktop packages ready: ${destination}`);
  for (const name of [...assets, "SHA256SUMS"]) console.log(`  ${name}`);
  if (publish) {
    if (sourceState() !== initialState) throw new Error("Source changed before publication.");
    const files = [...assets, "SHA256SUMS"].map((name) => join(destination, name));
    // Keep the release unpublished until GitHub confirms the entire asset set.
    run("gh", ["release", "create", tag, ...files, "--draft", "--verify-tag", "--generate-notes", "--title", tag]);
    const remote = JSON.parse(run("gh", ["release", "view", tag, "--json", "assets"], true));
    for (const name of [...assets, "SHA256SUMS"]) {
      if (!remote.assets.some((asset) => asset.name === name && asset.size === statSync(join(destination, name)).size)) throw new Error(`Draft release is missing ${name}; it remains unpublished.`);
    }
    run("gh", ["release", "edit", tag, "--draft=false"]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 1; }
}
