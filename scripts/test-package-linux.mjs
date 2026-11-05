import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { linuxReleaseAssets, validateLinuxBinary } from "./package-linux.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cstudio-linux-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Linux payload validation rejects other architectures and malformed ELF headers", (t) => {
  const root = fixture(t);
  const path = join(root, "c-studio");
  const header = Buffer.alloc(64);
  header.write("\x7fELF");
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(62, 18);
  writeFileSync(path, header);
  validateLinuxBinary(path);

  for (const [offset, value] of [[4, 1], [5, 2], [18, 183], [18, 3]]) {
    const invalid = Buffer.from(header);
    invalid[offset] = value;
    writeFileSync(path, invalid);
    assert.throws(() => validateLinuxBinary(path), /must be x86-64/);
  }
  for (const invalid of [header.subarray(0, 20), Buffer.alloc(64), Buffer.from("MZ")]) {
    writeFileSync(path, invalid);
    assert.throws(() => validateLinuxBinary(path), /Not a Linux ELF executable/);
  }
});

test("Linux releases require both nonempty bundles for the requested version", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "deb"));
  mkdirSync(join(root, "appimage"));
  const deb = join(root, "deb/C-Studio_0.5.3_amd64.deb");
  const appimage = join(root, "appimage/C-Studio_0.5.3_amd64.AppImage");
  writeFileSync(deb, "Debian fixture");
  assert.throws(() => linuxReleaseAssets(root, "0.5.3"), /Missing or empty/);
  writeFileSync(appimage, "AppImage fixture");
  assert.deepEqual(linuxReleaseAssets(root, "0.5.3"), [deb, appimage]);
  assert.throws(() => linuxReleaseAssets(root, "0.5.4"), /Missing or empty/);
  writeFileSync(deb, "");
  assert.throws(() => linuxReleaseAssets(root, "0.5.3"), /Missing or empty/);
  rmSync(deb);
  mkdirSync(deb);
  assert.throws(() => linuxReleaseAssets(root, "0.5.3"), /Missing or empty/);
});

test("unsupported hosts fail before starting a Linux build", {
  skip: process.platform === "linux" && process.arch === "x64",
}, () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), "package-linux.mjs");
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a native Linux x86-64 environment/);
});
