import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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

test("prints the version from package.json", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^mbflash \d+\.\d+\.\d+\s*$/);
  assert.equal(r.stdout.trim(), `mbflash ${pkg.version}`);
});

test("help documents project selection and switch", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--project <name>/);
  assert.match(r.stdout, /--switch/);
  assert.match(r.stdout, /--retitle/);
});

test("help documents extension handling", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--extension <spec>/);
  assert.match(r.stdout, /--remove-extension <spec>/);
  assert.match(r.stdout, /--list-extensions/);
  assert.match(r.stdout, /--search-extensions <q>/);
  assert.match(r.stdout, /--skill/);
});

test("--skill prints the bundled skill exactly", () => {
  const skill = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf8");
  const r = run(["--skill"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, skill);
  assert.match(r.stdout, /^---\nname: makecode-microbit/);
  assert.match(r.stdout, /--search-extensions/);
});

test("--search-extensions requires a value", () => {
  const r = run(["--search-extensions"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--search-extensions requires a value/);
});

test("--extension needs a browser, not --flash-hex", () => {
  const r = run(["--extension", "servo", "--flash-hex", "demo.hex"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--extension needs a browser tab/);
});

test("--list-extensions is read-only", () => {
  const r = run(["--list-extensions", "main.ts"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--list-extensions only reads the selected project/);
});

test("--list-extensions cannot install", () => {
  const r = run(["--list-extensions", "--extension", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--list-extensions does not install extensions/);
});

test("--search-extensions cannot install", () => {
  const r = run(["--search-extensions", "servo", "--extension", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--search-extensions does not install extensions/);
});

test("--extension requires a non-empty spec", () => {
  const r = run(["--extension="]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--extension requires a non-empty spec/);
});

test("--remove-extension requires a non-empty spec", () => {
  const r = run(["--remove-extension="]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--remove-extension requires a non-empty spec/);
});

test("--extension and --remove-extension are exclusive", () => {
  const r = run(["--extension", "servo", "--remove-extension", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /choose --extension or --remove-extension/);
});

test("--remove-extension needs a browser, not --flash-hex", () => {
  const r = run(["--remove-extension", "servo", "--flash-hex", "demo.hex"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--remove-extension needs a browser tab/);
});

test("--list-extensions does not remove extensions", () => {
  const r = run(["--list-extensions", "--remove-extension", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--list-extensions does not remove extensions/);
});

test("--search-extensions does not remove extensions", () => {
  const r = run(["--search-extensions", "servo", "--remove-extension", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--search-extensions does not remove extensions/);
});

test("--list-extensions and --search-extensions are exclusive", () => {
  const r = run(["--list-extensions", "--search-extensions", "servo"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /choose only one of --list-extensions and --search-extensions/);
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
