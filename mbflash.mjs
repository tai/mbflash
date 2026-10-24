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

const VERSION = "1.2.0";
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
  usage(
    "provide a source file (e.g. mbflash main.ts) or a mode: " +
      "--load-only, --hex-only, --flash-only, --flash-hex",
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

Other:
  -j, --json             machine-readable summary on stdout
  -q, --quiet            suppress progress
  -v, --verbose          more detail
  -h, --help             this help
  -V, --version          print the version

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

async function ensureCodeView(cdp) {
  const state = () =>
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

  const clicked = await cdp.ev(`(() => {
    const b = document.querySelector('[aria-label="Convert code to JavaScript"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error("JavaScript view toggle not found");

  // Wait for the model to exist AND stop changing: `.monaco-editor` becomes
  // visible before a Blocks -> JS conversion has finished rewriting main.ts.
  const deadline = Date.now() + 15000;
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
  throw new Error("code view did not appear");
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
    if (attempt === 0) {
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
      let page = await selectPage(pages, o, { allowMissingProject: !!o.project && o.create });
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

      if (mode === "switch") {
        out(`switched to ${tabProject || page.id} (${page.id})`);
        result.timings.total = Date.now() - t0;
        if (ui.json) console.log(JSON.stringify(result, null, 2));
        return 0;
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
