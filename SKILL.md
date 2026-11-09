---
name: makecode-microbit
description: >
  Drive the micro:bit MakeCode editor (makecode.microbit.org) from an AI agent
  with mbflash — https://github.com/tai/mbflash — a CLI that loads TypeScript
  into a live MakeCode tab, rebuilds Blocks, builds the .hex, and flashes the
  MICROBIT volume over CDP without WebUSB. Install mbflash before using this
  skill. Use when asked to change MakeCode code, sync text with Blocks, compile
  a .hex, flash a micro:bit, snapshot/read the project back to disk, or
  search/list/install/remove MakeCode extensions before writing code. Triggers:
  MakeCode, micro:bit, mbflash, makecode.microbit.org, main.ts, main.blocks,
  pxt.json, IconNames, Blocks view, MakeCode extension, pxt.json dependency,
  snapshot project, read project back, flash micro:bit, MICROBIT drive, DAPLink,
  Chromium remote debugging, version control of a MakeCode project, panic 927,
  V1/V2 firmware mismatch.
---

# MakeCode (micro:bit) with mbflash

Two actors share one project: a human working in **Blocks** (visual) and an agent
working in **TypeScript** (structural). The project lives in the browser, not on
disk, and the editor is the only thing that can convert between the two.

**mbflash is the bridge between them** — <https://github.com/tai/mbflash>. It
attaches to the MakeCode tab, pushes a `.ts` file into the editor, commits it to
Blocks, compiles/downloads the `.hex`, and flashes it by writing to the
`MICROBIT` volume. It can also search, list, install and remove extensions
through the editor. Do not hand-roll CDP clicks for any of that; mbflash already
does it, including dialog handling, marker polling and remount detection.

Division of labour: the agent proves *it built and flashed* (clean markers,
Blocks rebuilt, `.hex` consumed, volume remounted). The human proves *it
behaves* (they watch the board and the on-screen simulator). Never reverse that.

## Install mbflash first

```sh
command -v mbflash >/dev/null || npm i -g mbflash
mbflash --version        # 1.4.1 or newer
mbflash --skill          # print this document (bundled with mbflash)
```

- Source, releases and full option reference: **https://github.com/tai/mbflash**
- npm package: <https://www.npmjs.com/package/mbflash>
- Requires Node.js **22.4+**. No runtime dependencies. `npx -y mbflash` works
  too, but this skill assumes `mbflash` is on `PATH`.
- If `mbflash --version` is older than 1.4.1, upgrade: `npm i -g mbflash@latest`.
- `mbflash --skill` prints the canonical copy of this file, so it can also be
  installed manually: `mbflash --skill > SKILL.md`.

## What mbflash covers, and what it does not

| Operation | Tool | Notes |
| --- | --- | --- |
| Find tabs, select/create/switch a project | mbflash | `--list`, `--project`, `--target`, `--switch` |
| Write `main.ts` into the editor | mbflash | fails on TypeScript markers |
| Commit TypeScript to Blocks | mbflash | polls until the Blocks view renders |
| Search/list/install/remove extensions | mbflash | `--search-extensions`, `--list-extensions`, `--extension`, `--remove-extension` |
| Compile + download `.hex` | mbflash | drives the caret menu, validates the file |
| Flash the board | mbflash | copies to `MICROBIT`, waits for remount |
| Round-trip check (JS → Blocks → JS) | mbflash | `--roundtrip`, reports textual differences |
| Read the project back out | mbflash | `--snapshot [dir]`, `--from-editor`, `--json` |
| Decide V1 vs V2 | **you** | mbflash cannot detect the board version |
| Verify the program's behaviour | **the human** | never probe the simulator |

There is no compile API or `pxt.workspace` in this MakeCode build. mbflash
triggers the UI build the same way a person would; that is expected, not a
workaround to improve on.

## Golden rules

1. **Snapshot before overwriting.** mbflash writes and flashes; before a
   destructive edit run `mbflash --snapshot .` (§3).
