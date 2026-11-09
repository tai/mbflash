#!/usr/bin/env node
/**
 * mbflash — load, build and flash a micro:bit MakeCode project over CDP.
 *
 * Requirements: Node 22+ (built-in WebSocket), a headed Chromium started with
 * --remote-debugging-port=9222, and the micro:bit mounted as MICROBIT.
 *
 * This is deliberately dependency-free: it speaks CDP directly and writes the
 * .hex to the DAPLink MSC volume, so it does not depend on WebUSB or pairing.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 4) || typeof globalThis.WebSocket !== "function") {
  console.error("mbflash requires Node.js 22.4+ (built-in WebSocket).");
  process.exit(1);
}

const VERSION = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;
const DEFAULT_HOST = "makecode.microbit.org";
const DEFAULT_CDP = "127.0.0.1:9222";

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

const ui = { json: false, quiet: false, verbose: false, warnings: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

function out(...a) {
  if (!ui.json) console.log(...a);
}
function step(...a) {
  if (!ui.json && !ui.quiet) console.error(...a);
}
function debug(...a) {
  if (!ui.json && ui.verbose) console.error(...a);
}
function warn(msg) {
  ui.warnings.push(String(msg));
  if (!ui.json && !ui.quiet) console.error(`warning: ${msg}`);
}

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

function usage(msg) {
  console.error(`mbflash: ${msg}`);
  console.error("Try 'mbflash --help'.");
  process.exit(2);
}

function defaults() {
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return {
    cdp: process.env.MBFLASH_CDP || DEFAULT_CDP,
    host: undefined,
    url: undefined,
    title: undefined,
    target: undefined,
    index: undefined,
    project: undefined,
    label: undefined, // deprecated alias for --project
    switch: false,
    create: true,
    retitle: false,
    focus: true,
    source: undefined,
    loadOnly: false,
    hexOnly: false,
    flashOnly: false,
    flashHex: undefined,
    noBlocks: false,
    roundtrip: false,
    extensions: [],
    removeExtensions: [],
    listExtensions: false,
    searchExtensions: undefined,
    snapshot: false,
    snapshotDir: ".",
    fromEditor: false,
    skill: false,
    downloadDir: process.env.MBFLASH_DOWNLOAD_DIR || path.join(cache, "mbflash", "hex"),
    hexOut: undefined,
    device: process.env.MBFLASH_DEVICE || undefined,
    waitSec: 60,
    timeoutSec: 120,
    json: false,
    quiet: false,
    verbose: false,
    list: false,
    help: false,
    version: false,
  };
}

function parseArgs(argv) {
  const o = defaults();
  let source;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--") {
      for (const rest of argv.slice(i + 1)) {
        if (source !== undefined) usage("only one source file is supported");
        source = rest;
      }
      break;
    }

    if (a === "-" || !a.startsWith("-")) {
      if (source !== undefined) usage("only one source file is supported");
      source = a;
      continue;
    }

    const eq = a.indexOf("=");
    const key = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) usage(`${key} requires a value`);
      return argv[++i];
    };
    const number = (name) => {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) usage(`${name} must be a positive number`);
      return n;
    };

    switch (key) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "-V":
      case "--version":
        o.version = true;
        break;
      case "-j":
      case "--json":
        o.json = true;
        break;
      case "-q":
      case "--quiet":
        o.quiet = true;
        break;
      case "-v":
      case "--verbose":
        o.verbose = true;
        break;
      case "--list":
        o.list = true;
        break;
      case "--cdp":
        o.cdp = value();
        break;
      case "--host":
        o.host = value();
        break;
      case "--url":
        o.url = value();
        break;
      case "--title":
        o.title = value();
        break;
      case "--target":
        o.target = value();
        break;
      case "--project":
        o.project = value();
        break;
      case "--label":
        // Deprecated alias; matching is by MakeCode project name.
        o.label = value();
        break;
      case "--set-label":
        usage("--set-label is gone: tabs are identified by the MakeCode project name; use --project <name>");
        break;
      case "--switch":
        o.switch = true;
        break;
      case "--no-create":
        o.create = false;
        break;
      case "--retitle":
        o.retitle = true;
        break;
      case "--no-focus":
        o.focus = false;
        break;
      case "--index": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) usage("--index must be a positive integer");
        o.index = n;
        break;
      }
      case "--load-only":
      case "--load":
        o.loadOnly = true;
        break;
      case "--hex-only":
      case "--build-only":
      case "--no-flash":
        o.hexOnly = true;
        break;
      case "--flash-only":
        o.flashOnly = true;
        break;
      case "--flash-hex":
        o.flashHex = value();
        break;
      case "--no-blocks":
        o.noBlocks = true;
        break;
      case "--roundtrip":
        o.roundtrip = true;
        break;
      case "--extension":
        o.extensions.push(value());
        break;
      case "--remove-extension":
        o.removeExtensions.push(value());
        break;
      case "--list-extensions":
        o.listExtensions = true;
        break;
      case "--search-extensions":
        o.searchExtensions = value();
        break;
      case "--snapshot":
        if (inline !== undefined) {
          o.snapshotDir = inline || ".";
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          o.snapshotDir = argv[++i];
        } else {
          o.snapshotDir = ".";
        }
        o.snapshot = true;
        break;
      case "--from-editor":
        o.fromEditor = true;
        break;
      case "--skill":
        o.skill = true;
        break;
      case "--download-dir":
        o.downloadDir = value();
        break;
      case "--hex-out":
        o.hexOut = value();
        break;
      case "--device":
        o.device = value();
        break;
      case "--wait":
        o.waitSec = number("--wait");
        break;
      case "--timeout":
        o.timeoutSec = number("--timeout");
        break;
      default:
        usage(`unknown option ${key}`);
    }
  }

  o.source = source;
  if (o.project && o.label && o.project !== o.label) {
    usage("--project and --label must name the same project");
  }
  o.project = o.project || o.label;
  if (o.extensions.some((s) => !String(s).trim())) usage("--extension requires a non-empty spec");
  if (o.removeExtensions.some((s) => !String(s).trim())) {
    usage("--remove-extension requires a non-empty spec");
  }
  if (o.extensions.length && o.removeExtensions.length) {
    usage("choose --extension or --remove-extension, not both");
  }
  o.timeoutMs = Math.round(o.timeoutSec * 1000);
  o.waitMs = Math.round(o.waitSec * 1000);
  return o;
}

function resolveMode(o) {
  const explicit = [o.loadOnly, o.hexOnly, o.flashOnly, !!o.flashHex].filter(Boolean);
  if (explicit.length > 1) {
    usage("choose only one of --load-only, --hex-only, --flash-only, --flash-hex");
  }
  if (o.retitle && !o.project) usage("--retitle needs --project (or the --label alias)");
  if (o.fromEditor && !o.snapshot) usage("--from-editor only applies to --snapshot");

  if (o.snapshot) {
    if (
      o.source !== undefined ||
      o.loadOnly ||
      o.hexOnly ||
      o.flashOnly ||
      o.flashHex ||
      o.switch
    ) {
      usage("--snapshot only reads the project; do not combine it with a source or build/flash modes");
    }
    if (o.extensions.length || o.removeExtensions.length) {
      usage("--snapshot does not install or remove extensions");
    }
    if (o.listExtensions || o.searchExtensions !== undefined) {
      usage("--snapshot is its own read mode; do not combine it with --list-extensions/--search-extensions");
    }
    if (o.retitle) usage("--snapshot does not retitle the tab");
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "snapshot";
  }

  if (o.listExtensions && o.searchExtensions !== undefined) {
    usage("choose only one of --list-extensions and --search-extensions");
  }
  if (o.listExtensions) {
    if (
      o.source !== undefined ||
      o.loadOnly ||
      o.hexOnly ||
      o.flashOnly ||
      o.flashHex ||
      o.switch
    ) {
      usage("--list-extensions only reads the selected project; do not combine it with a source or other modes");
    }
    if (o.extensions.length) {
      usage("--list-extensions does not install extensions; use --extension on its own");
    }
    if (o.removeExtensions.length) {
      usage("--list-extensions does not remove extensions; use --remove-extension on its own");
    }
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "list-extensions";
  }
  if (o.searchExtensions !== undefined) {
    if (
      o.source !== undefined ||
      o.loadOnly ||
      o.hexOnly ||
      o.flashOnly ||
      o.flashHex ||
      o.switch
    ) {
      usage("--search-extensions only searches the gallery; do not combine it with a source or other modes");
    }
    if (o.extensions.length) {
      usage("--search-extensions does not install extensions; use --extension to install");
    }
    if (o.removeExtensions.length) {
      usage("--search-extensions does not remove extensions; use --remove-extension to remove");
    }
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "search-extensions";
  }

  if (o.switch) {
    if (o.source !== undefined || o.loadOnly || o.hexOnly || o.flashOnly || o.flashHex) {
      usage("--switch only selects/focuses a tab; do not combine it with a source or build/flash mode");
    }
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "switch";
  }

  if (o.flashHex) {
    if (o.source !== undefined) usage("--flash-hex does not take a source file");
    if (o.project || o.retitle) usage("--project/--retitle require a browser tab");
    if (o.extensions.length) usage("--extension needs a browser tab; do not combine it with --flash-hex");
    if (o.removeExtensions.length) {
      usage("--remove-extension needs a browser tab; do not combine it with --flash-hex");
    }
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "flash-hex";
  }

  if (o.loadOnly) {
    if (!o.source) usage("--load-only requires a source file");
    return "load";
  }

  if (o.flashOnly) {
    if (o.source !== undefined) {
      usage("--flash-only builds the code already in the editor; drop the source file");
    }
    if (o.noBlocks || o.roundtrip) usage("--no-blocks/--roundtrip only apply when loading a source");
    return "build+flash";
  }

  if (o.hexOnly) {
    if (o.noBlocks || o.roundtrip) {
      if (!o.source) usage("--no-blocks/--roundtrip require a source file");
    }
    return o.source ? "load+build" : "build";
  }

  if (o.source) return "load+build+flash";
  if (o.extensions.length) return "install";
  if (o.removeExtensions.length) return "remove";
  usage(
    "provide a source file (e.g. mbflash main.ts) or a mode: " +
      "--load-only, --hex-only, --flash-only, --flash-hex, --extension, --remove-extension",
  );
}

function printHelp() {
  console.log(`mbflash ${VERSION} — load, build and flash a micro:bit MakeCode project over CDP

Usage:
  mbflash [options] [main.ts]

Modes:
  (default, with file)   load main.ts -> Blocks -> build -> flash
  --load-only            load main.ts -> Blocks (no build/flash)
  --hex-only [file]      load [file] -> build/download (no flash)
  --flash-only           build/flash the code already in the editor
  --flash-hex <file>     flash an existing .hex (no CDP)
  --switch               focus the selected tab and exit (no build)
  --extension <spec>     ensure extension(s) are installed, then continue
  --remove-extension <spec> remove extension(s), then continue
  --snapshot [dir]       save main.ts / main.blocks / pxt.json (default .)
  --list-extensions      list the project's dependencies and exit
  --search-extensions <q> search the live extension gallery and exit

Target selection:
  --cdp <[ip:]port>      CDP endpoint (default 127.0.0.1:9222)
  --host <hostname>      tab hostname match (default ${DEFAULT_HOST})
  --url <substr|/re/>    tab URL match
  --title <substr>       tab title match
  --label <name>         deprecated alias for --project
  --project <name>       select by MakeCode project name (creates if missing)
  --retitle              set the tab title to "MakeCode — <project>"
  --no-create            with --project, fail instead of creating a project
  --target <id>          exact CDP page target id (from --list)
  --index <n>            1-based choice among matches
  --no-focus             do not bring the selected tab to front
  --list                 list targets, ids and project names, then exit

Output and device:
  --download-dir <dir>   where the browser writes the .hex
  --hex-out <path>       copy the built .hex here
  --device <mount>       MICROBIT mount (default: auto-detect)
  --wait <seconds>       flash timeout (default 60)
  --timeout <seconds>    build/download timeout (default 120)

Loading:
  --no-blocks            load TS only; do not convert to Blocks
  --roundtrip            JS -> Blocks -> JS check after loading

Extensions:
  --extension <spec>     install missing extension(s) before loading; repeatable
  --remove-extension <spec> remove extension(s) via the Explorer; repeatable
  --list-extensions      list installed dependencies (defaults vs extensions)
  --search-extensions <q> search the gallery (bundled + approved packages)

Snapshot:
  --snapshot [dir]       save main.ts, main.blocks (if persisted) and pxt.json
  --from-editor          with --snapshot, read main.ts from the live editor

Other:
  -j, --json             machine-readable summary on stdout
  -q, --quiet            suppress progress
  -v, --verbose          more detail
  -h, --help             this help
  -V, --version          print the version
  --skill                print the bundled SKILL.md and exit

Examples:
  mbflash main.ts
  mbflash --load-only main.ts
  mbflash --hex-only --download-dir ./build
  mbflash --flash-only
  mbflash --flash-hex demo.hex
  mbflash --cdp 192.168.1.50:9222 --url makecode main.ts
  mbflash --list
  mbflash --project Test1 --switch --retitle
  mbflash --project Test2 main.ts
  mbflash --project Test3 main.ts     # creates Test3 if it does not exist
  mbflash --label Test1 --switch      # deprecated alias for --project
  mbflash --list-extensions
  mbflash --search-extensions servo
  mbflash --project ServoDemo --extension servo main.ts
  mbflash --project Demo --extension servo --extension neopixel main.ts
  mbflash --project ServoDemo --remove-extension servo --switch
  mbflash --project MyProject --snapshot ./backup
  mbflash --project MyProject --snapshot ./backup --from-editor
  mbflash --skill > SKILL.md
`);
}

// ---------------------------------------------------------------------------
// CDP discovery and transport
// ---------------------------------------------------------------------------

function parseCdpTarget(value) {
  let s = String(value || DEFAULT_CDP).trim();
  if (/^\d+$/.test(s)) s = `127.0.0.1:${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`invalid CDP target: ${value}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`CDP target must be http(s):// or [ip:]port: ${value}`);
  }
  return {
    base: u.origin,
    host: u.hostname,
    port: u.port || (u.protocol === "https:" ? "443" : "80"),
    secure: u.protocol === "https:",
  };
}

async function fetchPages(target) {
  let res;
  try {
    res = await fetch(`${target.base}/json/list`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw new Error(`cannot reach CDP at ${target.base}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`CDP ${target.base}/json/list returned ${res.status}`);
  const all = await res.json();
  return all.filter((t) => t.type === "page");
}

function matchPattern(pattern, text) {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    const end = pattern.lastIndexOf("/");
    try {
      return new RegExp(pattern.slice(1, end), pattern.slice(end + 1)).test(text);
    } catch {
      // fall through to substring
    }
  }
  return text.toLowerCase().includes(pattern.toLowerCase());
}

function metadataMatches(p, o, useHost) {
  if (useHost) {
    try {
      if (new URL(p.url).hostname !== useHost) return false;
    } catch {
      return false;
    }
  }
  if (o.url && !matchPattern(o.url, p.url)) return false;
  if (o.title && !String(p.title || "").toLowerCase().includes(o.title.toLowerCase())) {
    return false;
  }
  return true;
}

async function pageProjectName(page) {
  let c;
  try {
    c = await Cdp.connect(page.webSocketDebuggerUrl, 5000);
    const v = await c.ev(
      `(() => {
        const el = document.querySelector('#fileNameInput2');
        if (el && el.value && el.value.trim()) return el.value.trim();
        // Fallback: an open pxt.json model (normally not loaded).
        if (typeof monaco !== 'undefined' && monaco.editor) {
          const m = monaco.editor.getModels().find(x => x.uri.toString().includes('pxt.json'));
          if (m) {
            try {
              const n = JSON.parse(m.getValue()).name;
              if (n) return String(n).trim();
            } catch (e) {}
          }
        }
        return '';
      })()`,
      5000,
    );
    return v || null;
  } catch {
    return null;
  } finally {
    c?.close();
  }
}

async function selectPage(pages, o, { allowMissingProject = false } = {}) {
  if (!pages.length) {
    if (allowMissingProject && o.project) return null;
    throw new Error("no page targets at the CDP endpoint");
  }

  if (o.target) {
    const p = pages.find((x) => x.id === o.target);
    if (!p) throw new Error(`target ${o.target} not found; use --list`);
    return p;
  }

  const useHost = o.host || (!o.url && !o.title ? DEFAULT_HOST : null);
  let matches = pages.filter((p) => metadataMatches(p, o, useHost));

  if (o.project) {
    const projects = await Promise.all(matches.map((p) => pageProjectName(p)));
    matches = matches.filter((p, i) => projects[i] === o.project);
  }

  if (!matches.length) {
    if (allowMissingProject && o.project) return null;
    throw new Error(o.project ? `no tab has project "${o.project}"; use --list` : "no tab matched; use --list to see page targets");
  }

  if (o.index) {
    if (o.index > matches.length) {
      throw new Error(`--index ${o.index} is out of range (${matches.length} match${matches.length === 1 ? "" : "es"})`);
    }
    return matches[o.index - 1];
  }

  if (matches.length === 1) return matches[0];

  const list = matches.map((p) => `  [${p.id}] ${p.url}`).join("\n");
  throw new Error(`${matches.length} tabs matched; use --target <id>, --project <name>, or --index <n>:\n${list}`);
}

function makecodeHomeUrl(target, pages, o) {
  const host = o.host || DEFAULT_HOST;
  const existing = pages.find((p) => {
    try {
      return new URL(p.url).hostname === host;
    } catch {
      return false;
    }
  });
  if (existing) {
    try {
      return new URL(existing.url).origin + "/";
    } catch {
      /* fall through */
    }
  }
  return `https://${host}/`;
}

