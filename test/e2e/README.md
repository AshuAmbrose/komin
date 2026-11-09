# End-to-end tests and measurements

Scripts that start Min, drive it through the Chrome DevTools Protocol and its main process (Node inspector), and check what happened. Every check that was run by hand or by an agent while building a feature lives here, so nobody has to redo it. AGENTS.md section 13 explains the method, and this file explains how to use it.

## Before you run anything

- **Build first.** The suites run the built app (`main.build.js`, `dist/`), so run `npm run build` after changing code. Packaged runs need `node scripts/buildWindows.js --arch=x64` too.
- **Your profiles are safe.** Each run starts Min with a profile of its own in `%TEMP%\min-e2e-run-*`, deleted afterwards. Runs never touch `%APPDATA%\Min` (the installed browser) or `%APPDATA%\Min-development` (the dev profile). The only exception is a read-only copy of the dev profile's ad-block engine, made once if the cache has none.
- **Runs stop by themselves.** The harness catches main-process errors (otherwise Electron's error dialog freezes main and the run hangs). It also runs a watchdog (main answering, Min alive, every 3 s) and enforces a time limit per suite. Ctrl+C also cleans up.
- **Min's windows appear and take focus.** Don't type into them during a run. Some checks need a visible window (popups, screenshots, frame rates). Windows draws nothing while the screen is locked, so those checks fail then. Each result file records `screenLocked` (the lock screen of the Windows session the run is in; another signed-in account's locked session doesn't count).
- **One run at a time.** The suites use fixed ports: 9333 (DevTools), 9339 (inspector) and 8765–8781 (local test pages).
- **The internet is needed** for real extensions (from Chrome's update server), the Chrome Web Store page, YouTube, GitHub and news sites.
- **Packaged runs** (`MIN_TEST_PACKAGED=1`) start `dist/app/win-unpacked/Min.exe`. Whole-app trimming works by process name, so a packaged run and an installed Min that is running trim each other's memory (harmless, but it skews measurements). Quit the installed Min for clean numbers.

## Running

```bash
npm run test:e2e
```

That runs every regression suite, one after another: about 25 minutes, more the first time while real extensions download. To run only some:

```bash
npm run test:e2e -- extensions-toolbar storage-and-passwords
```

A single suite also runs directly:

```bash
node test/e2e/extensions-toolbar.js
```

Each suite writes `test/e2e/results/<suite>.json` (every check, with details), `<suite>.log` (what Min printed) and any screenshots as `<suite>-*.png`. The `results/` folder isn't committed.

Environment variables:

| Variable | Effect |
|---|---|
| `MIN_TEST_PACKAGED=1` | run the packaged app instead of the dev build |
| `MIN_TEST_KEEP_PROFILE=1` | keep the run's profile folder (its path is printed) |
| `MIN_TEST_UPDATE_EXPECTED=1` | rewrite a suite's `.expected.json` from this run (review the diff) |
| `MIN_TEST_CDP_PORT`, `MIN_TEST_INSPECT_PORT`, `MIN_TEST_PAGE_PORT` | other ports |

Downloads are cached in `%TEMP%\min-e2e-cache`: real extensions' `.crx` files, full uBlock Origin and the ad-block engine. Delete a `.crx` there to test an extension's newest version.

## Regression suites

| Suite | What it checks | Needs |
|---|---|---|
| `adblock-first-start` | a new profile's first start downloads the full ad-block lists and saves the engine (not the small bundled list), and a restart uses the saved engine (6) | internet |
| `extensions-core` | installing from `.crx` and unpacked folders through Settings, Web Store ids, lifecycle events, `tabs.*` on Min's tabs, on/off, reload, private tabs, clearing browsing data, restart, removal, zero cost with none installed, Manifest V2 refused (an unpacked folder, and one already installed) (62 checks) | internet |
| `extensions-webstore` | "Add to Chrome" / "Remove from Chrome" on Dark Reader's real store page, signature checks, both update paths, the store API refused elsewhere (30) | internet |
| `extensions-toolbar` | toolbar buttons, popups, menus, options pages, keyboard shortcuts, private tabs (23; test extension `extensions/toolbar`) | visible screen (popup placement, the page's right-click menu) |
| `extensions-real-popups` | Dark Reader's and Bitwarden's real buttons and popups (9) | internet, visible screen |
| `extensions-network` | an extension that filters requests takes over normal tabs from Min's ad blocker, the helper extension's rules, reader view, PDFs, `.user.js` installs (28) | internet |
| `extensions-apis` | the APIs Min adds: screenshots, language, discard, downloads, privacy, identity, side panel, browsingData, search, tts, icons from pixels, `chrome.extension`, Chrome's tab constants, and that a running worker and an offscreen document (test extension `extensions/offscreen`) keep all of it when another extension loads or unloads (42) | visible screen for screenshots |
| `extensions-startup` | restored tabs wait for extensions, so content scripts run in the first page (3) | internet |
| `extensions-footprint` | idle extensions left alone while Min is in use, trimmed while minimized (4) | internet, visible screen |
| `extensions-youtube` | Return YouTube Dislike and SponsorBlock on a real video (`noblock` argument: with Min's blocking off) | internet |
| `storage-and-passwords` | the Electron version, `storage.sync` shared by worker, content script and popup and kept after a restart, the password store with concurrent saves (9) | |
| `userscripts-basics` | run-at timing, frames, `@exclude`, strict CSP, broken scripts, legacy scripts, manual runs, live reload, private tabs, switching off | |
| `userscripts-functions` | every Greasemonkey function, installs from links and files, updates, edited scripts, the Settings list (opens and closes Notepad) | |
| `userscripts-real` | four real scripts from GitHub installed through the install page, then on YouTube and GitHub | internet |
| `performance-defaults` | Settings → Performance defaults; the JavaScript option adds its flag after a restart | |
| `performance-settings` | background-tab trimming on and off, with Min in use and minimized | visible screen |
| `electron-workarounds` | whether Min's workarounds for Electron and the extension library are still needed: lifecycle events, `browser`, rulesets, onStartup, putting back the API objects Chromium rebuilds, the `chrome.tabs` constants (6). Run after every Electron or `electron-chrome-extensions` upgrade: a FAIL means something changed and Min's workaround may be able to go. It switches off parts of `js/preload/extensionSupport.js` for the run (put back afterwards, even after a crash) | |
| `whole-app-trim` | packaged app only: minimized, every process shrinks except a media tab's; records the window's state after minimizing (focused, blur sent), which explains a run where nothing was trimmed (8) | `MIN_TEST_PACKAGED=1` |

`userscripts-basics` and `userscripts-functions` record what they observe. Their checks compare it with `<suite>.expected.json`, the results of a run checked by hand, ignoring timings, ids and dates. When behaviour changes on purpose, rerun with `MIN_TEST_UPDATE_EXPECTED=1` and review the diff of the `.expected.json` before committing it.

## Measurements

These don't pass or fail. They record numbers, and AGENTS.md has the results of earlier runs. Rerun one after a change that could affect it, rather than writing a new one. Run them with the screen unlocked: Min trims background tabs while no window of it is focused, and Speedometer and YouTube need windows that draw.

| Script | Measures | Earlier results |
|---|---|---|
| `measure-ad-blockers.js [rounds]` | no blocking vs Min's blocker vs uBlock Origin Lite: blocking, page weight, load times, CPU, memory, YouTube (about 8 min per run, 6 runs; full uBlock Origin was a fourth setup until Min stopped loading Manifest V2). `measure-ad-blockers-run.js <none\|min\|ubol> <run> <out.json>` does one run and leaves its profile in `%TEMP%\min-e2e-blockers` for a `restart` run; the full runner deletes them | AGENTS.md 10.2 |
| `measure-javascript-flag.js` | `--optimize-for-size` on vs off: Speedometer 3.1, a local JavaScript test, memory (about 40 min) | AGENTS.md 10.4 |
| `measure-memory.js [label]` | where Min's own memory goes (per process, JS heap, heap snapshots; `heap-summary.js` summarizes a snapshot) | AGENTS.md 10.4 |
| `measure-freeze.js` | freezing background tabs through the DevTools protocol: CPU and memory | AGENTS.md 10.4 |
| `measure-ten-tabs.js` | ten real sites: memory and CPU alive, trimmed, hibernated | AGENTS.md 10.4 |
| `measure-tab-purge.js` | whether background tabs give memory back after GC and a memory-pressure signal | AGENTS.md 10.4 |
| `measure-extension-cost.js` | memory and CPU with no extensions vs three real ones | AGENTS.md 10.9 |
| `measure-extension-survey.js [--scan] [ids...]` | 53 popular extensions: the APIs their code mentions, then each installed in Min with its errors (about an hour for all). `--scan`: only the scan, then every `chrome.*` function they mention that Min lacks, with who mentions it (`-coverage.json`; minutes once the files are cached) | AGENTS.md 10.9 |

## Tools

| Script | Does |
|---|---|
| `extract-crx.js <id \| file.crx> [folder]` | unpacks an extension (from the cache, or downloaded from Chrome's update server) into `results/crx/<id>-<version>` to read its code, with Min's own CRX reader |
| `heap-summary.js <file.heapsnapshot>` | summarizes a heap snapshot from `measure-memory.js` |
| `measure-extension-survey.js [--scan] <id>` | one extension instead of the 53: what its code uses (`--scan`: what of it Min lacks), or installed in Min with its errors, popup and options page |

## Everything goes here

Every script that starts Min to check, measure or diagnose something lives in this folder, from its first run, even a quick probe meant to be thrown away. Nobody should have to write a test twice: the next agent can't see your temporary folder or your chat.

- A new check: add it to the suite it concerns, or start a suite (below).
- A diagnostic ("why did this fail?"): add what it records to the suite where the failure showed, as an info check that always passes and keeps the details: `check('… (info)', true, details)`. `whole-app-trim` keeps the window's state after minimizing this way.
- A fix for Electron's or `electron-chrome-extensions`' behaviour: also add a check to `electron-workarounds` that switches Min's fix off and shows the problem is still there.
- Changed behaviour: update the suite (and its `.expected.json`), don't copy it.
- Before you stop, check your scratch or temporary folders for scripts and move what they check here.

## Writing a suite

Copy a short suite (`performance-defaults.js` or `extensions-toolbar.js`) and keep its shape:

```js
const t = require('./harness')({ name: 'my-suite', minutes: 8 })
const { PAGE, sleep, check, finish, target, launch, quit, ui } = t
;(async () => {
  try {
    const main = await launch(PAGE)          // Min on a local test page; returns the main process connection
    const u = await ui()                     // Min's browser UI (index.html)
    check('something true', await u.evaluate('tabs.get().length') === 1)
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
```

- `main.evaluate(...)` runs code in Min's main process. Use `process.mainModule.require('electron')` there; main's top-level `let`/`const` aren't reachable.
- In the UI, `ipc`, `tabs` and `tasks` are globals, but `settings` isn't (AGENTS.md pitfall 40). Change a setting with `ipc.send('settingChanged', key, value)`, or pass `settings` to the harness for the first start.
- Native dialogs answer "yes" and are recorded in `global.__dialogs`. Native menus are recorded in `global.__menus` instead of shown, and `__clickMenuItem(label)` clicks an item.
- `t.extension(name)` gives a fresh copy of a test extension from `extensions/`. `t.crx(id)` gives a real extension's `.crx`; list its id in `extensions:` so it's downloaded first.
- `t.screenshot(connection, file)` and `t.output(file)` write next to the results.
- `t.patchFile(path, change)` changes a repo file for this run only.
- Add the suite to `REGRESSION` in `run.js` and to the table above.