2. **Check the board version before using V2-only APIs.** A V2 API compiles on a
   V1 board and panics **927** at runtime (§2).
3. **One tab per project.** Select with `--project` or `--target`; never guess a
   tab from a URL substring. mbflash matches the hostname and the MakeCode
   project name.
4. **Do not hand-edit inside the browser or click through dialogs** while
   mbflash is working. It brings the tab to the front and drives the UI; a modal
   or a second writer breaks the conversion.
5. **Do not use the main Download button manually.** mbflash opens the hardware
   caret and chooses the file download, which avoids WebUSB flashing.
6. **Never verify behaviour in the simulator.** No screenshots, no LED probing.
   A clean build plus a completed flash proves the pipeline, not that the
   program behaves (or that the board is the right version). The human watches
   the board and the simulator.
7. **Keep `main.ts` on disk as the editing surface**, and keep `main.blocks` and
   `pxt.json` in git when the workspace persists (§7). The browser is not a
   backup: this profile's workspace can be session-only (§3).
8. **Do not rewrite just for cosmetics.** The decompiler re-indents oddly and
   every extra write is another conversion round trip; logically equivalent
   code stays as it is.
9. **Batch by default.** `mbflash main.ts` is the whole pipeline in one process.
   Do not split it into read → write → convert → build → flash calls.
10. **Manage extensions with mbflash.** Use `--extension` and
    `--remove-extension`; do not click the Extensions dialog or the Explorer by
    hand.

## 1. Browser

MakeCode needs a **headed** Chromium with CDP bound to loopback. Use a dedicated
profile so the human's daily browser is untouched:

```sh
chromium --user-data-dir="$HOME/.config/chromium-agent" \
         --remote-debugging-port=9222 \
         --remote-debugging-address=127.0.0.1 \
         "https://makecode.microbit.org/#editor"
```

Verify and inspect tabs with mbflash itself:

```sh
mbflash --list                     # ids, project names, URLs
mbflash --list --json              # same, machine-readable
mbflash --cdp 192.168.1.50:9222 --list
```

- The default CDP endpoint is `127.0.0.1:9222` (`--cdp`, or `MBFLASH_CDP`).
- mbflash brings the selected tab to the front by default. A hidden tab throttles
  page timers to ~1/s (worse after five minutes), which stretches every in-page
  wait; use `--no-focus` only when you deliberately want the window left alone.
- The tab must stay open for the whole run.

## 2. Board version: V1 or V2

The editor's libraries are a **superset**: V2-only APIs type-check and compile
into V1 firmware, then panic when they execute. mbflash cannot detect this; a
successful flash and a clean build are **not** proof of compatibility.

On a V1 board, `input.onLogoEvent` is implemented as
`target_panic(PANIC_VARIANT_NOT_SUPPORTED)` — panic **927**. The board shows the
panic face and scrolls `9 2 7` forever, often before `on start` finishes. The
microphone/audio APIs panic **926** (`PANIC_MICROPHONE_MISSING`). Reflashing does
not help; the transfer already succeeded. Remove the calls.

Identify the board **before** writing code:

| Signal | V1 | V2 |
| --- | --- | --- |
| PCB silkscreen | "V1.5" (no reset button, no mic/speaker) | "V2" (reset button, mic + speaker) |
| DAPLink serial prefix (`DETAILS.TXT` → `ID_SERIAL_SHORT`) | observed `9901` | `9903`/`9904` map to a V2 revision |
| `control.hardwareVersion()` | `1.x` | `2.x` |

If unsure, ask the human for the PCB marking — one question beats a build+flash
cycle. An existing `.hex` can be inspected for its embedded board markers:

```sh
grep -o ':0400000A[0-9A-F]\{8\}' project.hex   # 9900 = V1 image, 9903 = V2 image
```

The build is a universal hex containing both images; DAPLink picks by board, so
the presence of `9903` does not mean the connected board is V2.