async function createNewProjectTab(target, name, o, pages) {
  const version = await fetch(`${target.base}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  if (!version.webSocketDebuggerUrl) throw new Error("CDP endpoint did not advertise a browser websocket");

  const browser = await Cdp.connect(version.webSocketDebuggerUrl, 10000);
  let targetId;
  try {
    const url = makecodeHomeUrl(target, pages, o);
    debug(`creating tab at ${url}`);
    const r = await browser.send("Target.createTarget", { url }, 15000);
    targetId = r.targetId;
  } finally {
    browser.close();
  }
  if (!targetId) throw new Error("Target.createTarget returned no targetId");

  const deadline = Date.now() + 20000;
  for (;;) {
    const now = await fetchPages(target);
    const page = now.find((p) => p.id === targetId);
    if (page) return page;
    if (Date.now() > deadline) throw new Error("new tab did not appear at the CDP endpoint");
    await sleep(250);
  }
}

async function initNewProject(cdp, name) {
  const deadline = Date.now() + 30000;
  let openedDialog = false;

  // Wait for the home page (or a dialog already open), then open New Project.
  for (;;) {
    const s = await cdp
      .ev(`(() => ({
        href: location.href,
        card: !!document.querySelector('.newprojectcard'),
        menu: !!document.querySelector('[aria-label="New Project"]'),
        input: !!document.querySelector('#projectNameInput'),
        editor: !!document.querySelector('[aria-label="Convert code to Blocks"]'),
      }))()`)
      .catch(() => ({ href: "", card: false, menu: false, input: false, editor: false }));

    if (s.input) break;
    if (s.editor) {
      // Already in an editor (unexpected for a fresh tab, but harmless).
      const projectName = await cdp.ev(`document.querySelector('#fileNameInput2')?.value || ''`).catch(() => "");
      return { projectName: projectName || null, alreadyEditor: true };
    }
    if ((s.card || s.menu) && !openedDialog) {
      const clicked = await cdp
        .ev(`(() => {
          const b = document.querySelector('.newprojectcard') || document.querySelector('[aria-label="New Project"]');
          if (!b) return false;
          b.click();
          return true;
        })()`)
        .catch(() => false);
      debug(`clicked New Project: ${clicked}`);
      if (clicked) openedDialog = true;
    }

    if (Date.now() > deadline) throw new Error("New Project dialog did not appear");
    await sleep(300);
  }

  const setValue = await cdp.ev(`(() => {
    const input = document.querySelector('#projectNameInput');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  debug(`project name input: ${setValue}`);
  if (!setValue) throw new Error("could not set the new project name");

  await sleep(250);
  const create = await cdp.ev(`(() => {
    const b = [...document.querySelectorAll('.ReactModal__Content button, .ui.modal button')]
      .find(x => (x.textContent || '').trim() === 'Create');
    if (!b) return 'no-button';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`).catch(() => "navigated");
  if (create !== "clicked" && create !== "navigated") {
    throw new Error(`could not submit the New Project dialog (${create})`);
  }

  // Clicking Create navigates the tab to #editor; the target id stays the same.
  await waitForEditor(cdp);

  // The hash can settle a moment after the editor DOM appears.
  for (let i = 0; i < 20; i++) {
    const href = await cdp.ev(`location.href`).catch(() => "");
    if (href.includes("#editor")) break;
    await sleep(100);
  }

  const projectName = await cdp.ev(`document.querySelector('#fileNameInput2')?.value || ''`).catch(() => "");
  if (projectName && projectName !== name) {
    warn(`project name is "${projectName}", expected "${name}"`);
  }
  return { projectName: projectName || name };
}

function normalizeWsUrl(page, target) {
  if (!page.webSocketDebuggerUrl) throw new Error("selected target has no webSocketDebuggerUrl");
  const ws = new URL(page.webSocketDebuggerUrl);
  const t = new URL(target.base);
  const loop = ["127.0.0.1", "localhost", "[::1]"];
  if (loop.includes(ws.hostname) && !loop.includes(t.hostname)) ws.host = t.host;
  if (target.secure && ws.protocol === "ws:") ws.protocol = "wss:";
  return ws.toString();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;

    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!m.id || !this.pending.has(m.id)) return;
      const { resolve, reject, timer } = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(timer);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
      else resolve(m.result);
    };

    ws.onclose = () => {
      this.closed = true;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
  }

  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket connect timed out")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket connection failed"));
      };
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async ev(expression, timeoutMs = 30000) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "evaluation failed");
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function listTargets(o) {
  const target = parseCdpTarget(o.cdp);
  const pages = await fetchPages(target);
  const projects = await Promise.all(pages.map((p) => pageProjectName(p)));

  const useHost = o.host || (!o.url && !o.title ? DEFAULT_HOST : null);
  let matches = pages.filter((p) => metadataMatches(p, o, useHost));
  if (o.target) matches = matches.filter((p) => p.id === o.target);
  if (o.project) {
    matches = matches.filter((p) => projects[pages.indexOf(p)] === o.project);
  }

  if (ui.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          cdp: target.base,
          pages: pages.map((p, i) => ({ ...p, projectName: projects[i] })),
          matches: matches.map((p) => p.id),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  out(`Pages on ${target.base}:`);
  if (!pages.length) out("  (none)");
  pages.forEach((p, i) => {
    const mark = matches.includes(p) ? "*" : " ";
    const project = projects[i] ? ` (${projects[i]})` : "";
    out(`${mark} ${i + 1}. [${p.id}]${project} ${p.url}`);
    out(`      ${String(p.title || "").trim()}`);
  });
  if (matches.length > 1) {
    out(`\n${matches.length} tabs match; use --target <id>, --project <name>, or --index <n>.`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// editor helpers
// ---------------------------------------------------------------------------

async function waitForEditor(cdp) {
  const deadline = Date.now() + 30000;
  for (;;) {
    // Do not require `monaco`: it is not defined until the JS view is opened.
    const ok = await cdp
      .ev(`(() =>
        !!document.querySelector('[aria-label="Convert code to Blocks"]') ||
        !!document.querySelector('[aria-label="Convert code to JavaScript"]') ||
        !!document.querySelector('.blocklyDraggable'))()`)
      .catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) {
      throw new Error("MakeCode editor not ready; open https://makecode.microbit.org/#editor");
    }
    await sleep(250);
  }
}

async function dismissDialogs(cdp) {
  const closed = await cdp.ev(`(async () => {
    const done = [...document.querySelectorAll('.ui.modal button, .ui.modal .ui.button, .ReactModal__Content button')]
      .find(b => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (b.textContent || '').trim() === 'Done';
      });
    if (done) done.click();

    const rm = document.querySelector('.ReactModal__Content');
    if (rm) {
      const key = Object.keys(rm).find(k => k.startsWith('__reactFiber$'));
      if (key) {
        let f = rm[key];
        for (let i = 0; f && i < 30; i++, f = f.return) {
          const p = f.memoizedProps;
          if (p && typeof p.onRequestClose === 'function') {
            try { p.onRequestClose(); } catch (e) {}
            break;
          }
        }
      }
    }

    for (let i = 0; i < 25; i++) {
      const m = [...document.querySelectorAll('.ui.modal, .ReactModal__Content')]
        .some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!m) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  })()`);
  return closed;
}

async function modalText(cdp) {
  return cdp.ev(`(() => {
    const m = [...document.querySelectorAll('.ui.modal, .ReactModal__Content')]
      .find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return m ? (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500) : null;
  })()`);
}

async function ensureCodeView(cdp) {  const state = () =>
    cdp.ev(`(() => {
      const m = typeof monaco !== 'undefined' && monaco.editor
        ? monaco.editor.getModels().find(x => x.uri.toString().includes('main.ts'))
        : null;
      return {
        visible: !!document.querySelector('.monaco-editor')?.getBoundingClientRect().width,
        value: m ? m.getValue() : null,
      };
    })()`);

  let s = await state();
  if (s.visible && s.value !== null) return false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const clicked = await cdp.ev(`(() => {
      const b = document.querySelector('[aria-label="Convert code to JavaScript"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error("JavaScript view toggle not found");

    // Wait for the model to exist AND stop changing: `.monaco-editor` becomes
    // visible before a Blocks -> JS conversion has finished rewriting main.ts.
    const deadline = Date.now() + (attempt === 0 ? 15000 : 10000);
    let last = null;
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(200);
      s = await state();
      if (s.visible && s.value !== null) {
        if (s.value === last) {
          if (++stable >= 2) return true;
        } else {
          last = s.value;
          stable = 0;
        }
      }
    }

    // The editor can be busy right after an extension install; the click is
    // sometimes swallowed. Try once more before giving up.
    if (attempt === 0) {
      debug("code view did not appear; retrying the JavaScript toggle");
      await sleep(1000);
      s = await state();
      if (s.visible && s.value !== null) return true;
    }
  }
  throw new Error("code view did not appear");
}

async function ensureBlocksView(cdp) {
  const active = await cdp
    .ev(`/blocks-menuitem selected active/.test(document.querySelector('.blocks-menuitem')?.className || '')`)
    .catch(() => false);
  if (active) return true;

  for (let attempt = 0; attempt < 2; attempt++) {
    await cdp
      .ev(`document.querySelector('[aria-label="Convert code to Blocks"]')?.click()`)
      .catch(() => {});
    for (let i = 0; i < 25; i++) {
      const visible = await cdp
        .ev(`(() => {
          const e = document.querySelector('#blocksEditor');
          return !!e && e.getBoundingClientRect().width > 0;
        })()`)
        .catch(() => false);
      if (visible) return true;
      await sleep(150);
    }
    if (attempt === 0) {
      debug("Blocks view did not appear; retrying the Blocks toggle");
      await sleep(800);
    }
  }
  return false;
}

async function loadSource(cdp, source) {
  await ensureCodeView(cdp);

  const res = await cdp.ev(`(async () => {
    const SRC = ${JSON.stringify(source)};
    const model = monaco.editor.getModels().find(m => m.uri.toString().includes('main.ts'));
    if (!model) throw new Error('main.ts model not found');

    const before = model.getValue();
    model.setValue(SRC);
    model.pushStackElement?.();

    // 1 s settle, then three consecutive empty marker samples (max 10 s).
    let clean = 0;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      if (i >= 5 && monaco.editor.getModelMarkers({}).length === 0) {
        if (++clean >= 3) break;
      } else {
        clean = 0;
      }
    }

    return {
      beforeLen: before.length,
      after: model.getValue(),
      markers: monaco.editor.getModelMarkers({}).map(m => m.message),
    };
  })()`);

  if (res.markers.length) {
    throw new Error(`TypeScript markers: ${res.markers.join(" | ")}`);
  }
  if (res.after.trim() !== source.trim()) {
    throw new Error("read-back did not match the source");
  }
  return res;
}

async function toBlocks(cdp) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await cdp.ev(`(async () => {
      const codeVisible = () => !!document.querySelector('.monaco-editor')?.getBoundingClientRect().width;
      const blockCount = () => document.querySelectorAll('.blocklyDraggable').length;

      // Idempotent: already in Blocks.
      if (!codeVisible() && blockCount() > 0) return { ok: true, blocks: blockCount(), waitedMs: 0 };

      const b = document.querySelector('[aria-label="Convert code to Blocks"]');
      if (!b) return { ok: false, noButton: true };

      b.click();
      for (let i = 0; i < 32; i++) {
        await new Promise(r => setTimeout(r, 250));
        if (!codeVisible() && blockCount() > 0) {
          return { ok: true, blocks: blockCount(), waitedMs: (i + 1) * 250 };
        }
      }

      const m = [...document.querySelectorAll('.ui.modal, .ReactModal__Content')]
        .find(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return {
        ok: false,
        blocks: blockCount(),
        codeVisible: codeVisible(),
        modal: m ? (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300) : null,
      };
    })()`);

    if (r.ok) return r.blocks;
    if (r.noButton) throw new Error("Blocks toggle not found");
    if (attempt === 0 && !r.modal) {
      // The JS -> Blocks click can land while the previous conversion is still
      // settling; give it a moment and try once more.
      debug("Blocks conversion did not complete; retrying once");
      await sleep(600);
    } else {
      throw new Error(`Blocks conversion failed${r.modal ? `: ${r.modal}` : ""}`);
    }
  }
}

async function roundtrip(cdp, source) {
  await ensureCodeView(cdp);
  const r = await cdp.ev(`(() => {
    const m = monaco.editor.getModels().find(x => x.uri.toString().includes('main.ts'));
    if (!m) throw new Error('main.ts model not found');
    return {
      ts: m.getValue(),
      markers: monaco.editor.getModelMarkers({}).map(x => x.message),
    };
  })()`);

  if (r.markers.length) throw new Error(`round-trip markers: ${r.markers.join(" | ")}`);

  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const identical = norm(r.ts) === norm(source);
  await sleep(250);
  const blocks = await toBlocks(cdp);
  return { identical, blocks, ts: r.ts };
}

// ---------------------------------------------------------------------------
// extensions
// ---------------------------------------------------------------------------

// These are present in a fresh micro:bit project; they are dependencies but
// not "extensions" a human added.
const DEFAULT_DEPS = new Set(["core", "radio", "microphone"]);

function extensionSpecNames(spec) {
  const names = new Set();
  const raw = String(spec || "").trim();
  if (!raw) return names;

  if (!/[:/]/.test(raw)) {
    names.add(raw.toLowerCase());
    if (/^pxt-/i.test(raw)) names.add(raw.slice(4).toLowerCase());
    return names;
  }

  const cleaned = raw
    .replace(/^github:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    names.add(`${parts[0]}/${parts[1]}`.toLowerCase());
    const repo = parts[1].toLowerCase();
    names.add(repo);
    if (repo.startsWith("pxt-")) names.add(repo.slice(4));
  } else if (parts.length === 1) {
    names.add(parts[0].toLowerCase());
  }
  return names;
}

function findInstalledDep(deps, spec) {
  const names = extensionSpecNames(spec);
  for (const [name, depSpec] of Object.entries(deps || {})) {
    const keyNames = new Set([name.toLowerCase()]);
    if (/^pxt-/i.test(name)) keyNames.add(name.slice(4).toLowerCase());
    const valueNames = /^(github:|https?:)/i.test(String(depSpec || ""))
      ? extensionSpecNames(depSpec)
      : new Set();
    for (const n of names) {
      if (n && (keyNames.has(n) || valueNames.has(n))) return { name, spec: depSpec };
    }
  }
  return null;
}

function extensionSearchQuery(spec) {
  const raw = String(spec || "").trim();
  if (/^github:/i.test(raw)) {
    return `https://github.com/${raw.replace(/^github:/i, "").replace(/#.*$/, "")}`;
  }
  if (/^https?:\/\//i.test(raw)) return raw.replace(/#.*$/, "");
  if (/^[^/\s]+\/[^/\s]+/.test(raw) && !/\s/.test(raw)) {
    return `https://github.com/${raw.replace(/#.*$/, "")}`;
  }
  return raw;
}

function pickExtensionCard(cards, spec) {
  const names = extensionSpecNames(spec);
  const lower = (s) => String(s || "").toLowerCase();
  const exact = cards.find((c) => names.has(lower(c.name)));
  if (exact) return exact;
  if (/^(https?:|github:)/i.test(spec) && cards.length === 1) return cards[0];
  const contains = cards.filter((c) => [...names].some((n) => n && lower(c.name).includes(n)));
  return contains.length === 1 ? contains[0] : null;
}

async function settingsGoBack(cdp) {
  await cdp.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find(e => (e.textContent || '').trim() === 'Go back');
    if (b) b.click();
    return !!b;
  })()`).catch(() => false);
}

async function openProjectSettingsText(cdp) {
  const r = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    const findButton = (text) => [...document.querySelectorAll('button')]
      .find(e => vis(e) && (e.textContent || '').trim() === text);

    // Leave any open settings view so the text model is reloaded from the project.
    const back = [...document.querySelectorAll('button')].find(e => (e.textContent || '').trim() === 'Go back');
    if (back) { back.click(); await sleep(400); }

    const settings = [...document.querySelectorAll('button')]
      .find(e => vis(e) && e.getAttribute('title') === 'Settings');
    if (!settings) return { ok: false, error: 'Settings button not found' };

    let item = [...document.querySelectorAll('[role="menuitem"]')]
      .find(e => vis(e) && (e.textContent || '').trim() === 'Project Settings');
    for (let attempt = 0; attempt < 2 && !item; attempt++) {
      settings.click();
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        item = [...document.querySelectorAll('[role="menuitem"]')]
          .find(e => vis(e) && (e.textContent || '').trim() === 'Project Settings');
        if (item) break;
      }
      if (!item) await sleep(400);
    }
    if (!item) return { ok: false, error: 'Project Settings menu item not found' };
    item.click();
    await sleep(500);

    let edit = null;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      edit = findButton('Edit settings as text');
      if (edit) break;
    }
    if (edit) {
      edit.click();
      await sleep(400);
      const cont = findButton('Continue');
      if (cont) cont.click();
    }
    return { ok: true };
  })()`, 20000);
  if (!r?.ok) throw new Error(r?.error || "could not open project settings");
}

async function readProjectPackage(cdp) {
  await dismissDialogs(cdp);
  const wasCodeView = await cdp
    .ev(`(() => {
      const js = document.querySelector('[aria-label="Convert code to Blocks"]');
      return !!document.querySelector('.monaco-editor')?.getBoundingClientRect().width && !!js;
    })()`)
    .catch(() => false);
  debug(`reading pxt.json from ${wasCodeView ? "the code view" : "the blocks view"}`);
  await openProjectSettingsText(cdp);

  const raw = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let model = null;
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      const ta = document.querySelector('textarea.inputarea');
      model = typeof monaco !== 'undefined' && monaco.editor
        ? monaco.editor.getModels().find(x => x.uri.toString().includes('pxt.json'))
        : null;
      if (model && ta && /"dependencies"\\s*:/.test(ta.value || '')) break;
    }
    if (!model) return null;
    // Let the settings view finish loading the file before reading it.
    await sleep(1200);
    return model.getValue();
  })()`, 20000);

  await settingsGoBack(cdp);
  await sleep(600);

  if (wasCodeView) {
    const mainIsActive = () =>
      cdp
        .ev(`(() => {
          const ta = document.querySelector('textarea.inputarea');
          const m = typeof monaco !== 'undefined'
            ? monaco.editor.getModels().find(x => x.uri.toString().includes('main.ts'))
            : null;
          return !!(ta && m && ta.value === m.getValue());
        })()`)
        .catch(() => false);
    if (!(await mainIsActive())) {
      await cdp
        .ev(`document.querySelector('[aria-label="Convert code to JavaScript"]')?.click()`)
        .catch(() => {});
      for (let i = 0; i < 20; i++) {
        if (await mainIsActive()) break;
        await sleep(150);
      }
    }
    debug("pxt.json read: restored the code view");
  } else {
    const ok = await ensureBlocksView(cdp);
    debug(`pxt.json read: blocks restore ${ok ? "ok" : "failed"}`);
    const stayed = await cdp
      .ev(`(() => {
        const vis = e => !!(e.offsetWidth || e.offsetHeight);
        const b = [...document.querySelectorAll('button')]
          .find(e => vis(e) && (e.textContent || '').trim() === 'Stay in JavaScript');
        if (b) { b.click(); return true; }
        return false;
      })()`)
      .catch(() => false);
    if (stayed) debug("pxt.json read: stayed in JavaScript after a failed Blocks conversion");
  }

  if (!raw) throw new Error("could not read pxt.json from the editor");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`pxt.json is not valid JSON: ${e.message}`);
  }
  if (!pkg || typeof pkg !== "object" || !pkg.dependencies) {
    throw new Error("pxt.json has no dependencies");
  }
  return { raw, pkg };
}

async function openExtensionsGallery(cdp) {
  const already = await cdp
    .ev(`!!document.querySelector('.extensions-browser')?.offsetWidth`)
    .catch(() => false);
  if (!already) await dismissDialogs(cdp);
  const r = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    const gallery = () => {
      const g = document.querySelector('.extensions-browser');
      return g && vis(g) ? g : null;
    };
    if (gallery()) return { ok: true, already: true };

    let item = [...document.querySelectorAll('[role="menuitem"]')]
      .find(e => vis(e) && (e.textContent || '').trim() === 'Extensions');
    if (!item) {
      const settings = [...document.querySelectorAll('button')]
        .find(e => vis(e) && e.getAttribute('title') === 'Settings');
      if (settings) {
        for (let attempt = 0; attempt < 2 && !item; attempt++) {
          settings.click();
          for (let i = 0; i < 20; i++) {
            await sleep(100);
            item = [...document.querySelectorAll('[role="menuitem"]')]
              .find(e => vis(e) && (e.textContent || '').trim() === 'Extensions');
            if (item) break;
          }
          if (!item) await sleep(400);
        }
      }
    }
    if (item) item.click();

    for (let i = 0; i < 80; i++) {
      await sleep(150);
      if (gallery()) return { ok: true };
    }
    return { ok: false, error: 'extension gallery did not open' };
  })()`, 20000);
  if (!r?.ok) throw new Error(r?.error || "could not open the extension gallery");
}

