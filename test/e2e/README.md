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
| `adblock-cosmetic` | the blocker's hiding rules and scriptlets on pages, without the internet (`--host-resolver-rules` maps edition.cnn.com, www.cnn.com and news.example.org to the local server): CNN's rules and scriptlet on a subdomain (pitfall 52), generic rules from the page's classes, ids and links, on an element added later, on a page still arriving (its first part drawn, the rest 1.5 s later: by default the box is hidden once the page is parsed, with `hideAdSpacesWhileLoading` on before), in a background tab only once shown, in a frame from another site inside a page (its site's rule and scriptlet, the generic rules; since 2026-11-17), a procedural rule (`:has-text`, also on an element added later; since 2026-11-17), nothing on a site with blocking off nor in frames inside it; how long each box showed before it was hidden, frame by frame (info) (20; `MIN_TEST_OLD=noFrameHiding` or `noProceduralRules` for a comparison; Chromium's occlusion check off, so an idle display doesn't hide the pages, pitfall 54) | |
| `adblock-network` | the blocker's network rules on requests, with Min's real lists and without the internet (names mapped to its own server on port 8794): tracking parameters the lists name (`$removeparam`) removed from a page's address, from a page's `fetch()` (and the page sees the cleaned address) and from a request a page makes, other parameters kept, Min's own list (`utm_source`...) still applied (4). `node test/e2e/adblock-network.js online` also fetches AdGuard's test site's echo address with tracking parameters (info; needs the internet) | |
| `extensions-core` | installing from `.crx` and unpacked folders through Settings, Web Store ids, lifecycle events, `tabs.*` on Min's tabs, on/off, reload, private tabs, clearing browsing data, restart, removal, zero cost with none installed, Manifest V2 refused (an unpacked folder, and one already installed) (62 checks) | internet |
| `extensions-webstore` | "Add to Chrome" / "Remove from Chrome" on Dark Reader's real store page, signature checks, both update paths, the store API refused elsewhere (30) | internet |
| `extensions-toolbar` | toolbar buttons, popups, menus, options pages, keyboard shortcuts, private tabs (23; test extension `extensions/toolbar`) | visible screen (popup placement, the page's right-click menu) |
| `extensions-real-popups` | Dark Reader's and Bitwarden's real buttons and popups (9) | internet, visible screen |
| `extensions-network` | an extension that filters requests takes over normal tabs from Min's ad blocker, the helper extension's rules, reader view, PDFs, `.user.js` installs (28) | internet |
| `extensions-apis` | the APIs Min adds: screenshots, language, discard, downloads, privacy, identity, side panel, browsingData, search, tts, icons from pixels, `chrome.extension`, Chrome's tab constants, and that a running worker and an offscreen document (test extension `extensions/offscreen`) keep all of it when another extension loads or unloads (42) | visible screen for screenshots |
| `extensions-tabs` | what extensions see of Min's tabs: every tab in Min's order with its place as `index`, hibernated and restored tabs listed as discarded (not reported closed), a woken tab's new id through `tabs.onReplaced`, after a restart too; an extension muting, reloading, activating and going back in a hibernated tab; Min's tab list found the library's internals it uses (13; test extension `extensions/tabs`) | |
| `extensions-passwords` | a password manager extension turning off Min's "save password?" bar (`privacy.services.passwordSavingEnabled`), kept after a restart, back once cleared or removed (8; test extension `extensions/apis`) | |
| `extensions-permissions` | what an extension gets without the permission for it: tabs' addresses and titles only with access, a query by address, tab events, `activeTab` after a click and until the tab leaves the site, cookies refused without the permission and limited to the extension's sites with it, undeclared APIs absent; an extension can't pose as another to main, a website's own service worker gets nothing from the library's bridge, optional permissions (only what the manifest declares, granted through Min's prompt, kept after a restart, removed again), `permissions.contains` comparing site patterns as Chrome does, `tabs.captureVisibleTab` only with `activeTab` in effect; Min found the library's internals it checks through (23; test extensions `extensions/unprivileged` and `extensions/cookies-limited`). `node test/e2e/extensions-permissions.js posing` switches off only Min's check of who is asking and expects an extension to get another one's cookies (not in the regression run) | |
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
| `security-checks` | the weaknesses a code review reported on 2026-11-12, each tried for real (it failed on 13 of 14 before the fixes): a website can't open Min's internal pages (address, new tab, popup, frame), the error page's "Try again" doesn't run a `javascript:` address, internal pages don't take settings from other windows, the address bar after a navigation that ends without a page (204), a redirect loop plus a PDF doesn't make main fail, `GM_xmlhttpRequest` redirects stay within `@connect`, the userscript install page installs what it showed and doesn't read local files it's given, extension packages with a `..` version, a second spelling of `manifest.json` or an older update, an offscreen document can't reach Min's raw IPC, the camera inside another site's frame, two sign-in prompts at once; and from the review of upstream's commits (2026-11-24): a popup sent to an internal page right after opening or redirected there (A6), then whether Min still answers Settings once those tabs are closed (a page closing killed the tabs it opened, pitfall 66), a page reading a saved password by faking events on Min's key button (A7), passwords filled or offered for saving on an `http:` page, with a real click on a local page as the control (A8) (25; its own test server on port 8791, crafted extension packages from `make-crx.js`). `node test/e2e/security-checks.js A1 B5` runs only those; `without-navigation-guard B1` switches off A1's guard for that run, to test B1's fix on a route the guard would block | |
| `permissions` | what websites get from the permission manager: notifications refused without the bar on an `http:` page, also when "allow" was saved for the host name, and still asked for on a secure page (localhost) (3; its own server on port 8792, the test host names mapped there with `--host-resolver-rules`) | |
| `popups` | windows pages open, shown as tabs: `window.open(url)` without features gives the page its window (opener, messages both ways, `w.close()`, a name reused), links with `target="_blank"` open in front without an opener, Ctrl+click and middle-click in the background, Shift+click in front (real clicks through the DevTools protocol), a private tab's window private and in its opener's session, also after hibernation; the ad blocker's pop-up rules (a site only the lists' `$popup` rules name, a third-party list rule from another site and from the same one, a third-party rule in `customFilters.txt`); `window.open` without a click (info), tabs a page opened (script, `target="_blank"` link, Ctrl+click) still alive once the page closes (16; its own server on port 8793, test names mapped with `--host-resolver-rules`). `MIN_TEST_OLD=popupsAsNewTabs` puts back the window rule from before 2026-11-17, `MIN_TEST_OLD=noPopupRules` the pop-up rules from before | |
| `popups-real` | sign-in windows on ten real sites: each "Continue with Google / GitHub" button clicked for real, and the sign-in page must open linked to its site (`window.opener`), recording what it shows once loaded (`signInShows`: an email box, or a refusal); nothing is typed and nobody signs in. 2026-11-24: Canva's and Figma's Google sign-in windows show the email box in the dev build with the 2026-11-17 changes; Khan Academy's click opened nothing that time (it had on 2026-11-17). A site that opens its sign-in page in its own tab, changed its page or shows a robot check is recorded as an info check. 2026-11-17: Canva, Figma and Khan Academy open linked Google sign-in windows (also with `MIN_TEST_OLD=popupsAsNewTabs`: they pass a size); Medium, Vercel, Quora, Trello and Replit go to the sign-in page in their own tab; Pinterest's click opened nothing (also before); Notion's button wasn't found. Also: on Wikipedia, two links opened with Ctrl+click and a middle click stay alive with their pages once the page they came from closes (`tabs`), and GitHub's sign-in page gets Min's key button on its password box (`key`; nothing typed). `node test/e2e/popups-real.js canva figma tabs key` runs only those | internet |
| `internal-pages` | Min's own pages and its interface under their security rules (Content-Security-Policy, since 2026-11-24): Settings with a test extension listed, the interface with that extension's toolbar icon (a `data:` image), the new tab page, the error page, the session restore error page, the PDF viewer drawing a PDF, reader view with a `data:` image, the userscript install page, the translation service's real Bergamot worker compiling its WebAssembly; every "Refused to ..." Chromium prints for a `min://` page fails a check (10; its own server on port 8796) | |
| `covered-window` | covered windows go idle: visible and half-covered windows draw at 60 fps, a fully covered one draws nothing (hidden, no CPU) and draws again at once when uncovered (6; the cover is `cover-screen.ps1`) | visible screen |
| `electron-workarounds` | whether Min's workarounds for Electron and the extension library are still needed: lifecycle events, `browser`, rulesets, onStartup, putting back the API objects Chromium rebuilds, the `chrome.tabs` constants, Min's tab list for extensions (the library's order, its index numbering, a hibernated tab dropped), and Min's permission checks (the library gives an extension without the permissions every tab's address and every site's cookies, and lets one extension call main in another's name), and two of Ghostery's ad-block engine, checked in Node (its optimizer merging the generic `$removeparam` rules, a page request never third-party) (14). Run after every Electron, `electron-chrome-extensions` or Ghostery upgrade: a FAIL means something changed and Min's workaround may be able to go. It switches off parts of `js/preload/extensionSupport.js` and the `startExtensionTabSync()` call in `main.build.js` for the run (put back afterwards, even after a crash; `npm run build` first) | |
| `whole-app-trim` | packaged app only: minimized, every process shrinks except a media tab's; records the window's state after minimizing (focused, blur sent), which explains a run where nothing was trimmed (8) | `MIN_TEST_PACKAGED=1` |

`userscripts-basics` and `userscripts-functions` record what they observe. Their checks compare it with `<suite>.expected.json`, the results of a run checked by hand, ignoring timings, ids and dates. When behaviour changes on purpose, rerun with `MIN_TEST_UPDATE_EXPECTED=1` and review the diff of the `.expected.json` before committing it.

## Measurements

These don't pass or fail. They record numbers, and AGENTS.md has the results of earlier runs. Rerun one after a change that could affect it, rather than writing a new one. Run them with the screen unlocked: Min trims background tabs while no window of it is focused, and Speedometer and YouTube need windows that draw.

| Script | Measures | Earlier results |
|---|---|---|
| `measure-adblock-turtlecute.js <min\|none\|ubol>` | adblock.turtlecute.org's test in Min: its score (blocked of 130 checks) and which hosts, decoy ad boxes and decoy scripts got through, with Min's blocker, without blocking or with uBO Lite (results `measure-adblock-turtlecute-<config>-checks.json`); needs the internet |
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
| `measure-extension-survey.js [--scan] [ids...]` | 53 popular extensions: the APIs their code mentions, then each installed in Min with its errors (about an hour for all). `--scan`: only the scan, then every `chrome.*` function they mention that Min lacks, with who mentions it (`-coverage.json`; minutes once the files are cached). A run of some extensions writes `measure-extension-survey-some-*`, and one with `MIN_TEST_OLD` (`old-behaviour.js`, for example `noExtensionPermissionChecks`) adds `-old`, so the full survey's results stay | AGENTS.md 10.9 |

## Tests from other projects

Other browsers' and ad blockers' own test suites, run in Min (2026-11-14). They don't pass or fail as a whole: each records which tests pass, and the docs say which failures are Min's. None is part of `npm run test:e2e`.

| Script | Runs | Earlier results |
|---|---|---|
| `wpt.js setup`, `wpt.js run <min\|electron> [folder or test ...]`, `wpt.js compare` | web-platform-tests (https://wpt.fyi), the standards suite every browser maker shares, in Min and in a bare Electron app with the same Chromium (`wpt-baseline/`, none of Min's code), so a test that passes in the bare app and fails in Min shows something Min's own code changed. `setup` makes a partial copy of the suite in the test cache (the folders Min's code can affect: windows and navigation, scripts, fetch, XMLHttpRequest, service workers, notifications, permissions, fullscreen; about 1,850 test pages) and its manifest; `run` serves it with the suite's own server (Python 3, ports 8000-8002, 8443-8445, 49001-49002; the test domains reach it through `--host-resolver-rules`, Windows' hosts file is left alone) and opens each test in one tab (results `wpt-<app>.json`; a run of some folders or tests replaces only theirs); `compare` lists what fails only in Min (`wpt-compare.json`), marking each test that opens windows. `run <app> @compare` reruns only the tests the last comparison found. A Min run can change one thing, under a label of its own (`wpt-min-<label>.json`, then `compare <label>`): `MIN_WPT_LABEL=<label>` with `MIN_WPT_SETTINGS='{"enableAutoplay":true}'` (settings seeded in the profile) or `MIN_WPT_SWITCH=popupsKeepOpener` (Min's code changed for the run, `main.build.js` put back after). The display is kept on during a run (pitfall 54). About 80 minutes per app for all folders. Tests that need WebDriver (`testdriver.js`: clicks, granting permissions) fail in both | 2026-11-14: 107 of 1,854 pages fail only in Min; 102 open windows (tab-views.md: 99 pass with `popupsKeepOpener`), 3 wait for a muted video to autoplay (settings.md: pass with `enableAutoplay`), 2 ask for notifications on `http:` (permissions.md); two more have a subtest failing because their worker pastes the request headers into JavaScript, which breaks on the quotes in Min's own `Sec-CH-UA` header (`main/UASwitcher.js` sets it on every request; a test quirk) |
| `measure-adguard-testcases.js [group ...]` | AdGuard's filtering test pages (https://testcases.agrd.dev): 51 groups, each with its own small filter list, which the runner turns into Min's saved engine (Min's library and settings) and its side rules (`adblocker-extra-rules.txt`, `js/util/adblockExtraRules.js`) before opening the group's page in Min; every test's result (`measure-adguard-testcases-groups.json`). The pop-up blocker page has no QUnit: each of its tricks is armed with a real click on its button, then the page is clicked, and the trick passes when no tab reaches evilsite.com (mapped to this computer); its "shouldn't be blocked" buttons test AdGuard's own guessing and are recorded, not counted. A part of a group's title runs only those groups. About 20 minutes; needs the internet | docs/agents/ad-blocking.md |
| `measure-adguard-engine.js` | no browser: each AdGuard group's rules split by test case and read with Ghostery's parser as Min builds it (and with procedural rules on), to sort the last run's failures into rules the engine can't read and rules it reads that Min doesn't apply (`measure-adguard-engine.json`) | docs/agents/ad-blocking.md |
| `measure-adblock-lists.js` | no browser: Min's 16 real filter lists read with Ghostery's parser, counting what the engine leaves out (procedural hiding rules Min doesn't turn on, rules it can't read, by kind, with examples; `measure-adblock-lists.json`), and what Min's pop-up rules engine costs to read at start (from the rules file in the test cache); needs the internet | docs/agents/ad-blocking.md |

| `library-tests.js setup`, `library-tests.js [run]` | `electron-chrome-extensions`' own mocha tests (its repository, `samuelmaddock/electron-browser-shell`, at the version Min uses), run with Min's Electron instead of the one the repository names (44): the library alone, in its own small test app, not Min. `setup` clones the repository into the test cache and installs its development packages (about 560, from the internet; Electron's download skipped); `run` builds the library and runs the tests (results `library-tests.json`), without the native messaging ones; `run native-messaging` includes them: their setup registers a test program for Google Chrome in the user's registry (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crx.test`) and a folder (`%APPDATA%\Electron\NativeMessagingHosts`), which the runner removes afterwards, only what wasn't there before, also after a run that was stopped (a state file in the test cache), and checks (`nativeMessagingCleanup`). Rerun after an Electron or library upgrade | 2026-11-24: 66 of 66 pass with `native-messaging` (the maintainer agreed), library 4.10.0 on Electron 45.2.2, 104 s (toolbar buttons 20, tabs 26, menus 6, notifications 5, windows 4, native messaging 2, navigation 1, loading 2); the key and folder removed, Chrome's other hosts and `%APPDATA%\Electron` left as they were |

The library's install needed the maintainer's go-ahead (Claude Code's automatic mode refused it on 2026-11-14 as running code from outside the project; allowed on 2026-11-24). Yarn stopped once with `EEXIST ... electron-chrome-context-menu\node_modules\.bin` on Windows, at its last step: every package the tests need was there, but the `.bin` shortcuts weren't, so the runner calls those tools directly.

## Tools

| Script | Does |
|---|---|
| `open.js [url]` | opens Min (the dev build, or the packaged app with `MIN_TEST_PACKAGED=1`) with a throwaway profile, to look at it or try a change by hand; its output goes to the terminal, and the profile is deleted when Min closes. Use it instead of `npm start`, which runs on the maintainer's dev profile |
| `extract-crx.js <id \| file.crx> [folder]` | unpacks an extension (from the cache, or downloaded from Chrome's update server) into `results/crx/<id>-<version>` to read its code, with Min's own CRX reader |
| `make-crx.js` | builds zip and signed CRX3 files with Node alone (`makeZip`, `makeCrx`, `makeCrxKeys` to sign several versions with one key); used by `security-checks` and the unit tests |
| `cover-screen.ps1` | a plain window over every monitor, or over a rectangle, for a few seconds (`covered-window` uses it) |
| `send-window-message.ps1 -Hwnd <number> -Msg <number>` | sends one window message to a window and prints the answer; `session-restore` uses it for `WM_QUERYENDSESSION` (17), what Windows asks every window before shutting down (on its own it ends nothing) |
| `keep-display-on.ps1 -WatchPid <pid>` | keeps the display on until that process ends, as a video player does (`SetThreadExecutionState`; no setting changed); `run.js` starts it for every run (`MIN_TEST_DISPLAY=leave` skips it) and the harness then records `display.keptOn: true` (pitfall 54) |
| `display-state.ps1` | seconds since the last keyboard or mouse input, the display timeout and whether the display has likely turned off (the harness records it in every result file as `display`, AGENTS.md pitfall 54) |
| `old-behaviour.js` | switches changes of the branch `chore/unlocked-remeasure` back to master's behaviour for one run, for measurements: `MIN_TEST_OLD=scriptletsAfterStart,noGenericCosmetics,domainWithoutWWW,noExtensionTabList,minimizedFocusedInUse,noExtensionPermissionChecks,popupsAsNewTabs,noPopupRules,noFrameHiding,noProceduralRules` (any of them; `noExtensionPermissionChecks` puts extensions' permissions back to unchecked, as before 2026-11-12, and the last four each put back one change of 2026-11-17: the window rule, the lists' pop-up rules, hiding in frames, procedural rules; when the generic rules' watcher starts is the setting `hideAdSpacesWhileLoading` since 2026-11-11, seeded in a run's settings instead); the measurement scripts above call it and record what was switched |
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