V1-safe (verified on a V1.5): `input.lightLevel()`, `input.temperature()`,
`input.rotation(Rotation.Pitch)`, `input.acceleration(Dimension.Strength)`,
`input.onGesture(Gesture.Shake)`, `input.onButtonPressed`,
`input.onPinPressed(TouchPin.P0/P1/P2)`, `led.plotBarGraph`,
`basic.showIcon/showString/showNumber`.

V2-only — do not use on V1: `input.onLogoEvent`, `input.logoIsPressed`,
`input.soundLevel`, microphone/audio/`music` V2 blocks, `pins.touchSetMode`,
sound expressions, `music.setBuiltInSpeakerEnabled(true)`.

A `"microphone": "*"` entry in `pxt.json` is not proof of a V2 target; only the
calls matter.

## Extensions

Use mbflash's extension commands; do not drive the Extensions dialog, the
JavaScript Explorer, or edit `pxt.json` by hand. This path uses only the CDP
browser, with no `pxt`/`mkc` CLI.

```sh
mbflash --project MyProject --list-extensions
mbflash --search-extensions servo
mbflash --project MyProject --extension servo main.ts
mbflash --project MyProject --extension servo --extension neopixel main.ts
mbflash --project MyProject --extension github:microsoft/pxt-max6675 main.ts
mbflash --project MyProject --remove-extension servo --switch
mbflash --project MyProject --remove-extension servo --remove-extension neopixel main.ts
```

- `--extension <spec>` is repeatable and idempotent. It installs missing
  extensions **before** loading `main.ts`, then verifies them in `pxt.json`.
  A new project works in one call:
  `mbflash --project ServoDemo --extension servo main.ts`.
- `--list-extensions` shows the project's dependencies and labels `core` as
  builtin, `radio`/`microphone` as defaults, and the rest as `bundled` or
  `gallery`. Use `--json` when another tool will consume it.
- `--search-extensions <query>` searches the live gallery, ranked by exact
  name, prefix, then substring, and returns up to 25 results. Use `--json` for
  `{ name, description, installed, installable }` entries plus a total count.
- A plain name (`servo`) searches by name. `github:owner/repo` or a GitHub URL
  imports through the gallery and is pinned to the gallery's release (for
  example `github:microsoft/pxt-neopixel#v0.7.6`). A requested `#tag` is
  best-effort; mbflash warns if the gallery chose a different version.
- Gallery names can differ from the installed dependency key: `sonar` installs
  as `pxt-sonar`. Use `--list-extensions` after installing if unsure.
- `--remove-extension <spec>` is repeatable and idempotent. It uses the
  editor's documented removal flow (JavaScript view → Explorer → trash →
  **Remove it**), verifies the dependency is gone from `pxt.json`, and returns
  to Blocks when the remaining code has no TypeScript errors. If the code still
  references the removed extension it stays in JavaScript view and warns; fix
  the code or load a new `main.ts`. Removing an extension that is still in use
  breaks the build. `--extension` and `--remove-extension` are mutually
  exclusive.
- Extension state is session-only like the project: a reload loses it. Pass the
  extension flags on every run (or use a persistent workspace) for reproducible
  builds.
- Installing an extension does **not** make it safe for the board. V2-only
  extensions such as `datalogger` install cleanly on a V1 project and can still
  panic at runtime. The V1/V2 rules in §2 still apply.
- After installing, use the extension's TypeScript API normally, e.g.
  `servos.P0.setAngle(90)`, then let mbflash convert to Blocks and build. If the
  gallery has no match, use the package URL/spec rather than hand-editing
  `pxt.json`.

## 3. Read before writing: `mbflash --snapshot`

`main.ts` on disk is the agent's editing surface, not necessarily the current
project. Before a destructive edit, snapshot the browser state:

```sh
mbflash --list
mbflash --snapshot . --target <id>               # persisted workspace
mbflash --snapshot . --target <id> --from-editor # force the live editor
```

`--snapshot [dir]` writes whichever of `main.ts`, `main.blocks`, `pxt.json` are
available and prints a summary: `editor`, `name`, `modified`, `files`,
`historyCount`, `sessionOnly`, character counts, markers and where it saved.
Add `--json` for the machine-readable form. The directory defaults to `.`.