async function closeExtensionsGallery(cdp) {
  await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    for (let i = 0; i < 40; i++) {
      const g = document.querySelector('.extensions-browser');
      if (!g || !vis(g)) return true;
      const back = [...g.querySelectorAll('button, [role="button"], a')]
        .find(e => vis(e) && /^Go Back$/i.test((e.textContent || '').trim()));
      if (back) { back.click(); await sleep(300); continue; }

      const key = Object.keys(g).find(k => k.startsWith('__reactFiber$'));
      if (key) {
        let f = g[key];
        for (let j = 0; f && j < 30; j++, f = f.return) {
          const p = f.memoizedProps;
          if (p && typeof p.onRequestClose === 'function') {
            try { p.onRequestClose(); } catch (e) {}
            break;
          }
        }
      }
      await sleep(200);
    }
    return false;
  })()`).catch(() => {});
}

async function gallerySearch(cdp, query) {
  const q = String(query ?? "");
  const r = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    const g = document.querySelector('.extensions-browser');
    if (!g || !vis(g)) return { ok: false, error: 'extension gallery is not open' };
    const input = g.querySelector('input.common-input');
    if (!input) return { ok: false, error: 'gallery search input not found' };

    const titles = () => [...g.querySelectorAll('.common-extension-card')]
      .map(c => (c.querySelector('.common-extension-card-title')?.textContent || '').trim());
    const cards = () => [...g.querySelectorAll('.common-extension-card')].map(c => ({
      name: (c.querySelector('.common-extension-card-title')?.textContent || '').trim(),
      description: (c.querySelector('.common-extension-card-description')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      installed: /(^|\\n)Installed(\\n|$)/.test(c.innerText || ''),
      installable: !!c.querySelector('button.common-card-action'),
    }));

    const Q = ${JSON.stringify(q)};
    if (!Q) {
      const tab = [...g.querySelectorAll('.extension-tags .item, .extension-tags [role="tab"], .extension-tags button')]
        .find(e => vis(e) && /^Recommended$/i.test((e.textContent || '').trim()));
      if (tab) tab.click();
      await sleep(800);
      return { ok: true, searched: false, cards: cards() };
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, Q);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
    const pressEnter = () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    };
    pressEnter();

    let searched = false;
    let last = null;
    let stable = 0;
    let empty = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(200);
      if (/Search Results/.test(g.innerText || '')) searched = true;
      if (searched) {
        const t = titles();
        if (t.length === 0) {
          if (++empty >= 8) break;
        } else {
          empty = 0;
          const ready = t.every((x) => !!x);
          if (!ready) {
            last = t;
            stable = 0;
            if (i > 50) break;
          } else if (JSON.stringify(t) === JSON.stringify(last)) {
            if (++stable >= 2) break;
          } else {
            last = t;
            stable = 0;
          }
        }
      }
      if (i === 10 && !searched) pressEnter();
    }
    return { ok: true, searched, cards: cards() };
  })()`, 25000);

  if (!r?.ok) throw new Error(r?.error || "gallery search failed");
  if (q && !r.searched) {
    warn(`gallery search for "${q}" did not report results; using the visible list`);
  }
  return { query: q, searched: !!r.searched, cards: r.cards || [] };
}

