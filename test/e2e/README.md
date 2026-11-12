# End-to-end tests and measurements

Scripts that start Min, drive it through the Chrome DevTools Protocol and its main process (Node inspector), and check what happened. Every check that was run by hand or by an agent while building a feature lives here, so nobody has to redo it. AGENTS.md section 13 explains the method, and this file explains how to use it.

## Before you run anything

- **Build first.** The suites run the built app (`main.build.js`, `dist/`), so run `npm run build` after changing code. Packaged runs need `node scripts/buildWindows.js --arch=x64` too.
- **Your profiles are safe.** Each run starts Min with a profile of its own in `%TEMP%\min-e2e-run-*`, deleted afterwards. Runs never touch `%APPDATA%\Min` (the installed browser) or `%APPDATA%\Min-development` (the dev profile). The only exception is a read-only copy of the dev profile's ad-block engine, made once if the cache has none.
- **Runs stop by themselves.** The harness catches main-process errors (otherwise Electron's error dialog freezes main and the run hangs). It also runs a watchdog (main answering, Min alive, every 3 s) and enforces a time limit per suite. Ctrl+C also cleans up.
- **Min's windows appear and take focus.** Don't type into them during a run. Some checks need a visible window (popups, screenshots, frame rates). Windows draws nothing while the screen is locked, and Chromium counts every window as covered while the display is off (an idle computer, AGENTS.md pitfall 54), so those checks fail then. Each result file records `screenLocked` (the lock screen of the Windows session the run is in; another signed-in account's locked session doesn't count) and `display` (`likelyOff` when nobody touched the computer for longer than its display timeout; the run then prints a warning).
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
| `adblock-cosmetic` | the blocker's hiding rules and scriptlets on pages, without the internet (`--host-resolver-rules` maps edition.cnn.com, www.cnn.com and news.example.org to the local server): CNN's rules and scriptlet on a subdomain (pitfall 52), generic rules from the page's classes, ids and links, on an element added later, on a page still arriving (its first part drawn, the rest 1.5 s later: by default the box is hidden once the page is parsed, with `hideAdSpacesWhileLoading` on before), in a background tab only once shown, nothing on a site with blocking off; how long each box showed before it was hidden, frame by frame (info) (14; Chromium's occlusion check off, so an idle display doesn't hide the pages, pitfall 54) | |
| `extensions-core` | installing from `.crx` and unpacked folders through Settings, Web Store ids, lifecycle events, `tabs.*` on Min's tabs, on/off, reload, private tabs, clearing browsing data, restart, removal, zero cost with none installed, Manifest V2 refused (an unpacked folder, and one already installed) (62 checks) | internet |
| `extensions-webstore` | "Add to Chrome" / "Remove from Chrome" on Dark Reader's real store page, signature checks, both update paths, the store API refused elsewhere (30) | internet |
| `extensions-toolbar` | toolbar buttons, popups, menus, options pages, keyboard shortcuts, private tabs (23; test extension `extensions/toolbar`) | visible screen (popup placement, the page's right-click menu) |
| `extensions-real-popups` | Dark Reader's and Bitwarden's real buttons and popups (9) | internet, visible screen |
| `extensions-network` | an extension that filters requests takes over normal tabs from Min's ad blocker, the helper extension's rules, reader view, PDFs, `.user.js` installs (28) | internet |
| `extensions-apis` | the APIs Min adds: screenshots, language, discard, downloads, privacy, identity, side panel, browsingData, search, tts, icons from pixels, `chrome.extension`, Chrome's tab constants, and that a running worker and an offscreen document (test extension `extensions/offscreen`) keep all of it when another extension loads or unloads (42) | visible screen for screenshots |
| `extensions-tabs` | what extensions see of Min's tabs: every tab in Min's order with its place as `index`, hibernated and restored tabs listed as discarded (not reported closed), a woken tab's new id through `tabs.onReplaced`, after a restart too; an extension muting, reloading, activating and going back in a hibernated tab; Min's tab list found the library's internals it uses (13; test extension `extensions/tabs`) | |
| `extensions-passwords` | a password manager extension turning off Min's "save password?" bar (`privacy.services.passwordSavingEnabled`), kept after a restart, back once cleared or removed (8; test extension `extensions/apis`) | |
| `extensions-permissions` | what an extension gets without the permission for it: tabs' addresses and titles only with access, a query by address, tab events, `activeTab` after a click and until the tab leaves the site, cookies refused without the permission and limited to the extension's sites with it, undeclared APIs absent; an extension can't pose as another to main, a website's own service worker gets nothing from the library's bridge, optional permissions (only what the manifest declares, granted through Min's prompt, kept after a restart, removed again), `tabs.captureVisibleTab` only with `activeTab` in effect; Min found the library's internals it checks through (22; test extensions `extensions/unprivileged` and `extensions/cookies-limited`). `node test/e2e/extensions-permissions.js posing` switches off only Min's check of who is asking and expects an extension to get another one's cookies (not in the regression run) | |
| `extensions-startup` | restored tabs wait for extensions, so content scripts run in the first page (3) | internet |
| `extensions-footprint` | idle extensions left alone while Min is in use, trimmed while minimized (4) | internet, visible screen |
| `extensions-youtube` | Return YouTube Dislike and SponsorBlock on a real video (`noblock` argument: with Min's blocking off) | internet |
| `storage-and-passwords` | the Electron version, `storage.sync` shared by worker, content script and popup and kept after a restart, the password store with concurrent saves (9) | |
| `userscripts-basics` | run-at timing, frames, `@exclude`, strict CSP, broken scripts, legacy scripts, manual runs, live reload, private tabs, switching off | |
| `userscripts-functions` | every Greasemonkey function, installs from links and files, updates, edited scripts, the Settings list (opens and closes Notepad) | |
| `userscripts-real` | four real scripts from GitHub installed through the install page, then on YouTube and GitHub | internet |
| `performance-defaults` | Settings → Performance defaults; the JavaScript option adds its flag after a restart; the ad-spaces option (`hideAdSpacesWhileLoading`) reaches the next page's start answer without one | |
| `performance-settings` | background-tab trimming on and off, with Min in use and minimized | visible screen |
| `session-restore` | tabs opened 5 s before are saved: by Quit (and come back), by closing the last window, by Quit with Min's window in the background, and when Windows asks before shutting down (`send-window-message.ps1` sends that question on its own) (5) | |
| `covered-window` | covered windows go idle: visible and half-covered windows draw at 60 fps, a fully covered one draws nothing (hidden, no CPU) and draws again at once when uncovered (6; the cover is `cover-screen.ps1`) | visible screen |
| `electron-workarounds` | whether Min's workarounds for Electron and the extension library are still needed: lifecycle events, `browser`, rulesets, onStartup, putting back the API objects Chromium rebuilds, the `chrome.tabs` constants, Min's tab list for extensions (the library's order, its index numbering, a hibernated tab dropped), and Min's permission checks (the library gives an extension without the permissions every tab's address and every site's cookies, and lets one extension call main in another's name) (12). Run after every Electron or `electron-chrome-extensions` upgrade: a FAIL means something changed and Min's workaround may be able to go. It switches off parts of `js/preload/extensionSupport.js` and the `startExtensionTabSync()` call in `main.build.js` for the run (put back afterwards, even after a crash; `npm run build` first) | |
| `whole-app-trim` | packaged app only: minimized, every process shrinks except a media tab's; records the window's state after minimizing (focused, blur sent), which explains a run where nothing was trimmed (8) | `MIN_TEST_PACKAGED=1` |

`userscripts-basics` and `userscripts-functions` record what they observe. Their checks compare it with `<suite>.expected.json`, the results of a run checked by hand, ignoring timings, ids and dates. When behaviour changes on purpose, rerun with `MIN_TEST_UPDATE_EXPECTED=1` and review the diff of the `.expected.json` before committing it.

## Measurements

These don't pass or fail. They record numbers, and AGENTS.md has the results of earlier runs. Rerun one after a change that could affect it, rather than writing a new one. Run them with the screen unlocked: Min trims background tabs while no window of it is focused, and Speedometer and YouTube need windows that draw.

| Script | Measures | Earlier results |
|---|---|---|
| `measure-ad-blockers.js [rounds]` | no blocking vs Min's blocker vs uBlock Origin Lite: blocking, page weight, load times, CPU, memory, YouTube (about 8 min per run, 6 runs; full uBlock Origin was a fourth setup until Min stopped loading Manifest V2). `measure-ad-blockers-run.js <none\|min\|ubol> <run> <out.json>` does one run and leaves its profile in `%TEMP%\min-e2e-blockers` for a `restart` run; the full runner deletes them | AGENTS.md 10.2 |
| `measure-youtube-ads.js [label]` | YouTube with Min's blocker in a new profile: three videos opened in new tabs, then one click to another video from each; ads seen, time until the video played, whether the page's first player data still had ads; Min's processor time over the run (seconds, % of one core, % of all cores) and memory while each video plays (about 4 min; YouTube rations ads per visitor, so run each build twice; `MIN_TEST_OLD=scriptletsAfterStart` for scriptlets as before 2026-11-09; it doesn't pass `--disable-features=CalculateNativeWinOcclusion`, so keep the display on, pitfall 54) | AGENTS.md 10.2 |
| `measure-ad-slots.js [site ...] [--ubol] [--gpt-stand-in]` | what the comparison's "visible ad slots" are (size, contents, parents), then whether the site's rules with the right domain (A) and the generic rules from the page's classes, ids and links (B) would hide them, inserted as Min inserts CSS; also each stylesheet's selectors Chromium would reject, scrambled ids read from an isolated world (ad recovery), rules per host with Min's and the right domain, and screenshots. `--ubol` installs uBO Lite first; `--gpt-stand-in` tries serving the fake `gpt.js` by DevTools interception (it doesn't reach the page: Min's request hook acts first) (about 3 min) | AGENTS.md 10.2 |
| `measure-generic-cosmetics.js <on\|late\|off> [label]` | what the generic hiding rules cost: seven sites loaded and scrolled, a minute shown, a minute minimized; Min's processor time per phase, the pages' reports and main's time answering them, and per site how long the page was on screen before its first report and the watcher's own time in the page (`genericRulesTiming`, `watcherMsAllSites`; `dist/preload.js` patched for the run to time it); `on` turns `hideAdSpacesWhileLoading` on (the watcher from the page's first bytes), `late` is the default (once the page is parsed, as Ghostery and uBO Lite do); `off` switches them off with `old-behaviour.js`'s `noGenericCosmetics`; Chromium's occlusion check off, as in `adblock-cosmetic` (about 4.5 min a run; alternate on, late, on, late) | AGENTS.md 10.2 |
| `measure-watcher-memory.js <on\|late\|off> [label]` | the same comparison on seven generated pages that are identical every run (about 10,000 elements each, served locally in ten parts 150 ms apart), so the sites' own changes don't drown it: Min's processor time (seconds, % of one core, % of all cores), private memory, working set and the pages' JavaScript heap while loading, a minute shown, a minute minimized; modes as in `measure-generic-cosmetics.js` (about 3 min a run; alternate on, late, off) | AGENTS.md 10.2 |
| `measure-extension-tab-list.js <new\|old> [label]` | what Min's tab list for extensions costs (`main/extensionTabs.js`): with a test extension installed, 15 tabs opened, 40 switches, 10 closed, then a minute idle; processor time (all, main) and memory; `old` turns the tab list off (about 3 min a run) | AGENTS.md 10.9 |
| `measure-minimized-focus.js <new\|old> [label]` | what counting a minimized window as not in use saves when Windows leaves focus on it (emulated): four big pages and a test extension, "trim background tabs while you use Min" off; working set and private memory before and after 80 s minimized (about 3 min a run) | AGENTS.md 10.4 |
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
| `open.js [url]` | opens Min (the dev build, or the packaged app with `MIN_TEST_PACKAGED=1`) with a throwaway profile, to look at it or try a change by hand; its output goes to the terminal, and the profile is deleted when Min closes. Use it instead of `npm start`, which runs on the maintainer's dev profile |
| `extract-crx.js <id \| file.crx> [folder]` | unpacks an extension (from the cache, or downloaded from Chrome's update server) into `results/crx/<id>-<version>` to read its code, with Min's own CRX reader |
| `cover-screen.ps1` | a plain window over every monitor, or over a rectangle, for a few seconds (`covered-window` uses it) |
| `send-window-message.ps1 -Hwnd <number> -Msg <number>` | sends one window message to a window and prints the answer; `session-restore` uses it for `WM_QUERYENDSESSION` (17), what Windows asks every window before shutting down (on its own it ends nothing) |
| `keep-display-on.ps1 -WatchPid <pid>` | keeps the display on until that process ends, as a video player does (`SetThreadExecutionState`; no setting changed); `run.js` starts it for every run (`MIN_TEST_DISPLAY=leave` skips it) and the harness then records `display.keptOn: true` (pitfall 54) |
| `display-state.ps1` | seconds since the last keyboard or mouse input, the display timeout and whether the display has likely turned off (the harness records it in every result file as `display`, AGENTS.md pitfall 54) |
| `old-behaviour.js` | switches changes of the branch `chore/unlocked-remeasure` back to master's behaviour for one run, for measurements: `MIN_TEST_OLD=scriptletsAfterStart,noGenericCosmetics,domainWithoutWWW,noExtensionTabList,minimizedFocusedInUse` (any of them; when the generic rules' watcher starts is the setting `hideAdSpacesWhileLoading` since 2026-11-11, seeded in a run's settings instead); the measurement scripts above call it and record what was switched |
| `compare-results.js "<label>=<regex>" ...` | median [min–max] of every number in the matching result files' measurement, one group per label, to compare runs with a change on and off (how the 2026-11-10 cost figures in `docs/agents` were worked out); lists numbered (`memoryWhilePlaying.0.allMB`), and for `measure-generic-cosmetics.js` a per-site table of first paint, DOMContentLoaded, first report, time drawn before it and the watcher's time |
| `heap-summary.js <file.heapsnapshot>` | summarizes a heap snapshot from `measure-memory.js` |
| `measure-extension-survey.js [--scan] <id>` | one extension instead of the 53: what its code uses (`--scan`: what of it Min lacks), or installed in Min with its errors, popup and options page |

## Everything goes here

Every script that starts Min to check, measure or diagnose something lives in this folder, from its first run, even a quick probe meant to be thrown away. Nobody should have to write a test twice: the next agent can't see your temporary folder or your chat.

- A new check: add it to the suite it concerns, or start a suite (below).
- A diagnostic ("why did this fail?"): add what it records to the suite where the failure showed, as an info check that always passes and keeps the details: `check('… (info)', true, details)`. `whole-app-trim` keeps the window's state after minimizing this way.
- A fix for Electron's or `electron-chrome-extensions`' behaviour: also add a check to `electron-workarounds` that switches Min's fix off and shows the problem is still there.
- Changed behaviour: update the suite (and its `.expected.json`), don't copy it.
- Before you stop, check your scratch or temporary folders for scripts and move what they check here.
- A suite that ends Min itself (closing its last window, say) sets `t.child().quitting = true` first, as `quit()` does: otherwise the watchdog, which looks every 3 s, can report "Min exited unexpectedly" before the suite's next step.

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
- `t.screenshot(connection, file)` and `t.output(file)` write next to the results. A connection's `on(fn)` gets the DevTools events (`Fetch.requestPaused` and the like); `send(method, params)` sends any command.
- `t.patchFile(path, change)` changes a repo file for this run only.
- Add the suite to `REGRESSION` in `run.js` and to the table above.
