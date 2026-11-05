import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function releaseVersion(root, tag = "") {
  const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  const cargo = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
  const packageSection = cargo.match(/^\[package\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || version !== tauriVersion || version !== cargoVersion) {
    throw new Error(`Release versions must agree: package.json=${version}, Tauri=${tauriVersion}, Cargo=${cargoVersion}`);
  }
  if (tag && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match v${version}`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(releaseVersion(resolve(dirname(fileURLToPath(import.meta.url)), ".."), process.env.RELEASE_TAG || ""));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