async function searchGalleryExtensions(cdp, query) {
  await openExtensionsGallery(cdp);
  try {
    const r = await gallerySearch(cdp, query);
    const cards = r.cards || [];
    const total = cards.length;
    let results = cards;
    if (query) {
      const q = String(query).toLowerCase();
      const score = (name) => {
        const n = String(name || "").toLowerCase();
        if (n === q) return 0;
        if (n.startsWith(q)) return 1;
        if (n.includes(q)) return 2;
        return 3;
      };
      results = [...cards].sort(
        (a, b) => score(a.name) - score(b.name) || String(a.name).localeCompare(String(b.name)),
      );
    }
    const limit = 25;
    return {
      query,
      searched: r.searched,
      total,
      truncated: results.length > limit,
      results: results.slice(0, limit),
    };
  } finally {
    await closeExtensionsGallery(cdp).catch(() => {});
  }
}

async function installExtensionCard(cdp, spec) {
  await openExtensionsGallery(cdp);
  try {
    const search = await gallerySearch(cdp, extensionSearchQuery(spec));
    const card = pickExtensionCard(search.cards, spec);
    if (!card) {
      const candidates = search.cards.slice(0, 10).map((c) => c.name).filter(Boolean);
      throw new Error(
        `extension "${spec}" not found in the gallery` +
          (candidates.length ? `; candidates: ${candidates.join(", ")}` : ""),
      );
    }
    if (card.installed) {
      step(`Extension ${spec} is already shown as installed`);
      return;
    }
    if (!card.installable) throw new Error(`extension "${spec}" is not installable from the gallery`);

    const clicked = await cdp.ev(`(() => {
      const g = document.querySelector('.extensions-browser');
      if (!g) return false;
      const name = ${JSON.stringify(card.name)}.toLowerCase();
      const c = [...g.querySelectorAll('.common-extension-card')]
        .find(x => (x.querySelector('.common-extension-card-title')?.textContent || '').trim().toLowerCase() === name);
      if (!c) return false;
      const b = c.querySelector('button.common-card-action');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`could not click the gallery card for "${spec}"`);

    const closed = await cdp.ev(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const vis = e => !!(e.offsetWidth || e.offsetHeight);
      for (let i = 0; i < 120; i++) {
        await sleep(200);
        const g = document.querySelector('.extensions-browser');
        if (!g || !vis(g)) return { ok: true };
        const modal = [...document.querySelectorAll('.ReactModal__Content, .ui.modal')]
          .find(e => vis(e) && !e.contains(g));
        if (modal) {
          const text = (modal.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
          const btn = [...modal.querySelectorAll('button')]
            .find(e => vis(e) && /^(Add|Continue|OK|Yes|Install)$/i.test((e.textContent || '').trim()));
          if (btn) { btn.click(); continue; }
          return { ok: false, modal: text };
        }
      }
      return { ok: false, modal: null };
    })()`, 30000);
    if (!closed?.ok) {
      throw new Error(`extension install did not finish${closed?.modal ? `: ${closed.modal}` : ""}`);
    }
  } finally {
    await closeExtensionsGallery(cdp).catch(() => {});
  }
}