How to read the result:

- `editor: "blocksprj"` — **Blocks are authoritative**; `main.ts` may be stale,
  but `--snapshot` reads the live editor source when the workspace is
  session-only.
- `editor: "tsprj"` — TypeScript is authoritative.
- `sessionOnly: true` (empty IndexedDB) — the project exists only in page memory
  and is **lost on reload**. `--snapshot` reads `main.ts` from the editor and
  saves it; `main.blocks` is not available in this mode. Tell the human to keep
  the tab open (or sign in to persist), and treat the saved source as the only
  durable copy besides the `.hex`.
- `markers` — TypeScript errors found while reading; they are warnings and the
  files are still written.
- `--from-editor` forces the live editor path even when IndexedDB has a
  persisted copy. Use it after Blocks edits that have not been persisted.
- `--snapshot` restores the Blocks/JavaScript view it started in.

Before replacing a program, keep the old source as `previous-<name>.ts`; the app
history (`_history` in IndexedDB) only helps when the workspace persists.

Do not try to serialize Blockly from the page: this build ships Blockly 10,
where `Blockly.Xml`, `Blockly.common` and `getMainWorkspace` are gone. Use
`--snapshot` (IndexedDB or the JavaScript view). `document.querySelectorAll(".blocklyDraggable").length`
also counts the flyout — treat it as "blocks rendered", not an exact count.

## 4. Write and run

Write `main.ts` with the normal file tools, then hand the whole job to mbflash:

```sh
mbflash main.ts
```

That single process: attaches to the selected tab → loads the TypeScript (fails
on markers) → converts to Blocks → builds/downloads the `.hex` → copies it to the
`MICROBIT` volume and waits for the remount. It prints per-phase timings, the
hex path and any warnings.

With no board attached the build still succeeds and the flash step then fails
with `MICROBIT volume not found`; use `--hex-only` when you only need the file.

Requirements for the source:

- It must be **block-representable** if the human needs the Blocks view: no
  arbitrary classes, no dynamic `require`; keep top-level event handlers and
  plain functions.
- Preserve every human edit you did not intend to change. Diff against the
  snapshot, not against an old file on disk.
- `IconNames` and similar enums survive both directions, including inside
  arrays; grey text fields inside an "array of" block are display only.

Useful variants:

```sh
mbflash --load-only main.ts        # load + Blocks, no build/flash
mbflash --no-blocks main.ts        # load TS only
mbflash --roundtrip main.ts        # load + Blocks + JS round-trip check
mbflash --hex-only main.ts         # build/download, no board needed
mbflash --extension servo main.ts  # install servo, then load/build/flash
mbflash --json main.ts             # single JSON object on stdout
mbflash --quiet main.ts            # only the hex path (or "ok")
```

`--json` emits `ok`, `mode`, `warnings`, `timings`, `tab`, `source`, `markers`,
`blocks`, `roundtrip`, `hex`, `device`, `created` (and `error` on failure). On
failure it exits non-zero and prints the same object with `ok: false`.

### Round-trip and icon fields

`--roundtrip` converts JS → Blocks → JS and compares the result. Harmless
re-indentation is common, so a textual difference is reported as a **warning**,
not a failure; read the warning and inspect enum/icon fields rather than
aborting.

Icon fields can still reset on a TypeScript → Blocks conversion (observed:
`IconNames.Heart` came back as `IconNames.Square` on one build, while an array of
16 icons round-tripped intact). Therefore:

- If the human changed icons in Blocks, ask them to re-check the icons after your
  commit.
- Run `--roundtrip` whenever an edit touches icons, enums or numeric fields.
- Prefer editing in Blocks for purely visual changes and in TypeScript for
  structural ones.

## 5. Projects, tabs and creation

All MakeCode tabs share a URL and title. mbflash identifies them by CDP target id
and by the **project name** stored in the editor (`#fileNameInput2`), not by the
tab title:

