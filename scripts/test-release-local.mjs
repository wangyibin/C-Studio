import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { releaseVersion } from "./release-version.mjs";
import { validateWindowsBinary, writeChecksums } from "./release-local.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cstudio-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(join(root, "package.json"), '{"version":"0.5.3"}');
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), '{"version":"0.5.3"}');
  writeFileSync(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "c-studio"\nversion = "0.5.3"\n\n[dependencies]\n');
  return root;
}

test("release version rejects a mismatched tag and mismatched application metadata", (t) => {
  const root = fixture(t);
  assert.equal(releaseVersion(root, "v0.5.3"), "0.5.3");
  assert.throws(() => releaseVersion(root, "v0.5.4"), /does not match/);
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), '{"version":"0.5.2"}');
  assert.throws(() => releaseVersion(root), /must agree/);
});

test("Cargo dependency versions cannot be mistaken for the application version", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "src-tauri/Cargo.toml"), '[package]\nname = "c-studio"\n\n[dependencies.foo]\nversion = "0.5.3"\n');
  assert.throws(() => releaseVersion(root), /must agree/);
});

test("Windows payload checks reject 32-bit, ARM64 and malformed PE executables", (t) => {
  const root = fixture(t);
  const path = join(root, "c-studio.exe");
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  writeFileSync(path, bytes);
  validateWindowsBinary(path);
  for (const machine of [0x14c, 0xaa64]) {
    bytes.writeUInt16LE(machine, 68);
    writeFileSync(path, bytes);
    assert.throws(() => validateWindowsBinary(path), /must be x86-64/);
  }
  bytes.writeUInt32LE(0xffffffff, 0x3c);
  writeFileSync(path, bytes);
  assert.throws(() => validateWindowsBinary(path), /must be x86-64/);
  writeFileSync(path, "not an executable");
  assert.throws(() => validateWindowsBinary(path), /Not a Windows executable/);
});

test("checksums cover actual bytes and fail before publishing empty or missing assets", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "Intel.dmg"), "Intel package");
  writeFileSync(join(root, "ARM.dmg"), "ARM package");
  writeChecksums(root, ["Intel.dmg", "ARM.dmg"]);
  const expected = ["ARM.dmg", "Intel.dmg"].map((name) => `${createHash("sha256").update(readFileSync(join(root, name))).digest("hex")}  ${name}\n`).join("");
  assert.equal(readFileSync(join(root, "SHA256SUMS"), "utf8"), expected);
  writeFileSync(join(root, "Windows.exe"), "");
  assert.throws(() => writeChecksums(root, ["Windows.exe"]), /empty release asset/);
  assert.throws(() => writeChecksums(root, ["missing.exe"]), /ENOENT/);
});