async function waitForExtension(cdp, spec) {
  let lastPkg = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(600);
    const { pkg } = await readProjectPackage(cdp);
    lastPkg = pkg;
    const hit = findInstalledDep(pkg.dependencies || {}, spec);
    if (hit) return { hit, pkg };
  }
  throw new Error(`extension "${spec}" was not added to pxt.json`);
}

async function ensureExtensions(cdp, specs) {
  specs = [...new Set(specs.map((s) => String(s).trim()).filter(Boolean))];
  const before = await readProjectPackage(cdp);
  const deps = before.pkg.dependencies || {};
  const alreadyPresent = [];
  const pending = [];

  for (const spec of specs) {
    const hit = findInstalledDep(deps, spec);
    if (hit) {
      alreadyPresent.push({ requested: spec, name: hit.name, spec: hit.spec });
      step(`Extension ${spec} already installed (${hit.name})`);
      const tag = String(spec).match(/#([^#]+)$/);
      if (tag && hit.spec && !String(hit.spec).includes(tag[1])) {
        warn(`installed ${hit.name} as ${hit.spec}; requested tag #${tag[1]} was not honored`);
      }
    } else {
      pending.push(spec);
    }
  }

  const added = [];
  let lastPkg = before.pkg;
  for (const spec of pending) {
    step(`Installing extension ${spec}...`);
    await installExtensionCard(cdp, spec);
    const { hit, pkg } = await waitForExtension(cdp, spec);
    lastPkg = pkg;
    added.push({ requested: spec, name: hit.name, spec: hit.spec });
    step(`Installed extension ${spec} -> ${hit.name} ${hit.spec}`);
    const tag = String(spec).match(/#([^#]+)$/);
    if (tag && hit.spec && !String(hit.spec).includes(tag[1])) {
      warn(`installed ${hit.name} as ${hit.spec}; requested tag #${tag[1]} was not honored`);
    }
  }

  return {
    project: lastPkg.name || null,
    requested: specs,
    alreadyPresent,
    added,
    dependencies: lastPkg.dependencies || {},
  };
}

async function openFileExplorer(cdp) {
  const r = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    const toolbar = () => [...document.querySelectorAll('[aria-label="File explorer toolbar"]')].find(vis);
    let item = toolbar();
    if (!item) return { ok: false, error: 'file explorer not found' };
    if (item.getAttribute('aria-expanded') === 'true') return { ok: true, already: true };

    const opts = { bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
    item.dispatchEvent(new PointerEvent('pointerdown', opts));
    item.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    for (let i = 0; i < 40; i++) {
      await sleep(100);
      item = toolbar();
      if (item && item.getAttribute('aria-expanded') === 'true') return { ok: true };
    }
    return { ok: false, error: 'file explorer did not expand' };
  })()`, 15000);
  if (!r?.ok) throw new Error(r?.error || "could not open the file explorer");
}

async function removeExtensionEntry(cdp, name) {
  const r = await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    const target = ${JSON.stringify(name)};
    const visibleModals = () => [...document.querySelectorAll('.ReactModal__Content, .ui.modal')]
      .filter(e => vis(e) && /remove/i.test(e.innerText || '') && /extension/i.test(e.innerText || ''));

    const btn = [...document.querySelectorAll('button')]
      .find(e => vis(e) && e.getAttribute('title') === 'Delete extension ' + target);
    if (!btn) {
      const available = [...document.querySelectorAll('button')]
        .filter(e => vis(e) && /^Delete extension /.test(e.getAttribute('title') || ''))
        .map(e => (e.getAttribute('title') || '').replace(/^Delete extension /, ''));
      return { ok: false, error: 'delete button not found', available };
    }
    btn.click();

    // The editor asks for confirmation: "Remove <name> extension ... Remove it".
    let confirmed = false;
    let modal = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      modal = visibleModals()[0] || null;
      if (!modal) continue;
      const confirm = [...modal.querySelectorAll('button')]
        .find(e => vis(e) && /^(Remove it|Remove)$/i.test((e.textContent || '').trim()));
      if (confirm) {
        confirm.click();
        confirmed = true;
        break;
      }
    }

    if (modal && !confirmed) {
      const cancel = [...modal.querySelectorAll('button')]
        .find(e => vis(e) && /^Cancel$/i.test((e.textContent || '').trim()));
      if (cancel) cancel.click();
      return {
        ok: false,
        error: 'confirmation dialog had no Remove button',
        modal: (modal.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      };
    }

    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if (!visibleModals().length) break;
    }
    return { ok: true, confirmed };
  })()`, 20000);

  if (!r?.ok) {
    if (r?.error === "delete button not found" && r.available?.length) {
      throw new Error(
        `extension "${name}" has no delete button; explorer has: ${r.available.join(", ")}`,
      );
    }
    throw new Error(
      `could not remove extension "${name}"${r?.modal ? `: ${r.modal}` : r?.error ? `: ${r.error}` : ""}`,
    );
  }
  return r;
}

