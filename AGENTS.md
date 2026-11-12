# AGENTS.md

Context for AI coding agents (and humans) working on this repository. It records facts that are hard to recover from the source, decisions already made, and bugs that were expensive to find.

This file describes the code as of `master` at `e53ee61a` (PR #13: the end-to-end suites in `test/e2e`, the guide's source in `docs/`, this file's split into `docs/agents/`) plus the branch `chore/unlocked-remeasure` (section 0). When the code and this file (or a file in `docs/agents/`) disagree, the code wins. Fix the file in the same change.

---

## 0. Start here

**This file is the core, loaded into every session** (CLAUDE.md imports it). The details live in `docs/agents/`, one file per topic, read when a task needs them. Don't import those into CLAUDE.md: reading them on demand keeps every session about 90 KB (roughly 23,000 tokens) lighter.

**Read sections 0–2 always.** Then read the files your task touches: the subsystem you're changing (section 10 lists them), and as needed the repository map (7), the IPC catalogue (8) and the build system (6), all in `docs/agents/`. Check the pitfalls (14) before testing or debugging.

**Where things stand (2026-11-12):**

- `master` (at `e53ee61a`, PR #13) has the fork's work so far: the permission manager, low-resource mode (trimming, per-tab memory priority, 15-minute hibernation), Ghostery ad blocking, userscripts, Electron 45.2.2 / Chromium 156, Chrome extensions (all seven phases), Settings → Performance, the end-to-end suites in `test/e2e`, and these docs.
- `chore/unlocked-remeasure` (not merged yet) has two agents' work:
  - 2026-11-09 to 11: the measurements a locked screen had spoiled, redone; upstream's two newer commits; and fixes, each with the suite that showed it. YouTube ads on newly loaded pages (the scriptlets now come with the page's start), sites' own hiding rules on addresses without `www.` (pitfall 52), generic hiding rules with the setting `hideAdSpacesWhileLoading` (off by default), Min's own tab list for extensions, password managers turning off Min's "save password?" bar, the session saved at quit (pitfall 50), a minimized window never counting as in use. What each costs, measured on and off, is in sections 10.2, 10.4 and 10.9.
  - 2026-11-12, a review of that work: the session is also saved when Min closes in the background or Windows shuts down (pitfall 56); extensions' permissions are checked for tabs' addresses and cookies, which the extension library gave to every extension (pitfall 55); extensions can act on hibernated tabs; a frame makes one request to main as it starts instead of two (`page-start`).
  - The full record of both, and of earlier branches: `docs/agents/history.md`. Full regression runs: section 13.
- **Now:** the maintainer uses 1.35.9 every day (the build in `dist/app/win-unpacked`, below; it doesn't have that branch yet) and reports bugs; other agents, one at a time, prototype UI changes. Open items are in section 15.

**Working with the maintainer:**

- They're new to browser development. Explain in plain language, say what you measured, and say what you didn't check.
- Commit and push only when asked. They usually test before committing.
- `master` is protected: work on a branch and give them a PR title and description. The GitHub CLI isn't installed on their machine, so they open PRs themselves.
- Their local `package.json` has an uncommitted `"version": "1.35.9"`. Keep it out of commits (stage the other hunks only; the `/release` skill shows how without interactive git).
- **Their everyday Min runs from this repository's build folder.** Their Start-menu shortcut "Min" (made 2026-11-07) opens `dist/app/win-unpacked/Min.exe`, with their real profile (`%APPDATA%\Min`). So packaging (`node scripts/buildWindows.js`) replaces their everyday browser: check it isn't running first (its files would be locked), and tell them it changed. The Squirrel-installed copy (`%LOCALAPPDATA%\min`, shortcut "PalmerAL\Min") is the older 1.35.8. Checked 2026-11-09.
- **Bugs they report happen in their own profile.** Never start Min on it, read it or change it. Ask them for what you need (versions from Settings → Extensions, whether a restart fixes it, a screenshot), and reproduce the bug with a throwaway profile, in the suite it concerns. To see whether their everyday build already has a change, look for it in `dist/app/win-unpacked/resources/app/` (plain files, not an archive), or compare that folder's `main.build.js` date with the commit's.
- Their dev profile (`%APPDATA%\Min-development`) holds their own test data. The suites in `test/e2e` never use it (every run has a throwaway profile); any other script that launches the dev build must back it up and put it back (section 13).
- They have a beginner's guide, "Inside Min", published as a claude.ai artifact on their current Claude account (https://claude.ai/artifact/NxciyPurmBsnmboVChxNr1, published 2026-11-09; an older copy on another account, https://claude.ai/artifact/GKB471fRDS4Sd378KSeN2y, is no longer updated). Its source is `docs/inside-min.html` (an artifact page: no `<html>` or `<head>`, which publishing adds). It mirrors the architecture (section 5 and the files in `docs/agents/`) in plain language. **They asked for it to stay current:** whenever you change the docs with something a beginner should know (new findings, measurements, decisions, not only architecture), update the guide's source in the same change and republish it to that link (the Artifact tool with `url`; read it first). If your tools can't publish there (an agent on another Claude account can't), say so in your report; it isn't a reason to skip the source.

**Working as one of several agents** (one at a time, maybe on different Claude accounts: nothing carries over between you except this repository):

- **Start:** read sections 0–2, then what your task touches. Before building, measuring or trying anything, search this file (sections 14 and 15), the subsystem files in `docs/agents/` (their "Measured…" parts) and `test/e2e/README.md`. If it was measured or tried, use that result. If a script for it exists, rerun it instead of writing a new one.
- **Tests:** every script that starts Min to check, measure or diagnose something lives in `test/e2e`, from the first run, even a quick probe you expect to throw away: the next agent will need it, and a script in a temporary folder or a chat is gone for them. A new check goes into the suite it concerns (extend one, or copy one as a template); a diagnostic becomes an info check there (`check('… (info)', true, details)`, like `whole-app-trim`'s window state); a look at an extension's code uses `test/e2e/extract-crx.js`; a fix for Electron's or the library's behaviour gets a "still needed" check in `electron-workarounds`. When behaviour changes, update the suite (and its `.expected.json`) instead of writing another. Before asking for a commit, run the suites your change touches (or all of `npm run test:e2e`) and report the pass counts, saying which failures came from a locked screen.
- **Looking at the app:** `node test/e2e/open.js [url]` opens it with a throwaway profile, with Min's output in that terminal. Don't run `npm start` yourself: it uses the maintainer's dev profile. When a change is ready for them to try, they run `npm start` themselves.
- **Before you stop**, look in your scratch or temporary folders for any test or diagnostic script and move what it checks into `test/e2e`.
- **Finish:** before you stop, record what changed, what you measured (numbers, date, how), and what you tried and rejected and why: in the subsystem's file in `docs/agents/`, or here when it concerns the whole project. Add what's left to section 15. Update `docs/inside-min.html` if the architecture changed. Nothing important may live only in a chat, a memory note or a temporary folder. Keep "Where things stand" above to a few lines per branch: a branch's full record goes in `docs/agents/history.md`, and its numbers in the subsystem's file.
- **Disagreements:** if these docs and the code disagree, the code wins: fix the docs. If a decision recorded here looks wrong, raise it with the maintainer instead of quietly reversing it.

---

## 1. Critical rules (read these even if you skip the rest)

1. **Never edit generated files**: `main.build.js` and everything in `dist/`. Edit the sources and rebuild (`npm run build`).
2. **`main/*.js` files are not modules.** `scripts/buildMain.js` concatenates them into one script, so top-level declarations are shared globals across files. Don't add `require`/`module.exports` between them. To add a main-process file, add it to the list in `scripts/buildMain.js`.
3. **`js/` (the browser UI) uses browserify `require`, with paths relative to `js/`.** Write `require('tabState.js')` and `require('searchbar/searchbarPlugins.js')`, without a `js/` prefix.
4. **Never load remote web content into the UI view.** The UI view (`index.html`) has `nodeIntegration: true` and `contextIsolation: false`. Websites live in sandboxed `WebContentsView`s created by `main/viewManager.js`.
5. **Electron allows one listener per `webRequest` event per session.** Min already owns these hooks:
   - `onBeforeRequest` in `main/filtering.js`
   - `onBeforeSendHeaders` in `main/UASwitcher.js`
   - `onHeadersReceived` and `onBeforeRedirect` in `main/download.js`

   Add logic to the existing handler, never a second `ses.webRequest.onX(...)`. That is why the ad blocker's CSP headers are applied from `download.js` (`applyFilteringCSPHeaders`).

   While an extension filters normal tabs' requests, all four are removed from `persist:webcontent` (`applyExtensionNetworkFiltering`, section 10.9): any listener there turns off extensions' `webRequest` and `declarativeNetRequest`. A new job in these hooks needs a replacement for that mode too.
6. **Inject ad-block scriptlets only through `injectCosmeticFiltersForSender` in `main/filtering.js`.** Never use Ghostery's `engine.onInjectCosmeticFilters` or `enableBlockingInSession`. Ghostery's injector runs each scriptlet as a separate top-level script. uBlock Origin helpers (`proxyApplyFn`, `safeSelf`, `class JSONPath`) then overwrite each other, and `Function.prototype.toString` recurses forever, which broke YouTube (empty search metadata, frozen Shorts). Our wrapper runs each scriptlet in its own function scope and passes one shared `scriptletGlobals` object. Keep both properties.
7. **Never pass `userGesture: true` to `executeJavaScript` for code that runs in web pages.** It grants the page a user activation, which defeats the popup blocker and the autoplay policy.
8. **Don't hand-roll ad blocking** (ad skippers, playback speed-ups, site-specific ad DOM hacks). The project deliberately reuses uBlock Origin / EasyList rules and Ghostery's engine. If something is broken, fix the integration or the lists. Where Ghostery's packages already have code for a job, use theirs, not a copy: the generic rules' page watcher is Ghostery's `DOMMonitor` (section 10.2), after a hand-written one was replaced.
9. **Keep calls, notifications and messaging working.** No resource optimization may break a tab that is playing audio or video or capturing camera, mic or screen, has notification permission, or holds an active WebSocket.
10. **IPC data must be structured-cloneable.** That means plain objects, arrays, strings and numbers. Don't send functions, DOM nodes, `webContents` or class instances.
11. **Check `isDestroyed()`** before using a `webContents`, `BaseWindow` or `WebContentsView` that might have closed. Note that `windows.getState(win)` throws for a window that has already been removed.
12. **`master` is protected** (changes only through pull requests). Work on a branch; don't push to `master`.

---

## 2. What this project is

- A fork of the **Min** browser (upstream `minbrowser/min`, version 1.35.7), maintained at `AshuAmbrose/komin`. The product name and `package.json` name are still "Min"/"min".
- **Goal:** a low-footprint "second browser" that runs in the background while the user does other things (gaming was only an example). Its own CPU, GPU and RAM use should be as small as possible, but notifications, calls (voice, video, screen share) and messaging must keep working.
  - Key low-footprint behavior off "Min is not in use" (unfocused, minimized or covered by other windows), not off any specific app. Don't add gaming-specific features.
  - A barely noticeable micro-stutter (for example memory paging back in after a trim) is acceptable in exchange for a smaller footprint.
  - Static global caps that hurt normal browsing are unwanted. `max-active-webgl-contexts` was removed for this reason.
- **Public release:** the maintainer plans to release this fork to the public (stated 2026-10-30). That's why extension support aims at any Manifest V3 extension from the Chrome Web Store rather than a chosen few (section 10.9): users will bring their own.
- **Ad blocking** must be MV3-free, reuse existing engines and rules, and block YouTube ads overall. One ad on a tab restored at startup, or after a refresh, is acceptable; a broken page is not.
- **Fork additions over upstream:**
  - a permission manager (prompt bar, site settings, screen-share picker, live capture indicators);
  - low-resource mode (memory trimming, tab hibernation, idle covered windows);
  - Ghostery ad blocking with fresh uBlock Origin / EasyList lists;
  - Tampermonkey-compatible userscripts (Greasemonkey functions, install page, updates, a list in Settings).

## 3. Stack and versions

| Thing | Version / detail |
|---|---|
| Electron | 45.2.2 (`package.json` `electronVersion` and devDependency, pinned exactly), bundling Chromium 156.0.8078.80 and Node 24.22.2. No lockfile is tracked: change both fields, then `npm install` (its postinstall flips the fuse on the new binary). |
| Ad blocking | `@ghostery/adblocker-electron` 2.20.1 (with `@ghostery/adblocker`, `-content`, `-electron-preload`, `-extended-selectors` at the same version; `-content` is also Min's own dependency: its page watcher goes into `dist/preload.js`, section 10.2); `tldts-experimental` 7 (a site's registrable domain, as Ghostery uses it) |
| Extensions | `electron-chrome-extensions` 4.10.0 (MIT, pinned exactly), required only once an extension is enabled (section 10.9) |
| UI bundler | browserify 16 + `electron-renderify` |
| Packaging | electron-builder 24, `electron-installer-windows` (Squirrel), archiver |
| Lint | `standard` 14 (`npm test`), prettier for css/md/html/json (`npm run lint`) |
| Node | CI uses Node 25. Local development worked on Node 22. `.nvmrc` says 15.7.0, which is stale. |
| Platform focus | Windows (x64). `trimMemory.exe` and some optimizations are Windows-only. |

## 4. Commands

```bash
npm install                 # postinstall runs scripts/setupDevEnv.js (flips an Electron fuse on node_modules/electron)
                            # since Electron 42 the binary is downloaded on first use (require('electron'), npx electron), not by npm install
npm start                   # npm run build, then concurrently: scripts/watch.js + `electron . --development-mode`
                            # (on the maintainer's dev profile: agents use node test/e2e/open.js instead)
npm run build               # buildMain + buildBrowser + buildBrowserStyles + buildPreload
npm test                    # lint only (standard)
npm run test:unit           # unit tests (node:test, test/*.test.js): the userscript matcher and the extension package helpers
npm run test:e2e            # end-to-end suites that drive the app (test/e2e/README.md); npm run build first. About 25 min
npm run lint                # REWRITES files (prettier --write, standard --fix)
node scripts/buildWindows.js --arch=x64   # package x64 only (run `npm run build` first)
npm run buildWindows        # build + package x64 and arm64 (slow; Electron 44+ has no 32-bit Windows or ARM Linux builds)
npm run buildWindowsDev     # "Min-Dev" variant with a separate app identity
npm run updateFilters       # refresh ext/filterLists/easylist+easyprivacy-noelementhiding.txt (offline fallback list)
node scripts/buildTrimMemory.js   # rebuild ext/windows/trimMemory.exe from scripts/trimMemory.cs (Windows' built-in C# compiler)
```

**Shipping** (commit, push, PR text, installer): follow `.claude/skills/release/SKILL.md`; in Claude Code, type `/release`. It covers the steps that are easy to get wrong here: the uncommitted version line, the maintainer's everyday Min in `dist/app/win-unpacked`, the packaged checks and Squirrel's version rule.

Development details:

- **Dev profile:** `%APPDATA%\Min-development`. The installed browser uses `%APPDATA%\Min`. Never run experiments against the user's real profile.
- **Reload the UI:** `Alt+Ctrl+R`, dev mode only. It recreates windows; main-process code is *not* reloaded.
- **Main-process changes** need the dev build quit and restarted. `watch.js` rebuilds `main.build.js` but never restarts Electron.
- **Localization edits** need `npm run build`. `watch.js` rebuilds the UI bundle but not `dist/localization.build.js`.
- **DevTools:**
  - UI: "Inspect Browser" `Ctrl+Shift+Alt+I` (dev mode only).
  - Page: `Ctrl+Shift+I` or `F12`.
  - Places service: "Inspect Places Service" in the menu (dev mode only).
- **Main-process `console.log`** output goes to the terminal running `npm start` or `test/e2e/open.js`.

## 5. Architecture

### Processes

| Process | Code | Node.js | Notes |
|---|---|---|---|
| Main (1) | `main.build.js` (from `main/` + a few `js/util` files) | yes | windows, tab views, network hooks, files, menus, permissions |
| Browser UI renderer (1 per window) | `index.html` + `dist/bundle.js` (from `js/`, entry `js/default.js`) + `dist/bundle.css` | yes (`nodeIntegration: true`, `contextIsolation: false`) | trusted; loaded as `min://app/index.html` |
| Tab renderers (about 1 per site, site isolation) | website + `dist/preload.js` | no | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: true` (the preload also runs in iframes) |
| Extension renderers (about 1 per running extension, only when some are enabled) | the extension's background worker and pages + `js/preload/extensionSupportEarly.js`, the library's preload, `js/preload/extensionSupport.js` | no | section 10.9 |
| Places service (1 hidden `BrowserWindow`) | `js/places/placesService.html` | yes | history, bookmarks, full-text index (Dexie / IndexedDB) |
| Translate service (hidden `BrowserWindow`, on demand) | `pages/translateService/` | – | Bergamot WASM translation |
| Prompt windows | `pages/prompt/` via `main/prompt.js` | – | modal text-input dialogs |
| GPU, network service, audio, crashpad | Chromium | – | GPU process is about 200–250 MB |

### Window structure

Each window is built like this (`createWindowWithBounds` in `main/main.js`):

- a frameless `BaseWindow`;
- child view 0: the UI `WebContentsView`, sized to the whole window (`getWindowWebContents(win)` returns its `webContents`);
- child view 1: the selected tab's `WebContentsView`, positioned by bounds the UI sends (`setBounds`).

`setView` removes every child except index 0, then adds the selected view.

Native views are drawn *above* the HTML UI, and HTML can never overlay them. When HTML must cover the page (the address-bar dropdown, the task overlay), the UI hides the view and shows a screenshot: `webviews.requestPlaceholder(reason)` / `webviews.hidePlaceholder(reason)`.

### Startup order

1. **Top-level code in `main/main.js`:**
   - crashReporter, local only (`uploadToServer: false`)
   - `--version` exit
   - Squirrel install/uninstall (calls `registryInstaller`, skipped for dev apps)
   - userData path (gets a `-development` suffix in dev mode or for an unpackaged/dev-named app)
   - `settings.initialize`
   - `js-flags=--optimize-for-size`, only when the setting `optimizeJavaScriptForSize` is true (off by default; read once here, so changing it needs a restart)
   - language
   - `requestSingleInstanceLock`. A second instance forwards its argv to the first and quits. The lock is per profile folder.
2. **`app.on('ready')`:** `registerBundleProtocol(session.defaultSession)`, then `createWindow()`. A separate `app.once('ready')` creates the places-service window.
3. **The UI view** loads `min://app/index.html`. It receives `additionalArguments`: `--user-data-path`, `--app-version`, `--app-name`, `--development-mode`, `--window-id`, `--initial-window`, `--launch-window` and `--initial-task`.
4. **`js/default.js`:**
   - parses those into `window.globalArgs`;
   - defines the globals `electron`, `fs`, `EventEmitter`, `ipc`, `throttle`, `debounce` and `empty`;
   - requires every module and calls its `initialize()`;
   - finally calls `sessionRestore.restore()`.
5. **Ad blocking:** the `settings.listen('filtering')` callback in `filtering.js` calls `setFilteringSettings` → `initFilterList`, which loads the cached engine.

## 6. Build system

In [docs/agents/build-system.md](docs/agents/build-system.md): what each build script makes, the order `scripts/buildMain.js` joins the `main/` files in (and what that means: one shared scope, load order, lint noise) and packaging (electron-builder, the Squirrel installer, the version number). Read it before adding a main-process or preload file, or changing the build or packaging.

## 7. Repository map

In [docs/agents/repository-map.md](docs/agents/repository-map.md): what every file in `main/` and `js/` does, and the other folders (`pages/`, `reader/`, `ext/`, `test/`, `docs/`, `localization/`). Read it to find where something lives before searching blindly.

## 8. IPC catalogue

In [docs/agents/ipc.md](docs/agents/ipc.md): every IPC channel, grouped by direction (UI → main, main → UI, preload → main or UI, UI → page) and by feature, with the file that handles it. Read it before adding or changing a channel.

## 9. Data model (UI)

- **`tasks`** (`TaskList`): `add`, `update`, `get`, `getSelected`, `setSelected`, `destroy`, `getTaskContainingTab`, `isCollapsed`.
  - A task has `id`, `name`, `tabs` (a `TabList`), `tabHistory` (closed tabs), `collapsed` and `selectedInWindow`.
- **`tabs`** (the selected task's `TabList`): `add`, `update(id, data)`, `destroy`, `get(id?)` (**returns copies**, so change tabs through `update`), `getSelected`, `setSelected`, `moveBy`, `splice`.
  - A tab has `url`, `title`, `id`, `lastActivity`, `secure`, `private`, `readerable`, `themeColor`, `backgroundColor`, `scrollPosition`, `selected`, `muted`, `loaded`, `hasAudio`, `previewImage`, `isFileView`, `hasWebContents` and `favicon`.
  - `TabList.temporaryProperties` are not persisted.
- **Events:** `tasks.on(name, fn)`. Names: `task-added`, `task-updated`, `task-selected`, `task-destroyed`, `tab-added`, `tab-updated`, `tab-selected`, `tab-destroyed`, `tab-splice`, `*`. Listeners run batched, asynchronously (`setTimeout(0)`).
- **Changing the model doesn't change the page.** Pair model updates with view calls, as `browserUI.js` does. For example, muting needs `webviews.callAsync(id, 'setAudioMuted', true)` and `tabs.update(id, {muted: true})`.
- **Private tabs** get their own in-memory session (partition = the tab id). Normal tabs use `persist:webcontent`. Use `ses.isPersistent()` to tell them apart.

## 10. Subsystems

Each subsystem has a file of its own in `docs/agents/`. Read the whole file for the subsystem you're changing before you change it. Each one's "Measured…" parts record what was measured, tried and rejected, so search them before measuring or building anything. "Section 10.x" anywhere in the repository means the file below.

**Measured and rejected**, so don't build them without new numbers: asking live tabs to free memory, freezing background tabs, efficiency mode (EcoQoS) for more processes, removing Node.js from the UI or moving the history service into a `SharedWorker`, and `--optimize-for-size` on by default (all in memory-and-background.md); hand-rolled ad blocking (rule 8); Manifest V2 extensions (extensions.md).

| Section | File | Read it when you touch |
|---|---|---|
| 10.1 Tab views | [tab-views.md](docs/agents/tab-views.md) | creating, showing and destroying tab views (`main/viewManager.js`, `js/webviews.js`), page events, popups |
| 10.2 Ad blocking | [ad-blocking.md](docs/agents/ad-blocking.md) | `main/filtering.js`, filter lists, cosmetic filters and scriptlets, YouTube; also the comparison with uBlock Origin and uBO Lite |
| 10.3 Permissions | [permissions.md](docs/agents/permissions.md) | `main/permissionManager.js`, the permission bar, screen sharing, the camera and microphone indicators |
| 10.4 Memory and background behavior | [memory-and-background.md](docs/agents/memory-and-background.md) | memory trimming, memory priority, hibernation, covered windows, anything about Min's footprint; also every footprint measurement and the ideas measured and rejected |
| 10.5 Preload scripts | [preload-scripts.md](docs/agents/preload-scripts.md) | `js/preload/` (code that runs inside web pages) |
| 10.6 Settings | [settings.md](docs/agents/settings.md) | adding or reading a setting; the list of keys in use |
| 10.7 History, session, other services | [history-and-services.md](docs/agents/history-and-services.md) | history and bookmarks (places), session restore, downloads, reader view, PDF, translation, statistics |
| 10.8 Userscripts | [userscripts.md](docs/agents/userscripts.md) | userscripts, their Greasemonkey functions, the install page, updates |
| 10.9 Extensions | [extensions.md](docs/agents/extensions.md) | anything about Chrome extensions: installing, the Web Store, updates, the toolbar, network filtering, the APIs Min adds, what extensions may do without permission, Manifest V2, the known gaps |

## 11. Profile folder (`app.getPath('userData')`)

| Item | Path / notes |
|---|---|
| Installed browser | `%APPDATA%\Min` |
| `npm start` / dev | `%APPDATA%\Min-development` |
| Min-Dev package | `%APPDATA%\Min Dev` (its own identity) |
| Files | `settings.json`, `sessionRestore.json`, `windowBounds.json`, `passwordStore` (safeStorage-encrypted), `adblocker-engine-v2.bin`, optional `customFilters.txt`, `userscripts/`, `userscriptData/` (`scripts.json`, `values/`, `cache/`; section 10.8), `extensions.json` and `extensions/<id>/<version>/` (section 10.9), `tools/` (Bitwarden/1Password CLIs), plus Chromium's own folders (IndexedDB holds history; `Partitions/webcontent` holds normal tabs' data, including extensions' `Local Extension Settings`, `Sync Extension Settings` and `DNR Extension Rules`) |

## 12. Conventions

- **Style:** JavaScript Standard Style. 2 spaces, single quotes, **no semicolons**, a space before function parentheses. Older code uses `var` and `function () {}`; match the file you're editing. Keep comments short, as in the surrounding code.
- **Globals** declared in `package.json` → `standard.globals`: `l`, `tabs`, `tasks`, `globalArgs`, `platformType`, `throttle`, `debounce`, `empty`, and others.
- **User-visible text** goes through `l('key')`, with the English string added to `localization/languages/en-US.json`.
- **Commits** use a conventional prefix (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`, `feat(filtering):`), with a body listing changes as bullets. One change per commit where you can (a fix with its test and its docs): a commit holding eight changes can't be undone one at a time. Branches are named `feat/…`, `fix/…`, `perf/…`, `chore/…`. Open a PR into `master`.
- **Don't reformat unrelated code.** `npm run lint` rewrites files, so don't run it as part of an unrelated change. `js/preload/siteUnbreak.js` lacks a trailing newline upstream; leave it.

## 13. Verifying changes

Two kinds of automated tests: unit tests for the userscript matcher and the extension package helpers (`npm run test:unit`), and end-to-end suites that drive the app (`npm run test:e2e`; `test/e2e/README.md` lists every suite and measurement). Run the suites your change touches, and use the app yourself too (`node test/e2e/open.js`). Check counts quoted in these docs are from the dated run they describe; the suites have grown since, and `test/e2e/README.md` has each one's current count.

- **Full regression runs** (`npm run test:e2e`, screen unlocked): 2026-11-10, 22 suites, 355 checks. 2026-11-11, 22 suites, 364 checks (two needed a rerun: `userscripts-real` after github.com briefly didn't resolve, `performance-settings` after Min's window had focus for 91% of a 100 s check that needs over 97%). 2026-11-12, twice: before the review's changes, 22 suites, 364 checks (`userscripts-real` needed a rerun: the PC's internet dropped during it); after them, 23 suites, 385 checks, all in one run.
- **Quick checks:**
  - `node --check <file>`
  - `npm run build`, then `node --check main.build.js`
  - `node test/e2e/open.js` and watch its terminal for exceptions (a throwaway profile; `npm start` would use the maintainer's dev profile).
- **Driving the app from a script** (this is how the YouTube bugs were found). `test/e2e/harness.js` does all of the following; use it rather than writing another. How it works:
  1. Spawn `node_modules/electron/dist/electron.exe --remote-debugging-port=9333 . --development-mode <url>`.
  2. Poll `http://127.0.0.1:9333/json/list` for the tab target.
  3. Connect to its `webSocketDebuggerUrl` with Node 22's global `WebSocket`.
  4. Use CDP (`Runtime.evaluate`, `Runtime.enable` for `exceptionThrown`, `Network.enable` for `loadingFailed`).
  5. Kill the child process when done.
- **Observed quirk:** launching the dev build with **more than one URL argument** makes Electron exit immediately (code −1). Pass one URL.
- **Measuring resources on Windows:**
  - Write a `.ps1` file and run `powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1`. Long inline `-Command` strings get mangled by quoting.
  - Use `Get-CimInstance Win32_Process` (filter `electron.exe` under `node_modules\electron\dist`; `--type=` in the command line identifies renderer, gpu-process and so on), plus `Get-Process` for `PrivateMemorySize64` and `TotalProcessorTime`.
  - GPU: `Get-Counter '\GPU Engine(pid_<pid>_*)\Utilization Percentage'`.
- **Never touch the user's real profile** (`%APPDATA%\Min`) in experiments. If you must temporarily patch `main.build.js` for an A/B test, back it up and restore it, or rebuild with `npm run buildMain`.
- **Throwaway profiles.** `--user-data-dir=<dir>` gives a run its own profile (Min adds `-development` in development mode, so it uses `<dir>-development`). The harness does this for every run, seeds `settings.json` (no usage statistics or update checks) and an empty `sessionRestore.json` (pitfall 42), and copies the ad-block engine from its cache.
- **The dev profile holds the user's own test data too.** A script that uses it anyway must back up what it changes there and put it back (`settings.json`, `sessionRestore.json`, `passwordStore`; move `userscripts/`, `userscriptData/`, `extensions/` and `extensions.json` aside instead of deleting them). Running the app also rewrites `sessionRestore.json`.
- **Every scripted run must stop by itself, and put the profile back even when it's stopped** (the harness does all of this). An uncaught exception in main makes Electron show a dialog that **blocks the main process** until someone clicks OK, so a script waiting on main hangs (this happened, pitfall 20). So:
  - right after connecting to main, add `process.on('uncaughtException', …)` there (any listener stops the dialog) and record the errors;
  - a watchdog: every few seconds, read those errors, check main still answers (10 s) and Min is still running; stop the run on any of them;
  - a time limit for the whole run;
  - the profile backup script records what it set aside before touching anything (a `state.json` in the backup folder), so a run that was killed is restored by the next run, first thing; it also restores on Ctrl+C. After any interrupted run, check for leftover backup folders.
- **Driving dialogs and main from a script:** add `--inspect=9339` and connect to the Node inspector (`http://127.0.0.1:9339/json/list`) to run code in main, through `process.mainModule.require('electron')`. Main's top-level `let`/`const` aren't reachable there (module scope). Native dialogs can be replaced for a test: `electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })`, `showMessageBox = async () => ({ response: 0 })`. Then call `extensionPages.request(...)` in a Settings tab over CDP. The UI's own IPC handlers can be triggered with `ipc.emit('addTab', {}, { url })`. Extension workers are `service_worker` targets in `/json/list`, and `session.serviceWorkers.on('console-message')` shows their errors, preload failures included.
- **Comparing Electron versions:** install the other version in a separate folder (`npm install electron@<version>` there) and launch it with `cwd` set to the repo, so both run the same app code.
- **YouTube rations ads per visitor.** The dev profile keeps its YouTube cookies, so consecutive test runs alternate: one gets an ad (and in-app clicks stall about 20 s), the next doesn't. Alternating two builds (A, B, A, B) therefore makes one build look worse. Run each build at least twice in a row before blaming it.
- **A locked screen** counts as covering every window: visible-window tests (frames per second, flicker) give 0 while Windows is locked (`LogonUI` running in the session Min runs in; another signed-in account's locked session has a `LogonUI` of its own, pitfall 45). On a locked screen Windows also leaves focus on Min's minimized window (`isMinimized()` true, `BaseWindow.getFocusedWindow()` still that window, no `blur`), so `trimMemoryIfInactive` skipped it and whole-app trimming did nothing, and the page's right-click menu doesn't open in `extensions-toolbar`. Both pass with the screen unlocked (2026-11-09). Windows does the same with the screen unlocked when nothing else takes focus: `performance-settings` saw the minimized window focused for all 70 s and its tabs untrimmed (2026-11-09; that suite now records `focusedWhileMinimized`). Since then a minimized window doesn't count as in use, focused or not (section 10.4).
- **Electron 45 measurements** (10 real tabs, two runs each, versus 43): private memory 1,673 vs 1,647 MB with all tabs alive (+1.6%, inside the 74 MB run-to-run spread), 406 vs 414 MB after hibernating them; browser, UI, utility and history processes identical; GPU process 10 MB smaller.
- **Testing occlusion:** a window launched from a background process may open *behind* other windows. Force it on top first, for example with `SetWindowPos(HWND_TOPMOST)` through PowerShell `Add-Type`.

## 14. Pitfalls already hit (don't repeat them)

1. A `windows.getFocused()` call doesn't exist. Use `windows.getCurrent()`.
2. App-wide emitters (`powerMonitor`, `app`, `screen`) added inside per-window code must be removed when the window closes, or they act on dead windows.
3. `wc.isCapturing()` doesn't exist in Electron.
4. Session-scoped state must be keyed by `session`, or private and normal tabs leak into each other.
5. The ad-block cache never refreshed. Engine caches need an age-based refresh and an offline fallback.
6. Ghostery's `onInjectCosmeticFilters` breaks pages (section 10.2). So does `userGesture: true`.
7. Chromium refuses redirects to `data:` URLs (`ERR_UNSAFE_REDIRECT`).
8. `getCosmeticsFilters` scriptlets assume a shared `scriptletGlobals`. Without it, wrappers stack (2^n calls).
9. `executeJavaScript` in idle tabs (the hibernation probe) defeats memory trimming.
10. Squirrel and the same version number: an installer for the version already installed may not replace it.
11. Localization files have Windows line endings in the working tree. A line added with Unix line endings makes `decomment` (in `buildLocalization.js`) treat a `//` comment as running to the next Windows line ending, silently dropping every string in between; the build still succeeds. Keep each file's line endings consistent, and check new strings are in `dist/localization.build.js`.
12. A page's preload can be switched off by the page: `raw.githubusercontent.com` sends `Content-Security-Policy: sandbox`, and the preload never runs there. Don't rely on the preload to notice what a page is; use the main process (as `promptUserscriptInstall` does).
13. `webContents.loadURL()`'s promise rejects (`ERR_ABORTED`) when it cuts short the page that is still loading. Wait for `did-finish-load` with the expected URL instead.
14. `navigationHistory.goBack()` and `canGoBack()` skip entries for pages that navigated away without a click (Chromium's history intervention). Use `goToIndex(getActiveIndex() - 1)` to reach the previous entry.
15. `shell.openPath()` on a `.js` file on Windows runs it with Windows Script Host. Open scripts in an editor explicitly (`editUserscript`).
16. `electron-chrome-extensions` treats every tab passed to `addTab` as the new active tab (its tabs API calls `onActivated` on `tab-added`) and asks the browser to switch to it (`selectTab`). With any extension installed, Ctrl+click would have jumped to the new background tab. Its `createTab` also expects the browser to load the URL itself. See `extensionsTabCreated` and `openTabForExtension`.
17. Chromium 156 also offers the extension APIs as `browser`, a separate object (even `browser.runtime !== chrome.runtime`) without the library's additions. uBO Lite uses `self.browser || self.chrome` and crashed on `browser.commands.onCommand`, although `chrome.commands` existed. `extensionSupport.js` sets `browser = chrome`.
18. A `service-worker` session preload runs in a realm of its own: no `self`, no `location`. Check the URL inside `contextBridge.executeInMainWorld`. A preload that throws only logs "Unable to load preload script" to the worker's console.
19. `urlParser.protocolRegex` didn't allow `-`, so `chrome-extension://…` URLs became searches. It now allows letters, digits, `+`, `.` and `-`.
20. Don't use Node's global `fetch` (undici) in the main process. Downloading the ad-block lists with it threw an uncaught `AssertionError: assert(!this.paused)` inside undici (Node 24), and Electron's error dialog then froze the main process until OK was clicked; it struck when the cached engine was over 2 days old. Use Electron's `net.fetch` (Chromium's network code, which also follows Min's proxy setting).
21. `siteUnbreak.js` replaced `window.chrome` with a stand-in on every `*.google.com` page (an upstream fix for Drive's viewer). On the Chrome Web Store that threw away the real object (`runtime` and parts of `management`) and the store API added to it, so the store is excluded.
22. A function passed into the main world with `contextBridge` must not return something that can't be copied: `listen: cb => ipc.on(...)` returned `ipcRenderer`, so the call threw and nothing after it ran. Use a block body.
23. Testing the store page: it shows "Add to Chrome" disabled until it has finished loading (wait for it enabled), and a tab in the background doesn't redraw, so its button looks stale until it's shown again.
24. An extension's `setIcon` path is relative to the script that called it, so it can start with `..` (Dark Reader: `"../icons/dr_active_19.png"` from `background/index.js`). Joining it to the extension's folder points outside it; resolve it as an address (`getExtensionActionIcon`).
25. Driving the dev build with `webContents.sendInputEvent`: focus the tab first (`wc.focus()`), or a right-click may never become a `context-menu` event. Key events from it do reach Min's keybindings (`before-input-event`).
26. Electron loads extensions' static DNR rulesets switched off, even those the manifest marks `enabled`; only `updateEnabledRulesets` from inside the extension turns them on (then Electron remembers). Min does it from a hidden page of the extension (section 10.9).
27. Testing an ad blocker extension by whether ad scripts load is misleading: uBlock Origin redirects well-known ones (`adsbygoogle.js`, `gpt.js`) to harmless stand-ins, which still fire `onload`. Use requests it blocks outright (EasyPrivacy trackers such as `sb.scorecardresearch.com/b`, `google-analytics.com/g/collect`) with `fetch(url, {mode: 'no-cors'})`, which fails only when blocked.
28. In Node, `new URL('min://app/...').origin` is `"null"` (a non-web scheme); compare `protocol` and `host`.
29. A tab's `webContents.setUserAgent()` called in `did-start-navigation` doesn't reach that navigation's request (the header and `navigator.userAgentData` stayed Chrome's). Change request headers with a `declarativeNetRequest` `modifyHeaders` rule instead.
30. Main's `settings.listen(key, cb)` calls `cb` at once with the current value. Register listeners that act on other modules after the app is ready.
31. `electron-chrome-extensions` ends its preload with `Object.freeze(chrome)`; real Chrome's `chrome` can be added to, and SponsorBlock's worker stopped at start ("Cannot add property contentScripts, object is not extensible"). `extensionSupportEarly.js`, registered before the library's preload, skips that one freeze.
32. Extensions' offscreen documents are made by Electron's extension system, not as Electron web contents (`getLastWebPreferences()` is null, context isolation is off). `navigator.mediaDevices.enumerateDevices()` or `getUserMedia()` there crashes the whole browser (exit code 0x80000003, no message in a release build); Awesome Screenshot does it when its popup opens. `extensionSupportEarly.js` makes those calls fail in extension pages without context isolation. Creating the document and `navigator.permissions.query` are fine.
33. Writing an extension's files with synchronous `fs` calls froze the main process: Wappalyzer's 13,346 files took 21 s to write and 10 s to remove on Windows (each file is scanned). Written with `fs.promises`, 16 at a time, it takes 10 s and the main process never pauses more than about 80 ms.
34. `sendIPCToWindow` sends `data || {}`: `null` arrives as `{}`. Send an explicit value (the side panel sends `{extensionId: null}`).
35. `will-download` has no `webContents` for a download started with `session.downloadURL` (an extension's background worker); `download.js` assumed one and threw.
36. On YouTube, Chromium logs "Unsafe attempt to load URL chrome-extension://… Domains, protocols and ports must match." for extensions' web-accessible files that do load (checked with a test extension: images, scripts, frames, fetch and dynamic URLs all load there and on example.com). It isn't a failure.
37. `capturePage()` (and so `tabs.captureVisibleTab`) of a covered window fails ("Current display surface not available for capture"): covered windows draw nothing (section 10.4). Scripted tests keep the window on top. The tab previews' `getCapture` hit it too, as unhandled rejections in main's log; it catches the error since upstream's `7ba23e7a` (taken 2026-11-09).
38. `setView` removes every child view of the window but the UI's before adding the tab's, so any other view of Min's (the side panel) has to be added back after it, and placed from the tab's bounds.
39. Electron 45.2 added `chrome.storage.sync` (content scripts on 45.1 got the error `"sync" is not available in this instance of Chrome`), but `electron-chrome-extensions` 4.10 still sets `storage.sync = storage.local` in extensions' pages and workers: settings saved there by a popup were invisible to its content scripts. `extensionSupport.js` restores the real `sync`. Settings saved in `sync` before 45.2 stayed in `local`.
40. In the UI window, `settings` isn't a global: the bundle's modules are scoped, so a test's `Runtime.evaluate("settings.set(...)")` throws, and a harness that ignores the result silently changes nothing (two earlier test scripts did this). `ipc`, `tabs` and `tasks` are globals. Change a setting with `ipc.send('settingChanged', key, value)` (main saves it, applies it and tells the other windows), or edit `settings.json` while Min is closed.
41. (History: Min has refused Manifest V2 since 2026-11-09.) Full uBlock Origin (Manifest V2, unpacked) can't use IndexedDB in Electron's MV2 background page ("Internal error opening backing store for indexedDB.open."), so it keeps its filter lists in `chrome.storage.local`, which Min's main process stores: hundreds of MB rewritten at every start, the profile growing (1.4 GB after four starts), a restart costing 53 s of CPU and about 3 GB. Not usable; uBO Lite is.
42. A brand-new profile opens Min's tour (`https://minbrowser.github.io/min/tour`) as an extra tab, because there's no saved session (`sessionRestore.js`). Test runs seed an empty session, `{"version":2,"state":{"tasks":[]}}`, as the harness does.
43. The UI's entry in the DevTools target list appears before its page has loaded, so `document.getElementById(...)` can be null right after launch. Wait for `document.readyState === 'complete' && typeof tabs === 'object'` (the harness's `launch` does).
44. `net.fetch` (anything that needs a session) throws "Session can only be received when app is ready" before the `ready` event, and `settings.listen` callbacks run at load (pitfall 30). The ad-block lists' first download started there, so every new profile fell back to the small bundled list for an hour (found 2026-11-09 by the suites). `fetchAdblockerList` now waits for `app.whenReady()`.
45. Another signed-in Windows account whose session is locked runs a `LogonUI.exe` of its own, so looking for `LogonUI` anywhere says "locked" while your screen isn't. Look only in the session Min runs in (the harness's `isScreenLocked`).
46. Before deciding Electron lacks an API, look in `node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js`: the library fills in many (`chrome.extension.isAllowedFileSchemeAccess` and `isAllowedIncognitoAccess`, both answering `false`, `getViews`). Dark Reader 4.9.135's "chrome.extension.isAllowedFileSchemeAccess is not a function" looked like an Electron gap, and Min briefly added its own copy, but the function had only been dropped by the rebuild of pitfall 47. `electron-workarounds` showed it (with Min's copy switched off the function was still there), and the copy was removed.
47. Whenever any extension is loaded or unloaded (an install, a Reload, on/off, the network helper), Chromium rebuilds some API objects in every extension worker and page that's already running: `chrome.runtime`, `tabs`, `extension`, `action`, `storage` and `permissions` become fresh native objects, without what `electron-chrome-extensions` and `extensionSupport.js` added (`chrome.tabs.create` was undefined; `chrome` itself and `browser` stay). Until Chromium restarted the worker, the extension half-worked: Dark Reader's popup never loaded once Bitwarden was installed after it. The old objects keep working (their methods and event listeners), so `extensionSupport.js` keeps them and puts them back when main asks. A test of an extension API needs a second extension loaded after the first, or it misses this (`extensions-apis` does it now).
48. Comparing extensions' needs with Min by API area misses single pieces inside an area that otherwise works. Phase 7 did it mostly by area and by hand, so `chrome.tabs.TAB_ID_NONE` (6 extensions) went unnoticed. `measure-extension-survey.js --scan` looks up every name; rerun it after an Electron or `electron-chrome-extensions` upgrade, and after adding extensions to its list. Its text scan can't see names built at run time, and type names in comments (`chrome.tabs.Tab`) are reported apart.
49. In a synchronous IPC handler (`ipc.on` answering `sendSync`), setting `event.returnValue` sends the answer at once; a later assignment is ignored. The page-start handler (then `cosmetic-filters-start`, now `page-start`) first set `null` "to always answer", so every page got no scriptlets and nothing changed; found only because `measure-youtube-ads` checks whether the scriptlets got there first (`trapped`). Set it once, at the end (`finally`).
50. Min's windows keep their UI page in a `WebContentsView`, and closing a `BaseWindow` doesn't unload it, so the UI's `beforeunload` never ran: Quit and closing the last window didn't save the session, and everything since the last 30 s save was lost (suite `session-restore`, found 2026-11-09). The window's `close` handler (`windowManagement.js`) now asks the UI to save first (`save-session-before-close`), and closes once it answers or after 2 s.
51. `electron-chrome-extensions` only knows tabs that have a `webContents`, in the order they were added, and `tabs.query` numbers each match by its place among the matches (a query for the active tab always said index 0). A hibernated tab's `webContents` is destroyed, so the library reported it closed, and a restored tab not shown yet didn't exist. `main/extensionTabs.js` fixes all three from the UI's tab list (section 10.9).
52. Ghostery's `getCosmeticsFilters` needs `domain` to be the registrable domain (`cnn.com`, from `tldts`'s `getDomain`), not the hostname without `www.`: Min passes `removeWWW(hostname)`, so on `edition.cnn.com`, `open.spotify.com`, `music.youtube.com` and every other non-`www.` host the site's own hiding rules and scriptlets didn't apply (found 2026-11-10 with `measure-ad-slots`; fixed that day, `getCosmeticDomain`, suite `adblock-cosmetic`).
53. Ad-recovery scripts (Ad-Shield on Allrecipes) scramble ad elements' class names and ids and patch the page's built-ins (`appendChild`, `matches`, class getters) so the page's own code, and any test reading from the page's main world, still sees the old names. Read class names and ids from an isolated world (`Page.createIsolatedWorld`, as `measure-ad-slots.js`'s `isolatedEvaluate` does), and don't trust a main-world `className` on such pages.
54. A display that has turned off (an idle computer: on the maintainer's, 5 minutes on mains power, 3 on battery) counts as covering every window, like a locked screen: every page's `document.visibilityState` is `hidden`, even with the window on top, so whatever pauses while hidden pauses (the generic rules' watcher, section 10.2). `adblock-cosmetic` failed 9/11 that way on 2026-11-10 after 10 minutes without input, and passed 11/11 with the display still off once Chromium's occlusion check was off for the run (`--disable-features=CalculateNativeWinOcclusion`, which `adblock-cosmetic` and `measure-generic-cosmetics.js` now pass; a tab in the background stays hidden without it). The harness's `screenLocked` doesn't see this; every result file records `display` instead (`test/e2e/display-state.ps1`: seconds since the last input, the timeout, `likelyOff`). Since 2026-11-11 `run.js` keeps the display on while it runs (`test/e2e/keep-display-on.ps1`, the way a video player asks Windows; no setting is changed), and the results then say `display.keptOn: true`, which makes `likelyOff` meaningless; a suite run on its own (`node test/e2e/<suite>.js`) doesn't.
55. `electron-chrome-extensions` checks no permissions. Its preload gives every extension `chrome.cookies`, `webNavigation`, `notifications` and `contextMenus`, and main answers whatever is asked: an extension that asked for nothing at install could read every site's cookies (`cookies.getAll({})`) and every tab's address and title (`tabs.query({})`). Found 2026-11-12 while reviewing Min's tab list; `electron-workarounds` shows both with Min's checks off. `main/extensionPermissions.js` checks them where the library's answers and events pass, and `extensionSupport.js` takes undeclared APIs away (section 10.9). The library also takes the extension's id from the message itself, and its bridge to main (`globalThis.electron`) is within reach of every extension's code, so one extension could name another and get its answers (`extensions-permissions posing` shows it); main checks the sender (`extensionMessageSenderIs`). Before relying on a library API, check what Chrome requires for it, and who may call it. And when a library handler throws, its preload gives the extension `undefined` and logs the error in the extension's console (no rejected promise, no `runtime.lastError`): a test reads `undefined` as "refused".
56. The UI's `sessionRestore.save()` does nothing unless its window is focused (so that one window saves, not all of them). Min is usually closed in the background (from the taskbar, or as Windows shuts down), and the save at close (pitfall 50) then saved nothing: a tab opened 5 s before quitting was lost (`session-restore`, 2026-11-12). Main now tells one window to save anyway (`windows.savesSessionAtClose`). Windows shutting down sends no `close` at all; the window's `query-session-end` event asks for the save. A test of quitting has to blur the window first, or it only tests the easy case.

## 15. Open work

- The branch `chore/unlocked-remeasure` has only been run by the suites, in the dev build: nobody has used it day to day, and it hasn't been packaged (packaging replaces the maintainer's everyday Min, section 0). Its changes sit in every page's start and in closing windows, so use it for a day before a public release.
- Extensions' permissions (2026-11-12, section 10.9, "Permissions"): checked for tabs, windows, cookies, webNavigation, notifications and contextMenus. Not looked at: the library's other answers, and whether Electron's own extension APIs (scripting, storage, declarativeNetRequest) check theirs. `activeTab` doesn't give access to the page's cookies.
- A real Windows shutdown or sign-out wasn't tested for the session save: `session-restore` sends the question Windows asks first (`WM_QUERYENDSESSION`) on its own. And the saving from one page-start request instead of two wasn't measured on its own.
- Run `whole-app-trim` on the packaged app (`MIN_TEST_PACKAGED=1`) after the next packaging: `trimMemoryIfInactive` now trims a minimized window that Windows left focused (2026-11-09), and only the packaged app can show it (packaging replaces the maintainer's everyday Min, section 0, so it wasn't done then).
- **Empty ad spaces** (investigated 2026-11-10, section 10.2 "The visible ad slots, explained"; no ad loads in them). Three fixes:
  1. done 2026-11-10: the registrable domain (pitfall 52);
  2. done 2026-11-10: generic rules from the page's classes, ids and links (section 10.2, "Generic rules from the page");
  3. open: serving Ghostery's stand-ins (the `data:` redirect item below): probably what stops Ad-Shield's recovery on Allrecipes (uBO Lite serves them and shows no banner), not proven.
- The generic rules' watcher starting with the page's first bytes is the setting `hideAdSpacesWhileLoading`, off by default (2026-11-11, section 10.2 "When the rules arrive"). The default was the agent's pick, for the footprint goal: on, it removes the empty ad boxes on big pages (0.1–1.6 s), but every tab that loaded while shown keeps about 3–5 MB more memory and pages take up to 13% more processor time while loading. If the maintainer wants it on by default, change `=== true` to `!== false` in `main/filtering.js` (`getCosmeticsForPageStart`) and `pages/settings/settings.js`, and update `performance-defaults`. Where the extra memory goes (Blink, not the JavaScript heap) wasn't traced.
- Decide on statistics (`js/statistics.js`): turn off by default, or point at a fork-owned endpoint.
- Bump `package.json` `version` for fork releases.
- Userscripts: unsupported functions (`GM_cookie`, `GM_getTab`/`saveTab`/`getTabs`, `window.onurlchange`), and `GM_openInTab`'s `closed`/`onclose`. Add them if real scripts need them.
- Upstream's Electron upgrade (PalmerAL, `5c7b7aca` to 44 and `441e751e` to 45.2.1, compared 2026-11-05): the same changes as ours (clipboard through main, safeStorage's async methods with a queue, no 32-bit builds). Taken from it: Electron 45.2.x (45.2.2 here, newer) and async file reads and writes in `keychainService.js`. Ours stays where it's stricter: the clipboard handlers only answer Min's own windows (upstream's answer any sender), and back/forward use `webContents.navigationHistory` (upstream still calls the deprecated methods). Upstream's clipboard channel is `clipboardWriteItem` (`ipc.send` with raw `ClipboardItem` data); ours is `clipboardWrite` (`{text, html, bookmark}`); keep ours when merging upstream. Everything was rechecked on 45.2.2 (section 10.9, "Measured"). Upstream after that (checked 2026-11-09; `git log 441e751e..upstream/master`): `6350af50` removes the unused phishing page and its strings, `7ba23e7a` catches `getCapture`'s failures (pitfall 37); both taken. Upstream has nothing else we lack: `git log master..upstream/master` lists only these four.
- Chrome extension support, in seven phases. Done: (1) Electron 45.1 (PR #9, now 45.2.2); (2) a spike with real extensions (findings below and in section 10.9); (3) the core, (4) Chrome Web Store installs and updates, (5) toolbar buttons, popups, menus, options pages and shortcuts, (6) network-filtering extensions in place of Min's ad blocker, and (7) the APIs popular extensions use, a crash and a freeze fixed, idle extensions trimmed and restored tabs waiting for extensions, merged in PR #10 (section 10.9). Decisions: aim for any Chrome Web Store extension, installed as in Chrome (Manifest V3 only since 2026-11-09); heavy extensions are the user's choice (Min is to show their memory and CPU and warn, never block); zero cost with none installed. Open:
  - Not built yet: showing each extension's memory and CPU, and the warning for heavy ones (decided 2026-10-30; nothing in the code does it yet).
  - Open after phase 4: the store shows its "Switch to Chrome" banner and pop-up to Min (installing works anyway). Hiding them would mean telling the store, on that site only, that Min is Google Chrome (`navigator.userAgentData` brands and the `Sec-CH-UA` headers); not decided. Requests from the main process (the ad-block lists, extension downloads) go through Min's own ad blocker in the default session; none of their URLs match today's rules, but a rule that did would block them.
  - Open after phase 5: with many extensions the toolbar has no overflow menu, pinning or hiding (Chrome's puzzle-piece menu); no page for changing extensions' shortcuts.
  - Open after phase 6: Min's PDF viewer in that mode (it would need the PDF fetched through main, like reader view). The footprint comparison with uBO Lite is done (section 10.2).
  - Open after phase 7: the API gaps listed in section 10.9 (the camera and microphone in offscreen documents would need an Electron fix; `tabCapture`/`desktopCapture` could use Min's screen-share picker; `tabs.move` and `highlight` in Min's tab order); test real extensions' side panels (Grammarly, DeepL, Bitwarden) by hand. Done 2026-11-09: tabs' order and index, discarded tabs, password saving (section 10.9). Which of the remaining gaps break anything is in section 10.9, "Known gaps".
  - Spike notes on real extensions: Dark Reader darkens pages and its full popup works. Bitwarden's worker runs (including its WebAssembly SDK) and its popup shows the log-in screen; signing in wasn't tried. uBO Lite crashed at start because of the separate `browser` object (pitfall 17), now fixed.
- Potential issue, fix only if reported: whole-app trimming also trims the audio, GPU and network processes while a tab plays media or is in a call (section 10.4, "Potential issue"), which could cause audio dropouts or video stutter. The fix is a few lines in `getProtectedPids()`.
- The remaining low-footprint items in section 10.4.
- Ghostery `data:` redirect failures: 34 requests on the five comparison sites wanted a stand-in and were blocked instead (2026-11-09); no broken site seen. A possible fix is serving stubs from a privileged custom protocol; only if a site breaks (section 10.2).
- `.nvmrc` is stale (15.7.0).