```sh
mbflash --list                          # id + project name per tab
mbflash --project Test1 --switch        # focus Test1, no build
mbflash --project Test1 main.ts         # load/build/flash Test1
mbflash --project Test2 --hex-only      # build Test2's current code
mbflash --project Test3 main.ts         # create Test3 if it does not exist
mbflash --project Test3 --switch --retitle
mbflash --project Test1 --switch --no-create   # error instead of creating
```

- `--project` creates a missing project through the home page's New Project
  dialog (about 2–3 s). `--no-create` turns that into an error.
- `--retitle` only changes the visible tab title to `MakeCode — <project>`; it is
  cosmetic and not used for matching.
- If several tabs match, mbflash lists them and refuses to guess; pick with
  `--target <id>`, `--project <name>` or `--index <n>`.
- Work one project at a time. Keep one tab per project; a second tab on the same
  project is a second writer. When persistent workspaces are enabled, tabs share
  IndexedDB storage, so verify the workspace is not being shared.
- Separate tabs' in-memory projects are independent, but they share origin
  `localStorage`; a reload of a session-only tab loses its project.

## 6. Build, flash and reuse

Default `mbflash main.ts` builds **and** flashes. Use the other modes when the
board is absent or the code is already in the editor:

```sh
mbflash --hex-only --hex-out ./release.hex main.ts   # build for someone else
mbflash --hex-only                                  # build what the human has open
mbflash --flash-only                                # build + flash current editor code
mbflash --flash-hex ./release.hex                   # flash a file, no CDP
```

- `--download-dir` defaults to `~/.cache/mbflash/hex`; the new file is detected
  without deleting older hexes. `--hex-out` accepts a file or a directory.
- `--device` defaults to auto-detection (`/run/media/$USER/MICROBIT`,
  `/media/$USER/MICROBIT`, `/mnt/MICROBIT`, …). With multiple mounts, mbflash
  refuses to guess; pass `--device`.
- `--timeout` (default 120 s) covers build/download; `--wait` (default 60 s)
  covers the flash.
- mbflash validates the hex itself: at least 100 KB, starts with `:`, ends with
  `:00000001FF`. Do not re-implement those checks.

### What a successful flash means

mbflash copies the file, fsyncs, calls `sync`, and waits for the volume to
unmount and remount without the hex. The timeline below starts when the copy
finishes:

```
0 s        copy complete
~1 s       volume unmounts
~4.5–6.5 s volume remounts, .hex gone
```

The copy itself is several seconds for a ~1.3 MB universal hex; the exact
timeline depends on DAPLink firmware. Success = mbflash exits 0: hex consumed,
volume remounted, no `FAIL.TXT`. On failure DAPLink leaves `FAIL.TXT` with the
reason and mbflash exits non-zero.

`ASSERT.TXT`, `DETAILS.TXT` and `MICROBIT.HTM` are factory DAPLink files (dated
2016). They are not errors; do not clean them up or report them.

Flash success still does not prove the program runs. A V1 board accepts a build
that calls V2-only APIs and then panics 927 (§2) — reflashing will not fix it.

## 7. Version control

Keep one directory per project, e.g. `~/Work/makecode/<project>/`:

```
main.ts                  # agent's source of truth on disk
main.blocks              # human's visual truth (Blockly XML), when persisted
pxt.json                 # dependencies + project name
<project>.hex            # the exact firmware that was flashed
previous-<name>.ts       # backup of whatever the program did before replacement
```

- Commit after a successful flash, not after every keystroke.
- MakeCode re-formats TypeScript when decompiling (JSDoc blocks, hoisted
  variables, reordered handlers). Expect noisy diffs; compare with
  `git diff --word-diff` or normalise first.
- `_history` in IndexedDB holds `{entries, snapshots}`; `snapshots[].text` can
  recover a previous state — but only if the workspace persists at all.

## 8. Recovery

If a write clobbers work:

1. Stop writing.
2. If the workspace persists, read `texts.files["_history"].snapshots` for the
   complete previous `main.ts` / `main.blocks` / `pxt.json`, or use the
   `previous-<name>.ts` copy.
