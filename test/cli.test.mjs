import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../mbflash.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 15000,
  });
}

test("prints a semver version", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^mbflash \d+\.\d+\.\d+\s*$/);
});

test("help documents project selection and switch", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--project <name>/);
  assert.match(r.stdout, /--switch/);
  assert.match(r.stdout, /--retitle/);
});

test("--load-only requires a source", () => {
  const r = run(["--load-only"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--load-only requires a source file/);
});

test("the old --set-label option is rejected", () => {
  const r = run(["--set-label", "Foo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--set-label is gone/);
});

test("--retitle requires a project name", () => {
  const r = run(["--switch", "--retitle"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--retitle needs --project/);
});

test("rejects a truncated hex before touching the device", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mbflash-test-"));
  try {
    const hex = path.join(dir, "bad.hex");
    writeFileSync(hex, "bad");
    const r = run(["--flash-hex", hex, "--device", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /hex looks too small/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
