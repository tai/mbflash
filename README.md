# mbflash

A dependency-free CLI for driving the micro:bit MakeCode editor over CDP:
load TypeScript, commit it to Blocks, compile/download the `.hex`, and flash it
by writing to the `MICROBIT` volume (no WebUSB pairing needed).

```sh
mbflash main.ts
```

That one command:

1. attaches to the MakeCode tab in a CDP-enabled Chromium,
2. loads `main.ts` into the editor and rebuilds the Blocks view,
3. compiles and downloads the `.hex`,
4. copies it to the micro:bit's DAPLink volume and waits for the remount.

## Requirements

- Node.js **22+** (uses the built-in `WebSocket` and `fetch`).
- A headed Chromium/Chrome launched with a debugging port:

  ```sh
  chromium --user-data-dir="$HOME/.config/chromium-agent" \
           --remote-debugging-port=9222 \
           --remote-debugging-address=127.0.0.1 \
           "https://makecode.microbit.org/#editor"
  ```

- One MakeCode tab (the tool refuses ambiguous tabs unless you select one).
- The micro:bit mounted as `MICROBIT` (normally `/run/media/$USER/MICROBIT`).

## Install

From this directory:

```sh
chmod +x mbflash.mjs
ln -sf "$PWD/mbflash.mjs" "$HOME/.local/bin/mbflash"
```

`npm link` also works (`npm link` in this directory). If `~/.local/bin` is not
on `PATH`, add it or invoke `./mbflash.mjs` directly.

## Modes

| Command | What it does |
| --- | --- |
| `mbflash main.ts` | load → Blocks → build → flash |
| `mbflash --load-only main.ts` | load → Blocks (no build/flash) |
| `mbflash --hex-only main.ts` | load → Blocks → build/download (no flash) |
| `mbflash --hex-only` | build/download the code already in the editor |
| `mbflash --flash-only` | build/flash the code already in the editor |
| `mbflash --flash-hex demo.hex` | flash an existing `.hex` (no CDP) |

`--hex-only` with no file is useful when a human has edited Blocks and you just
want a `.hex`. `--flash-only` skips loading but still builds.

## Options

### Target

```sh
mbflash --cdp 9222 main.ts                 # default 127.0.0.1:9222
mbflash --cdp 192.168.1.50:9222 main.ts    # remote Chromium
mbflash --list                             # show page targets
mbflash --target ABCD1234 main.ts          # exact page id
mbflash --index 2 main.ts                  # second match
mbflash --url makecode main.ts             # URL substring or /regex/
mbflash --title "MakeCode" main.ts         # title substring
mbflash --host makecode.microbit.org main.ts
```

The default tab match is the exact hostname `makecode.microbit.org`. If more
than one tab matches, the command fails and lists them; pick one with
`--target` or `--index` (the same rule as the skill: one MakeCode tab only).

### Output / device

```sh
mbflash --download-dir ./build main.ts     # where Chromium writes the .hex
mbflash --hex-out ./demo.hex main.ts       # copy the built hex here
mbflash --device /run/media/$USER/MICROBIT main.ts
mbflash --wait 90 main.ts                  # flash timeout (s)
mbflash --timeout 180 main.ts              # build/editor timeout (s)
```

`--download-dir` defaults to `$XDG_CACHE_HOME/mbflash/hex` (usually
`~/.cache/mbflash/hex`). The new `.hex` is detected without deleting anything
already in that folder. `--hex-out` can be a file or an existing directory.

### Loading

```sh
mbflash --no-blocks main.ts    # load TS only, do not rebuild Blocks
mbflash --roundtrip main.ts    # JS -> Blocks -> JS sanity check
```

`--roundtrip` catches icon/enum loss from the TS → Blocks conversion; a
textual difference is reported as a warning (harmless reformatting is common).

### Automation

```sh
mbflash --json --hex-only main.ts
mbflash --quiet main.ts        # print only the hex path (or "ok")
```

`--json` prints a single object on stdout with `ok`, `mode`, `hex`, `device`,
`markers`, `blocks`, `roundtrip`, `warnings`, and `timings`. On failure it
prints `{ "ok": false, "error": "...", "timings": ... }` and exits non-zero.

## Examples

```sh
# Normal development loop
mbflash main.ts

# Only check that the Blocks conversion works
mbflash --load-only main.ts

# Build a hex for someone else, no board attached
mbflash --hex-only --hex-out ./release.hex main.ts

# Reflash whatever the human has open in Blocks
mbflash --flash-only

# Flash a prebuilt artifact on a machine without a browser
mbflash --flash-hex ./release.hex --device /run/media/$USER/MICROBIT

# A second Chromium on another port
mbflash --cdp 127.0.0.1:9333 --target <id> main.ts
```

## Notes

- **One tab.** MakeCode shares one IndexedDB project per origin. Two tabs
  overwrite each other; the CLI refuses multiple matches by default.
- **Session-only projects.** Some profiles keep the project only in page
  memory. The CLI still works, but the project is lost on reload; keep the
  `main.ts` and `.hex` on disk.
- **V1 vs V2.** The CLI flashes what you give it. V2-only APIs (logo touch,
  `input.soundLevel`, audio) compile for a V1 board and then panic with code
  **927** at boot. Check the board version before using those APIs.
- **Narrow windows.** MakeCode hides the Download control in its mobile
  layout. The CLI temporarily emulates a 1400×900 viewport to reach the menu,
  then clears the override.
- **Flashing** copies the `.hex` to the DAPLink volume and treats “volume
  remounted, hex gone, no `FAIL.TXT`” as success. The copy of the ~1.3 MB
  universal hex is usually the slowest part (~9 s); the flash itself is a few
  seconds.
- **Typical full run** on a demo-sized project: ~2 s load + Blocks, ~4 s build,
  ~15 s flash command (copy + flash), ~21 s total.
- The downloaded filename follows the MakeCode project name; use `--hex-out`
  to give it the name you want.
- **Not a simulator driver.** Like the skill, this tool does not verify
  behaviour in the simulator; the human watches the board.