3. Restore by writing the snapshot's `main.ts` with mbflash (Blocks are
   regenerated), or restore `main.blocks` and keep the project in Blocks mode.

For a session-only workspace there is no history; the on-disk `main.ts` and the
flashed `.hex` are the only safety nets.

## 9. Gotchas

| Symptom | Cause / fix |
| --- | --- |
| `no tab matched; use --list` | no MakeCode tab at the CDP endpoint, or the hostname filter is wrong. Run `mbflash --list`. |
| `N tabs matched; use --target …` | more than one tab matched; select by `--project`, `--target` or `--index`. |
| `no tab has project "X"; use --list` | `--no-create` was set and the project is missing; drop it or fix the name. |
| `TypeScript markers: …` | the source does not parse; fix it before Blocks conversion. |
| `Blocks conversion failed: <modal>` | invalid TypeScript or an open dialog; close the dialog and retry. |
| `could not close an open dialog` | a modal such as the Connect Device wizard is blocking; close it in the UI (it has no `Done`). |
| `MICROBIT volume not found` | board not mounted; connect it or pass `--device`. |
| `multiple MICROBIT mounts found` | more than one board; pass `--device` explicitly. |
| `flash timed out after 60000ms` | no remount; check the cable/`FAIL.TXT`, or raise `--wait`. |
| `DAPLink flashed FAIL.TXT: …` | DAPLink rejected the image; read the reason on the volume. |
| `build failed: …` | MakeCode compile error or error modal; read the modal text. |
| `no .hex after 120000ms` | build hung or an unexpected dialog is open; raise `--timeout` only after checking. |
| `round-trip differs textually` | warning only, usually reformatting; inspect icons/enums. |
| `extension "X" not found in the gallery` | name differs from the package key; run `--search-extensions X`, then retry with the exact name or a `github:owner/repo` spec. |
| `extension install did not finish` | a gallery dialog is blocking; close it and retry, or search for the exact package name. |
| `could not read pxt.json from the editor` | a modal is blocking the Settings menu; close dialogs and retry. |
| `extension "X" was not added to pxt.json` | the gallery did not commit the dependency; retry the same `--extension` call. |
| `extension "X" has no delete button` | X is not installed, or it is `core` (not removable); run `--list-extensions`, then use `--remove-extension` on a listed dependency. |
| `extension "X" was not removed from pxt.json` | the removal did not commit; retry the same `--remove-extension` call. |
| `confirmation dialog had no Remove button` | a dialog or UI change blocked the removal; inspect it and retry. |
| `could not switch back to Blocks after removal` | the code still references the removed extension; fix it and load `main.ts` again. |
| `gallery search ... did not report results` | warning only; mbflash fell back to the visible list. Use a narrower query or `--json`. |
| Icon changed after an agent write | TS→Blocks conversion reset the field; re-pick it in Blocks. |
| `mbflash --version` prints an old number | outdated install; `npm i -g mbflash@latest`. |
| Board panics: face then scrolling **9 2 7** | `PANIC_VARIANT_NOT_SUPPORTED` — V2-only API on V1; remove the calls. |
| Board panics: face then scrolling **9 2 6** | `PANIC_MICROPHONE_MISSING` — microphone API on V1; remove it. |
| Two projects overwrite each other | a second tab on the same project; keep one tab per project. |
| Project vanished after reload | session-only workspace (§3); keep `main.ts` on disk. |
| Tempted to screenshot the simulator | don't; leave behavioural checks to the human. |

## Reference

Everything needed for the workflow is in mbflash; no separate snapshot helper
or old `push`/`to-blocks`/`roundtrip`/`download`/`flash` scripts are required:

```sh
mbflash --list
mbflash --snapshot [dir] [--from-editor] [--json]
```

mbflash uses only Node 22+ built-ins (`fetch`, `WebSocket`) and needs a single
reachable MakeCode tab (`MBFLASH_CDP` overrides the default `127.0.0.1:9222`).
Source, releases and full option reference:
<https://github.com/tai/mbflash>.