async function waitForRemoval(cdp, name) {
  let lastPkg = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(600);
    const { pkg } = await readProjectPackage(cdp);
    lastPkg = pkg;
    if (!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, name)) {
      return { pkg };
    }
  }
  throw new Error(`extension "${name}" was not removed from pxt.json`);
}

async function stayInJavaScript(cdp) {
  await cdp.ev(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const vis = e => !!(e.offsetWidth || e.offsetHeight);
    for (let i = 0; i < 40; i++) {
      const btn = [...document.querySelectorAll('button')]
        .find(e => vis(e) && (e.textContent || '').trim() === 'Stay in JavaScript');
      if (btn) {
        btn.click();
        await sleep(300);
        return true;
      }
      await sleep(100);
    }
    return false;
  })()`).catch(() => false);
}

async function ensureRemovedExtensions(cdp, specs, { restoreBlocks = false } = {}) {
  specs = [...new Set(specs.map((s) => String(s).trim()).filter(Boolean))];
  const wasCodeView = await cdp
    .ev(`(() => {
      const js = document.querySelector('[aria-label="Convert code to Blocks"]');
      return !!document.querySelector('.monaco-editor')?.getBoundingClientRect().width && !!js;
    })()`)
    .catch(() => false);
  const before = await readProjectPackage(cdp);
  const deps = before.pkg.dependencies || {};
  const removed = [];
  const notPresent = [];
  const pending = [];

  for (const spec of specs) {
    const hit = findInstalledDep(deps, spec);
    if (!hit) {
      notPresent.push({ requested: spec });
      step(`Extension ${spec} is not installed`);
    } else {
      pending.push({ spec, name: hit.name, depSpec: hit.spec });
    }
  }

  let lastPkg = before.pkg;
  for (const item of pending) {
    step(`Removing extension ${item.name}...`);
    await ensureCodeView(cdp);
    await openFileExplorer(cdp);
    await removeExtensionEntry(cdp, item.name);
    const { pkg } = await waitForRemoval(cdp, item.name);
    lastPkg = pkg;
    removed.push({ requested: item.spec, name: item.name, spec: item.depSpec });
    step(`Removed extension ${item.name}`);
  }

  if (restoreBlocks) {
    if (removed.length) {
      try {
        await toBlocks(cdp);
      } catch (e) {
        await stayInJavaScript(cdp);
        warn(
          `removed ${removed.map((r) => r.name).join(", ")} but could not convert back to Blocks; staying in JavaScript. Update code that used the extension.`,
        );
        debug(`Blocks conversion after removal failed: ${e.message}`);
      }
    } else if (!wasCodeView) {
      await ensureBlocksView(cdp);
    }
  }

  return {
    project: lastPkg.name || null,
    requested: specs,
    removed,
    notPresent,
    dependencies: lastPkg.dependencies || {},
  };
}

async function listProjectExtensions(cdp) {
  const { pkg } = await readProjectPackage(cdp);
  const deps = pkg.dependencies || {};
  const entries = Object.entries(deps).map(([name, spec]) => ({
    name,
    spec,
    kind:
      name === "core"
        ? "builtin"
        : DEFAULT_DEPS.has(name)
          ? "default"
          : /^(github:|https?:)/i.test(String(spec))
            ? "gallery"
            : "bundled",
  }));
  return {
    project: pkg.name || null,
    dependencies: deps,
    builtin: entries.filter((e) => e.kind === "builtin").map((e) => e.name),
    defaults: entries.filter((e) => e.kind === "default").map((e) => e.name),
    extensions: entries.filter((e) => e.kind === "gallery" || e.kind === "bundled"),
    entries,
  };
}

function printProjectExtensions(info) {
  out(`Project: ${info.project || "(unnamed)"}`);
  for (const e of info.entries) {
    out(`  ${e.name.padEnd(18)} ${String(e.spec).padEnd(40)} ${e.kind}`);
  }
}

function printGallerySearch(info) {
  out(info.query ? `Extensions matching "${info.query}":` : "Recommended extensions:");
  if (!info.results.length) out("  (none)");
  for (const r of info.results) {
    const mark = r.installed ? "  [installed]" : "";
    out(`  ${String(r.name).padEnd(26)} ${String(r.description || "").slice(0, 70)}${mark}`);
  }
  if (info.truncated) {
    out(`  (showing ${info.results.length} of ${info.total}; refine the query to narrow it down)`);
  }
}

function printInstalledExtensions(info) {
  out(`Project: ${info.project || "(unnamed)"}`);
  for (const a of info.added) out(`  added:     ${a.requested} -> ${a.name} ${a.spec}`);
  for (const a of info.alreadyPresent) out(`  installed: ${a.requested} (${a.name})`);
  if (!info.added.length && !info.alreadyPresent.length) out("  (nothing to do)");
}

function printRemovedExtensions(info) {
  out(`Project: ${info.project || "(unnamed)"}`);
  for (const r of info.removed) out(`  removed:   ${r.requested} (${r.name})`);
  for (const n of info.notPresent) out(`  not found: ${n.requested}`);
  if (!info.removed.length && !info.notPresent.length) out("  (nothing to do)");
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

async function readWorkspaceState(cdp) {
  const state = await cdp.ev(`(async () => {
    const dbNames = (await indexedDB.databases()).map(d => d.name || "");
    const dbName = dbNames.find(n => n.startsWith("__pxt_idb_workspace_microbit"));
    if (!dbName) return { hasWorkspace: false, files: [], historyCount: 0 };

    const open = n => new Promise((ok, no) => {
      const r = indexedDB.open(n);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    const all = s => new Promise((ok, no) => {
      const tx = db.transaction(s, "readonly");
      const r = tx.objectStore(s).getAll();
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });

    const db = await open(dbName);
    const headers = await all("headers").catch(() => []);
    const texts = await all("texts").catch(() => []);
    const header = headers[0] || null;
    const text = texts[0] || null;
    const files = text && text.files ? text.files : {};
    let historyCount = 0;
    try {
      if (files["_history"]) historyCount = (JSON.parse(files["_history"]).entries || []).length;
    } catch (e) {}
    return {
      hasWorkspace: true,
      editor: header && header.editor,
      name: header && header.name,
      modified: header && header.modificationTime,
      files: Object.keys(files),
      ts: files["main.ts"],
      blocks: files["main.blocks"],
      pxt: files["pxt.json"],
      historyCount,
    };
  })()`).catch(() => null);

  if (!state) return { hasWorkspace: false, files: [], historyCount: 0, sessionOnly: true };
  state.sessionOnly = !state.ts && !state.blocks;
  return state;
}

async function readEditorSource(cdp) {
  const wasCodeView = await cdp
    .ev(`(() => {
      const js = document.querySelector('[aria-label="Convert code to Blocks"]');
      return !!document.querySelector('.monaco-editor')?.getBoundingClientRect().width && !!js;
    })()`)
    .catch(() => false);

  const switched = await ensureCodeView(cdp);
  const r = await cdp.ev(`(() => {
    const m = typeof monaco !== 'undefined' && monaco.editor
      ? monaco.editor.getModels().find(x => x.uri.toString().includes('main.ts'))
      : null;
    return {
      ts: m ? m.getValue() : null,
      markers: typeof monaco !== 'undefined' && monaco.editor
        ? monaco.editor.getModelMarkers({}).map(x => x.message)
        : [],
    };
  })()`);

  if (!wasCodeView) await ensureBlocksView(cdp);
  return { ts: r.ts, markers: r.markers || [], switched, startedInCodeView: wasCodeView };
}

function writeSnapshotFiles(dir, files) {
  const outDir = path.resolve(dir);
  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  for (const name of ["main.ts", "main.blocks", "pxt.json"]) {
    const value = files[name];
    if (typeof value === "string" && value.length) {
      const p = path.join(outDir, name);
      fs.writeFileSync(p, value);
      saved.push(p);
    }
  }
  return { dir: outDir, saved };
}

async function snapshotProject(cdp, dir, { fromEditor = false } = {}) {
  const state = await readWorkspaceState(cdp);
  let ts = null;
  let pxtRaw = null;
  let pkg = null;
  let markers = [];
  let switched = false;
  let readFromEditor = false;

  // Prefer the persisted workspace unless the caller wants the live editor.
  if (state.ts && !fromEditor) {
    ts = state.ts;
    pxtRaw = state.pxt || null;
  }

  if (!ts) {
    const pkgInfo = await readProjectPackage(cdp);
    pxtRaw = pkgInfo.raw;
    pkg = pkgInfo.pkg;
    const src = await readEditorSource(cdp);
    ts = src.ts;
    markers = src.markers;
    switched = src.switched;
    readFromEditor = true;
  } else if (!pxtRaw) {
    const pkgInfo = await readProjectPackage(cdp);
    pxtRaw = pkgInfo.raw;
    pkg = pkgInfo.pkg;
  }

  if (!ts) throw new Error("main.ts not found in the workspace or editor");

  let project = pkg?.name || state.name || null;
  if (!project && pxtRaw) {
    try {
      project = JSON.parse(pxtRaw).name || null;
    } catch {
      /* ignore */
    }
  }

  const written = writeSnapshotFiles(dir, {
    "main.ts": ts,
    "main.blocks": state.blocks,
    "pxt.json": pxtRaw,
  });

  if (markers.length) {
    warn(`snapshot has TypeScript markers: ${markers.join(" | ")}`);
  }

  return {
    dir: written.dir,
    project,
    editor: state.editor || null,
    modified: state.modified || null,
    sessionOnly: !!state.sessionOnly,
    files: state.files || [],
    historyCount: state.historyCount || 0,
    tsLen: ts.length,
    blocksLen: (state.blocks || "").length,
    markers,
    readFromEditor,
    switchedToCodeView: switched,
    saved: written.saved,
  };
}

function printSnapshot(info) {
  out(`Project: ${info.project || "(unnamed)"}`);
  out(`saved:   ${info.dir}`);
  for (const p of info.saved) out(`  ${p}`);
  out(`read:    ${info.readFromEditor ? "live editor" : "persisted workspace"}`);
  out(`main.ts: ${info.tsLen} chars${info.blocksLen ? `, main.blocks: ${info.blocksLen} chars` : ""}`);
  if (info.sessionOnly) {
    out("session-only workspace: main.blocks is only in the page; keep the tab open");
  }
  if (info.markers.length) out(`markers: ${info.markers.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// build / download
// ---------------------------------------------------------------------------

function snapshotHex(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith(".hex")) continue;
    try {
      const s = fs.statSync(path.join(dir, f));
      map.set(f, { mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      /* ignore */
    }
  }
  return map;
}

function findNewHex(dir, before) {
  let best = null;
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith(".hex")) continue;
    const p = path.join(dir, f);
    let s;
    try {
      s = fs.statSync(p);
    } catch {
      continue;
    }
    if (s.size < 100_000) continue;
    const b = before.get(f);
    if (!b || s.mtimeMs > b.mtimeMs + 1 || s.size !== b.size) {
      if (!best || s.mtimeMs > best.mtimeMs) best = { file: p, mtimeMs: s.mtimeMs };
    }
  }
  return best?.file || null;
}

async function openHardwareMenu(cdp) {
  return cdp.ev(`(async () => {
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.y > 0; };
    const rows = [...document.querySelectorAll('.ui.item, .item, [role=menuitem]')];
    if (rows.some(e => vis(e) && /^(download|download as file)$/i.test((e.textContent || '').trim()))) {
      return 'already';
    }
    const caret = [...document.querySelectorAll('.ui.dropdown')]
      .find(e => vis(e) && /download|help|connect/i.test(e.textContent || ''));
    if (!caret) return 'missing';
    caret.click();
    return 'opened';
  })()`);
}

async function clickDownloadRow(cdp) {
  const clicked = await cdp.ev(`(() => {
    const i = [...document.querySelectorAll('.ui.item, .item, [role=menuitem]')]
      .find(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.y > 0 &&
          /^(download|download as file)$/i.test((e.textContent || '').trim());
      });
    if (!i) return false;
    i.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Download row not found (modal open or menu not open)");
}

function validateHex(file) {
  if (!fs.existsSync(file)) throw new Error(`hex not found: ${file}`);
  const st = fs.statSync(file);
  if (st.size < 100_000) throw new Error(`hex looks too small: ${file} (${st.size} bytes)`);

  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(1);
    fs.readSync(fd, head, 0, 1, 0);
    if (head.toString("ascii") !== ":") throw new Error(`invalid hex header: ${file}`);

    const tailLen = Math.min(64, st.size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, st.size - tailLen);
    const last = tail.toString("utf8").trim().split(/\r?\n/).pop().trim();
    if (last !== ":00000001FF") throw new Error(`invalid hex terminator: ${file} (${last})`);
  } finally {
    fs.closeSync(fd);
  }
}

async function buildHex(cdp, o) {
  const dir = path.resolve(o.downloadDir);
  fs.mkdirSync(dir, { recursive: true });
  const before = snapshotHex(dir);

  let overridden = false;
  try {
    try {
      await cdp.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: dir,
        eventsEnabled: false,
      });
    } catch {
      await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });
    }

    if (!(await dismissDialogs(cdp))) {
      throw new Error(`could not close an open dialog${(await modalText(cdp)) ? `: ${await modalText(cdp)}` : ""}`);
    }

    let menu = await openHardwareMenu(cdp);
    if (menu === "missing") {
      // Narrow/mobile layout hides the download control; render a desktop viewport.
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1400,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      overridden = true;
      await sleep(700);
      menu = await openHardwareMenu(cdp);
    }
    if (menu === "missing") {
      throw new Error("download control not found; is the MakeCode editor visible?");
    }

    await sleep(900);
    await clickDownloadRow(cdp);

    const t0 = Date.now();
    let file = null;
    while (Date.now() - t0 < o.timeoutMs) {
      file = findNewHex(dir, before);
      if (file) break;

      const text = await modalText(cdp);
      if (text && /error|fail|invalid|syntax|cannot|problem/i.test(text)) {
        throw new Error(`build failed: ${text}`);
      }
      // An unfamiliar error dialog should not stall the full timeout.
      if (text && !/download completed/i.test(text) && Date.now() - t0 > 15000) {
        throw new Error(`build did not produce a hex: ${text}`);
      }
      await sleep(250);
    }
    if (!file) throw new Error(`no .hex after ${o.timeoutMs}ms`);

    // Let the "Download completed" modal appear, then dismiss it.
    await sleep(1800);
    await dismissDialogs(cdp);

    validateHex(file);

    let final = file;
    if (o.hexOut) {
      let dest = path.resolve(o.hexOut);
      if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
        dest = path.join(dest, path.basename(file));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (dest !== path.resolve(file)) fs.copyFileSync(file, dest);
      final = dest;
    }

    return { downloaded: file, final };
  } finally {
    if (overridden) {
      await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// flash
// ---------------------------------------------------------------------------

function resolveDevice(explicit) {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) throw new Error(`device mount not found: ${p}`);
    if (!fs.statSync(p).isDirectory()) throw new Error(`device path is not a directory: ${p}`);
    if (!fs.existsSync(path.join(p, "DETAILS.TXT")) && !fs.existsSync(path.join(p, "MICROBIT.HTM"))) {
      warn(`--device has no DETAILS.TXT/MICROBIT.HTM; assuming it is the MICROBIT mount`);
    }
    return p;
  }

  const user = os.userInfo().username;
  const candidates = [
    `/run/media/${user}/MICROBIT`,
    `/media/${user}/MICROBIT`,
    `/mnt/MICROBIT`,
    `/media/MICROBIT`,
    `/Volumes/MICROBIT`,
  ];

  const marked = candidates.filter(
    (p) =>
      fs.existsSync(p) &&
      fs.statSync(p).isDirectory() &&
      (fs.existsSync(path.join(p, "DETAILS.TXT")) || fs.existsSync(path.join(p, "MICROBIT.HTM"))),
  );
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) {
    throw new Error(`multiple MICROBIT mounts found (${marked.join(", ")}); use --device`);
  }

  const dirs = candidates.filter((p) => fs.existsSync(p) && fs.statSync(p).isDirectory());
  if (dirs.length === 1) return dirs[0];

  throw new Error("MICROBIT volume not found; connect the board or use --device <mount>");
}

async function flashHexFile(hex, device, timeoutMs, progress = step) {
  validateHex(hex);

  const name = path.basename(hex);
  const dest = path.join(device, name);
  const failFile = path.join(device, "FAIL.TXT");
  const hasMarkerFile = () =>
    fs.existsSync(path.join(device, "DETAILS.TXT")) || fs.existsSync(path.join(device, "MICROBIT.HTM"));

  // A custom mount may not expose DETAILS.TXT; then path existence is all we have.
  const markerBased = hasMarkerFile();
  if (!markerBased) warn("device has no DETAILS.TXT/MICROBIT.HTM; using file disappearance as the flash signal");

  fs.rmSync(failFile, { force: true });
  fs.copyFileSync(hex, dest);

  // Flush the file, then ask the OS to flush the device cache.
  try {
    const fd = fs.openSync(dest, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* non-fatal */
  }
  try {
    execFileSync("sync", { stdio: "ignore" });
  } catch {
    /* non-fatal */
  }

  const t0 = Date.now();
  let state = "";
  let seenUnmounted = false;

  for (;;) {
    const ms = Date.now() - t0;

    if (fs.existsSync(failFile)) {
      const reason = fs.readFileSync(failFile, "utf8").trim();
      throw new Error(`DAPLink flashed FAIL.TXT: ${reason || "(empty)"}`);
    }

    const mounted = markerBased ? hasMarkerFile() : fs.existsSync(device);
    const present = fs.existsSync(dest);
    const s = mounted ? (present ? "mounted, hex present" : "mounted, hex gone") : "unmounted";

    if (s !== state) {
      progress(`${ms}ms  ${s}`);
      state = s;
    }

    if (!mounted) seenUnmounted = true;

    const settled =
      mounted && !present && (seenUnmounted || ms > (markerBased ? 5000 : 8000));
    if (settled) {
      progress(`${ms}ms  done: hex consumed, volume remounted`);
      return { ms, seenUnmounted };
    }

    if (ms > timeoutMs) throw new Error(`flash timed out after ${timeoutMs}ms`);
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function readSource(src) {
  if (src === "-") {
    const s = fs.readFileSync(0, "utf8").replace(/^\uFEFF/, "");
    if (!s.trim()) throw new Error("stdin source is empty");
    return s;
  }
  const p = path.resolve(src);
  if (!fs.existsSync(p)) throw new Error(`source not found: ${p}`);
  const s = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  if (!s.trim()) throw new Error(`source is empty: ${p}`);
  return s;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  Object.assign(ui, { json: o.json, quiet: o.quiet, verbose: o.verbose });

  if (o.help) {
    printHelp();
    return 0;
  }
  if (o.version) {
    out(`mbflash ${VERSION}`);
    return 0;
  }
  if (o.skill) {
    const file = new URL("./SKILL.md", import.meta.url);
    try {
      const text = fs.readFileSync(file, "utf8");
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    } catch (e) {
      console.error(`error: could not read SKILL.md: ${e.message}`);
      return 1;
    }
    return 0;
  }
  if (o.list) return await listTargets(o);

  const mode = resolveMode(o);
  const t0 = Date.now();
  const result = { ok: true, mode, warnings: ui.warnings, timings: {} };
  let cdp;

  try {
    if (mode === "flash-hex") {
      const hex = path.resolve(o.flashHex);
      const device = resolveDevice(o.device);
      result.hex = hex;
      result.device = device;
      step(`Flash ${hex} -> ${device}`);
      const t = Date.now();
      await flashHexFile(hex, device, o.waitMs);
      result.timings.flash = Date.now() - t;
      result.timings.total = Date.now() - t0;
    } else {
      const target = parseCdpTarget(o.cdp);
      const pages = await fetchPages(target);
      const readOnlyMode =
        mode === "list-extensions" || mode === "search-extensions" || mode === "snapshot";
      let page = await selectPage(pages, o, {
        allowMissingProject: !!o.project && o.create && !readOnlyMode,
      });
      let created = false;
      let createStart = 0;

      if (!page) {
        createStart = Date.now();
        step(`No tab has project "${o.project}"; creating it...`);
        page = await createNewProjectTab(target, o.project, o, pages);
        created = true;
        result.created = true;
      }

      const wsUrl = normalizeWsUrl(page, target);

      debug(`CDP ${target.base}, browser ${await fetch(`${target.base}/json/version`)
        .then((r) => r.json())
        .then((v) => v.Browser)
        .catch(() => "unknown")}`);
      debug(`tab ${page.id} ${page.url}`);

      cdp = await Cdp.connect(wsUrl);
      if (o.focus) await cdp.send("Page.bringToFront").catch(() => {});

      if (created) {
        await initNewProject(cdp, o.project);
        result.timings.create = Date.now() - createStart;
        step(`Created ${o.project} (${fmt(result.timings.create)})`);
      } else {
        await waitForEditor(cdp);
      }

      if (o.retitle) {
        await cdp.ev(`document.title = 'MakeCode — ' + ${JSON.stringify(o.project)}`).catch(() => {});
      }

      const currentUrl = await cdp.ev(`location.href`).catch(() => page.url);
      const projectName = await cdp
        .ev(`document.querySelector('#fileNameInput2')?.value || ''`)
        .catch(() => "");
      const tabProject = projectName || o.project || null;
      result.tab = { id: page.id, project: tabProject, url: currentUrl };

      if (mode === "snapshot") {
        const t = Date.now();
        const info = await snapshotProject(cdp, o.snapshotDir, {
          fromEditor: o.fromEditor,
        });
        result.snapshot = info;
        result.timings.snapshot = Date.now() - t;
        result.timings.total = Date.now() - t0;
        if (ui.json) console.log(JSON.stringify(result, null, 2));
        else printSnapshot(info);
        return 0;
      }

      if (mode === "list-extensions") {
        const te = Date.now();
        const info = await listProjectExtensions(cdp);
        result.extensions = info;
        result.timings.extensions = Date.now() - te;
        result.timings.total = Date.now() - t0;
        if (ui.json) console.log(JSON.stringify(result, null, 2));
        else printProjectExtensions(info);
        return 0;
      }

      if (mode === "search-extensions") {
        const te = Date.now();
        const info = await searchGalleryExtensions(cdp, o.searchExtensions);
        result.extensions = info;
        result.timings.extensions = Date.now() - te;
        result.timings.total = Date.now() - t0;
        if (ui.json) console.log(JSON.stringify(result, null, 2));
        else printGallerySearch(info);
        return 0;
      }

      if (mode === "switch") {
        if (o.extensions.length) {
          const te = Date.now();
          result.extensions = await ensureExtensions(cdp, o.extensions);
          result.timings.extensions = Date.now() - te;
          printInstalledExtensions(result.extensions);
        }
        if (o.removeExtensions.length) {
          const te = Date.now();
          result.extensions = await ensureRemovedExtensions(cdp, o.removeExtensions, {
            restoreBlocks: true,
          });
          result.timings.extensions = Date.now() - te;
          printRemovedExtensions(result.extensions);
        }
        out(`switched to ${tabProject || page.id} (${page.id})`);
        result.timings.total = Date.now() - t0;
        if (ui.json) console.log(JSON.stringify(result, null, 2));
        return 0;
      }

      if (mode === "install") {
        const te = Date.now();
        result.extensions = await ensureExtensions(cdp, o.extensions);
        result.timings.extensions = Date.now() - te;
        result.timings.total = Date.now() - t0;
        if (ui.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printInstalledExtensions(result.extensions);
          out(`total:  ${fmt(result.timings.total)}`);
        }
        return 0;
      }

      if (mode === "remove") {
        const te = Date.now();
        result.extensions = await ensureRemovedExtensions(cdp, o.removeExtensions, {
          restoreBlocks: true,
        });
        result.timings.extensions = Date.now() - te;
        result.timings.total = Date.now() - t0;
        if (ui.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          printRemovedExtensions(result.extensions);
          out(`total:  ${fmt(result.timings.total)}`);
        }
        return 0;
      }

      if (o.extensions.length) {
        const te = Date.now();
        result.extensions = await ensureExtensions(cdp, o.extensions);
        result.timings.extensions = Date.now() - te;
        printInstalledExtensions(result.extensions);
      }

      if (o.removeExtensions.length) {
        const te = Date.now();
        result.extensions = await ensureRemovedExtensions(cdp, o.removeExtensions);
        result.timings.extensions = Date.now() - te;
        printRemovedExtensions(result.extensions);
      }

      let blocks = null;
      let markers = [];
      let loaded = false;

      if (mode === "load" || mode === "load+build" || mode === "load+build+flash") {
        loaded = true;
        const source = readSource(o.source);
        result.source = o.source === "-" ? "<stdin>" : path.resolve(o.source);
        step(`Loading ${result.source} (${source.length} chars)`);

        const tl = Date.now();
        const r = await loadSource(cdp, source);
        result.timings.load = Date.now() - tl;
        markers = r.markers;
        debug(`loaded ${r.beforeLen} -> ${source.length} chars, markers ${JSON.stringify(markers)}`);

        if (!o.noBlocks) {
          const tb = Date.now();
          blocks = await toBlocks(cdp);
          result.timings.blocks = Date.now() - tb;
          step(`Blocks rebuilt: ${blocks} (${fmt(result.timings.blocks)})`);

          if (o.roundtrip) {
            const tr = Date.now();
            const rt = await roundtrip(cdp, source);
            result.timings.roundtrip = Date.now() - tr;
            result.roundtrip = { identical: rt.identical, blocks: rt.blocks };
            if (!rt.identical) warn("round-trip differs textually; inspect icons/enums");
            step(`Round-trip ${rt.identical ? "identical" : "differs"} (${fmt(result.timings.roundtrip)})`);
          }
        } else {
          step("Skipped Blocks conversion (--no-blocks)");
        }
      }

      if (loaded) result.markers = markers;
      if (blocks !== null) result.blocks = blocks;

      if (mode !== "load") {
        const tb = Date.now();
        const built = await buildHex(cdp, o);
        result.timings.build = Date.now() - tb;
        result.hex = built.final;
        result.downloaded = built.downloaded;
        if (built.final !== built.downloaded) result.hexOut = built.final;
        step(`Built ${built.final} (${fmt(result.timings.build)})`);

        if (mode === "load+build+flash" || mode === "build+flash") {
          const device = resolveDevice(o.device);
          result.device = device;
          const tf = Date.now();
          const f = await flashHexFile(built.final, device, o.waitMs);
          result.timings.flash = Date.now() - tf;
          step(`Flashed ${device} (${fmt(result.timings.flash)}, remounted ${f.seenUnmounted ? "after unmount" : "without observed unmount"})`);
        }
      }
    }

    if (o.retitle && o.project && cdp) {
      await cdp.ev(`document.title = 'MakeCode — ' + ${JSON.stringify(o.project)}`).catch(() => {});
    }

    result.timings.total = Date.now() - t0;

    if (ui.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (ui.quiet) {
      console.log(result.hex || "ok");
    } else {
      out("");
      if (result.source) out(`source: ${result.source}`);
      if (result.downloaded && result.downloaded !== result.hex) out(`downloaded: ${result.downloaded}`);
      if (result.hex) out(`hex:    ${result.hex}`);
      if (result.device) out(`device: ${result.device}`);
      out(`total:  ${fmt(result.timings.total)}`);
      for (const w of ui.warnings) out(`warning: ${w}`);
    }
    return 0;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    result.timings.total = Date.now() - t0;

    if (ui.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`error: ${e.message}`);
    }
    return 1;
  } finally {
    if (cdp) cdp.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`error: ${e.stack || e.message}`);
    process.exit(1);
  });
