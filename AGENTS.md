# AGENTS.md

Context for AI coding agents (and humans) working on this repository. It records facts that are hard to recover from the source, decisions already made, and bugs that were expensive to find.

This file describes the code as of `master` at `4747522e` (Chrome extensions merged, PR #10) plus the uncommitted work on `perf/background-efficiency`. When the code and this file disagree, the code wins. Fix this file in the same change.

---

## 0. Start here

**Read sections 0–2 always.** Then read only what your task touches: the repository map (7), the IPC catalogue (8) and the subsystem you're changing (10.x). Check the pitfalls (14) before testing or debugging.

**Where things stand (2026-11-07):**

- `master` has the fork's work so far: the permission manager, low-resource mode (trimming, per-tab memory priority, 15-minute hibernation), Ghostery ad blocking, userscripts (PR #8), Electron 45 / Chromium 156 (PR #9, now 45.2.2), and Chrome extensions, all seven phases (PR #10, section 10.9): `.crx` files, unpacked folders and the Chrome Web Store's "Add to Chrome"; updates; toolbar buttons, popups, menus, options pages and shortcuts; uBlock Origin Lite and the like taking over ad blocking in normal tabs; the APIs popular extensions use; idle extensions trimmed. Upstream (`minbrowser/min`) made the same Electron upgrade after us, in `5c7b7aca` (Electron 44) and `441e751e` (45.2.1); section 15 compares them.
- `perf/background-efficiency` (not committed yet): Settings → Performance with two switches, trimming background tabs while Min is in use (on by default) and `--optimize-for-size` (now off by default: measured, it made JavaScript about a quarter slower and saved no measurable memory); the memory investigation's results (section 10.4, "Measured and not worth doing"); trimming of the audio, GPU and network processes noted as a potential issue; pitfall 40.
- **Next: the maintainer tests the Performance settings**, then a PR. Open items are in section 15.

**Working with the maintainer:**

- They're new to browser development. Explain in plain language, say what you measured, and say what you didn't check.
- Commit and push only when asked. They usually test before committing.
- `master` is protected: work on a branch and give them a PR title and description. The GitHub CLI isn't installed on their machine, so they open PRs themselves.
- Their local `package.json` has an uncommitted `"version": "1.35.8"`. Keep it out of commits (stage the other hunks only).
- Their dev profile (`%APPDATA%\Min-development`) holds their own test data. Back it up and put it back around automated runs (section 13).
- They have a beginner's guide, "Inside Min" (a claude.ai artifact). It mirrors sections 5–10 in plain language. When the architecture changes, tell them the guide needs the same update.

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
8. **Don't hand-roll ad blocking** (ad skippers, playback speed-ups, site-specific ad DOM hacks). The project deliberately reuses uBlock Origin / EasyList rules and Ghostery's engine. If something is broken, fix the integration or the lists.
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
| Ad blocking | `@ghostery/adblocker-electron` 2.20.1 (with `@ghostery/adblocker`, `-content`, `-electron-preload`, `-extended-selectors` at the same version) |
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
npm run build               # buildMain + buildBrowser + buildBrowserStyles + buildPreload
npm test                    # lint only (standard)
npm run test:unit           # unit tests (node:test, test/*.test.js): the userscript matcher and the extension package helpers
npm run lint                # REWRITES files (prettier --write, standard --fix)
node scripts/buildWindows.js --arch=x64   # package x64 only (run `npm run build` first)
npm run buildWindows        # build + package x64 and arm64 (slow; Electron 44+ has no 32-bit Windows or ARM Linux builds)
npm run buildWindowsDev     # "Min-Dev" variant with a separate app identity
npm run updateFilters       # refresh ext/filterLists/easylist+easyprivacy-noelementhiding.txt (offline fallback list)
node scripts/buildTrimMemory.js   # rebuild ext/windows/trimMemory.exe from scripts/trimMemory.cs (Windows' built-in C# compiler)
```

Development details:

- **Dev profile:** `%APPDATA%\Min-development`. The installed browser uses `%APPDATA%\Min`. Never run experiments against the user's real profile.
- **Reload the UI:** `Alt+Ctrl+R`, dev mode only. It recreates windows; main-process code is *not* reloaded.
- **Main-process changes** need the dev build quit and restarted. `watch.js` rebuilds `main.build.js` but never restarts Electron.
- **Localization edits** need `npm run build`. `watch.js` rebuilds the UI bundle but not `dist/localization.build.js`.
- **DevTools:**
  - UI: "Inspect Browser" `Ctrl+Shift+Alt+I` (dev mode only).
  - Page: `Ctrl+Shift+I` or `F12`.
  - Places service: "Inspect Places Service" in the menu (dev mode only).
- **Main-process `console.log`** output goes to the terminal running `npm start`.

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

| Script | Output | Notes |
|---|---|---|
| `scripts/buildLocalization.js` | `dist/localization.build.js` | merges `localization/languages/*.json` (comments stripped) plus `localization/localizationHelpers.js` (defines `l()`). Called by `buildMain`. |
| `scripts/buildMain.js` | `main.build.js` | concatenates in **this order**: `dist/localization.build.js`, `main/windowManagement.js`, `js/util/keyMap.js`, `main/menu.js`, `main/touchbar.js`, `main/registryConfig.js`, `js/util/settings/settingsMain.js`, `main/main.js`, `main/minInternalProtocol.js`, `main/filtering.js`, `main/viewManager.js`, `main/download.js`, `main/UASwitcher.js`, `main/permissionManager.js`, `main/prompt.js`, `main/remoteMenu.js`, `main/remoteActions.js`, `main/keychainService.js`, `js/util/proxy.js`, `main/themeMain.js`, `js/util/userscriptMatching.js`, `main/userscripts.js`, `main/userscriptAPI.js`, `main/userscriptInstall.js`, `js/util/extensionPackages.js`, `main/extensions.js`, `main/extensionAPIs.js` |
| `scripts/buildBrowser.js` | `dist/build.js` then `dist/bundle.js` | browserify of `dist/localization.build.js` + `js/default.js`, with `paths: [root, js/]` and `node: true`; `chokidar` and `write-file-atomic` excluded |
| `scripts/buildBrowserStyles.js` | `dist/bundle.css` | concatenates `css/*.css` (fixed list) + dragula css |
| `scripts/buildPreload.js` | `dist/preload.js` | concatenates `js/preload/default.js`, `textExtractor.js`, `readerDetector.js`, `siteUnbreak.js`, `mediaTracker.js`, `userscripts.js`, `webStore.js`, `js/util/settings/settingsPreload.js`, `js/preload/passwordFill.js`, `js/preload/translate.js` |

Consequences of the concatenation:

- **Lint noise:** `npm test` reports many "X is not defined" errors for cross-file globals. These are noise, not bugs. The fork's main-process code often guards with `typeof fn === 'function'`; those guards are harmless.
- **Load order:** top-level code runs in the order above. A function defined in a later file can only be *called* after load (inside handlers), not at load time.
- **One script scope:** all main-process files share one scope, so two files must not declare the same top-level name.

### Packaging

- **`scripts/createPackage.js`** runs electron-builder with a `dir` target into `dist/app/win-unpacked`.
  - `asar: false`, `npmRebuild: false`.
  - `files` excludes `main/` (it's bundled), `scripts/`, `localization/`, `*.md`, maps, `icons/source` and `dist/app`. `js/preload/extensionSupport.js` is loaded from its own file (it isn't in `dist/preload.js`), so `js/` must stay packaged.
  - An `afterPack` hook flips the `GrantFileProtocolExtraPrivileges=false` fuse on the packaged exe.
- **`scripts/buildWindows.js`** produces:
  - `dist/app/Min-v<version>-windows<suffix>.zip`
  - `dist/app/min-<version><suffix>-setup.exe` (Squirrel, `noMsi`)
- **The version comes from `package.json`** (still 1.35.7). Squirrel may skip installing a version that's already installed, so bump the version before shipping to existing installs. To test a build against the user's real profile, run `dist/app/win-unpacked/Min.exe` directly, after the user has quit the installed Min (single instance per profile).
- **CI:** `.github/workflows/build-packages.yml` is manual only (`workflow_dispatch`). It builds deb, rpm, Windows and both macOS targets. There is no lint or test CI.

## 7. Repository map

### `main/` (main process)

| File | Responsibility |
|---|---|
| `windowManagement.js` | global `windows`: `addWindow`, `removeWindow`, `getCurrent` (last focused), `getAll`, `getState(win)` (**throws** if the window was removed), `windowFromContents`. Quits when the last window closes (except macOS). |
| `main.js` | startup, `createWindow`/`createWindowWithBounds`, `sendIPCToWindow`, `getWindowWebContents`, `handleCommandLineArguments`, window events. Also memory trimming of the whole app (`trimMemoryNow`, `trimMemoryIfInactive`, `startBackgroundTrimming`), the media guards `isTabActiveWithMedia` and `getProtectedPids`, `hasActiveDownloads`, the tab-state relay (`tab-state-change`), and the places/translation channel setup. |
| `viewManager.js` | tab views: globals `viewMap`, `viewStateMap`, `tabLastActivity`. Functions `createView`, `destroyView`, `destroyAllViews`, `setView`, `setBounds`, `focusView`, `hideCurrentView`, `loadURLInView`, `getView`, `getTabIDFromWebContents`, `getWindowFromViewContents`. `callViewMethod` lets the UI call any `webContents` method. It forwards page events (`view-event`) and page IPC (`view-ipc`) to the UI. Also tab memory trimming and memory priority (`getTabProcessGroups`, `trimInactiveTabsNow`, `scheduleInactiveTabTrim`, `restoreTabMemoryPriority`, `lowMemoryPriorityPids`) and hibernation (`isTabImmuneFromHibernation`, `checkSmartHibernation`). |
| `filtering.js` | network blocking + Ghostery engine + cosmetic filters + scriptlets + tracking-parameter removal (section 10.2). In normal tabs it stands down while an extension filters requests (`filterPopups(url, ses)` and cosmetic filters check `isExtensionNetworkFilteringOn`) |
| `download.js` | `will-download` handling (`downloadHandler`, `currrentDownloadItems`; the triple `r` is an upstream typo, keep it). Also `onHeadersReceived` (PDF to viewer, userscript install page for `.user.js` responses, file-view detection, CORS for `min://` UI/reader/PDF pages, ad-block CSP) and `onBeforeRedirect`. `internal-page-fetch`: reader view's page fetched by main when that hook isn't there (section 10.9) |
| `UASwitcher.js` | strips `Min`/`Electron` from the user agent; `customUserAgent` setting; Firefox UA and no `Sec-CH-UA*` headers for `accounts.google.com` (Google sign-in) |
| `permissionManager.js` | permission request/check/display-media handlers, prompts, persistence (section 10.3) |
| `minInternalProtocol.js` | `min://` scheme (privileged: standard, secure, supportFetchAPI). `registerBundleProtocol(ses)` serves only host `app` from the app directory and rejects path traversal |
| `menu.js`, `touchbar.js` | app menu (sends commands to the UI through `sendIPCToWindow`), dock menu, macOS Touch Bar |
| `remoteActions.js`, `remoteMenu.js`, `prompt.js` | `ipc.handle` wrappers for main-only APIs (dialogs, window controls, file drag, clear storage), native context menus, modal prompt windows |
| `keychainService.js` | built-in password store: `<userData>/passwordStore`, encrypted with `safeStorage`'s async methods (the sync ones are deprecated in 45 and removed in 46; files written with them still decrypt), with async file reads and writes. Operations are queued so concurrent saves don't overwrite each other. |
| `registryConfig.js` | Windows default-browser registry keys (on Squirrel install, update and uninstall) |
| `themeMain.js` | `darkMode` setting to `nativeTheme.themeSource`, `darkThemeIsActive` |
| `userscripts.js`, `userscriptAPI.js`, `userscriptInstall.js` | userscripts (section 10.8): loading, matching each frame, saved values and menu commands; the Greasemonkey functions that need main (`GM_xmlhttpRequest`, `GM_download`, `GM_openInTab`, `GM_setClipboard`, `GM_notification`, resources); installing, `@require`/`@resource` downloads, updates, and the requests from the install page and Settings |
| `extensions.js` | Chrome extensions (section 10.9): `extensions.json`, starting `electron-chrome-extensions`, loading, `.crx` and unpacked installs with the permission review (`readExtensionCrx`, `installCheckedExtension`), Min's tabs for the library (`extensionsTabCreated`/`Shown`/`Destroyed`, `openTabForExtension`), lifecycle events, Settings requests, `clearTabStorageKeepingExtensions`, the Chrome Web Store page's API (`extensions-webstore`), updates (`checkExtensionUpdates`, `scheduleExtensionUpdates`), toolbar state and clicks (`getExtensionToolbar`, `scheduleExtensionToolbarUpdate`), the button menu, page menu items (`getExtensionContextMenuItems`), options pages, keyboard commands; extensions' processes for low-resource mode (`getExtensionProcesses`); restored tabs waiting for extensions at startup (`whenExtensionsLoadedFor`) |
| `extensionAPIs.js` | the extension APIs Min adds (section 10.9): `tabs.captureVisibleTab`/`detectLanguage`/`discard`, `downloads`, `privacy`, `identity`, side panels (`openExtensionSidePanel`, placed by `extensionsViewBoundsChanged`), `browsingData`, `search`, `tts`; handlers on the library's router (`registerExtensionAPIs`) |

### `js/` (browser UI renderer)

| Path | Responsibility |
|---|---|
| `default.js` | entry point (see startup) |
| `tabState.js`, `tabState/` | data model: global `tasks` (`TaskList`), global `tabs` (the selected task's `TabList`) |
| `browserUI.js` | `addTab`, `closeTab`, `destroyTab`, `switchToTab`, `addTask`, `closeTask`, `switchToTask`, `setWindowTitle`. Each keeps the model, the tab bar DOM and the views in sync. |
| `webviews.js` | the UI's interface to tab views: `add`, `setSelected`, `update` (load URL), `destroy`, `bindEvent`, `bindIPC`, `callAsync`, `requestPlaceholder`, `hidePlaceholder`, `adjustMargin`, `focus`, `hasViewForTab`, `selectedId`. Also the `hibernateTab` handler, the error page on `did-fail-load`, and preview capture. `resize` emits the UI-only `view-resized` event. |
| `navbar/` | `tabBar.js`, `tabEditor.js` (address bar), `navigationButtons.js`, `progressBar.js`, `tabColor.js`, `tabActivity.js`, `contentBlockingToggle.js` (per-site exception), `permissionRequests.js` (fork: permission bar and tab icons), `bookmarkStar.js`, `tabContextMenu.js`, `menuButton.js`, `addTabButton.js` |
| `searchbar/` | suggestion plugins: `searchbarPlugins.register(name, {index, trigger, showResults})`, `addResult(name, {title, url, icon, descriptionBlock, ...})`, `reset(name)`, `getContainer(name)`. Plugins are required and initialized in `js/default.js`. |
| `places/` | `places.js` (UI side, `MessageChannel` to the places service), `placesService.js`, `placesSearch.js`, `fullTextSearch.js` (tokenize, stem, `searchIndex` lookup), `tagIndex.js` |
| `taskOverlay/` | task overview screen |
| `keybindings.js`, `defaultKeybindings.js` | `keybindings.defineShortcut(nameOrKeys, fn, options)`. Names map to keys in `js/util/keyMap.js` (for example `addTab: 'mod+t'`); raw keys use `{ keys: 'mod+shift+y' }`. Users override keys with the `keyMap` setting. There's no way to remove a shortcut. `hasShortcut(combo)` says whether Min already uses some keys (`mod` counts as `ctrl`, or Command on a Mac). |
| `sessionRestore.js` | saves `<userData>/sessionRestore.json` every 30 s (private tabs excluded); `restore()`, `restoreFromFile()`, `syncWithWindow()` |
| `windowSync.js` | multi-window state sync through main (`tab-state-change`, then `tab-state-change-receive`) |
| `webviewMenu.js` | page context menu (asks the preload for `getContextMenuData`, then `contextMenuData`) |
| `readerView.js`, `readerDecision.js`, `pdfViewer.js` | reader view and PDF viewer integration |
| `passwordManager/` | Bitwarden / 1Password (CLI in `<userData>/tools`), built-in keychain, capture bar, viewer |
| `downloadManager.js` | download bar (state in memory only) |
| `userscripts.js` | the UI's list of userscripts (no code), for the `!run` bang and `@run-at context-menu` scripts in the page menu; scripts' `GM_registerMenuCommand` commands for the page menu (`getMenuCommands`); opens and closes tabs for `GM_openInTab`; "show script directory" (section 10.8) |
| `extensions.js` | extensions' toolbar buttons in `#extension-actions` (after the new-tab button) and their keyboard shortcuts; opens, switches to and closes tabs when an extension asks (`extensions-open-tab`, `-select-tab`, `-close-tab`); a side panel's room and title bar (`#extension-side-panel-header`); `chrome.search` and `chrome.tts` (speech with `speechSynthesis`) for extensions (section 10.9) |
| `statistics.js` | anonymous daily usage stats to `https://services.minbrowser.org/stats/v1/collect` unless `collectUsageStats === false` |
| `util/` | `urlParser.js` (`parse`: adds `https://`, HTTPS upgrade list, search fallback, `min://name` expansion; `isInternalURL`, `getDomain`), `settings/settings.js` (UI settings API), `keyMap.js`, `searchEngine.js`, `database.js` (Dexie `browsingData2`), `theme.js`, `process.js`, `userscriptMatching.js` (userscript metadata, URL matching, `@connect` and update permission checks; also concatenated into `main.build.js` and unit-tested), `userscriptPages.js` (requests from the install page and the Settings list to main), `extensionPackages.js` (CRX3 parsing and signature check, zip reading, manifest text, permission descriptions; concatenated into `main.build.js` and unit-tested), `extensionPages.js` (requests from Settings' extension list to main) |

### Other folders

- `js/preload/` runs in pages (section 10.5).
- `pages/` holds internal pages served at `min://app/pages/...`: `settings` (includes the fork's site-settings UI, the userscript list and the Extensions section), `userscriptInstall` (fork), `error`, `newtab`, `pdfViewer`, `translateService`, `sessionRestoreError`, `prompt`, `phishing`.
- `reader/` is reader view; it uses Mozilla Readability from `ext/readability-master`. When its own `fetch` of the article fails (no cross-origin exception while an extension filters requests), it asks main (`fetchThroughMin`).
- `ext/` holds:
  - `minNetworkHelper` (a built-in extension with no code, loaded only while an extension filters normal tabs' requests; Min sets its rules: section 10.9)
  - `abp-filter-parser-modified` (Min's original filter parser)
  - `filterLists` (`minFilters.txt`; `easylist+easyprivacy-noelementhiding.txt`, the offline fallback)
  - `publicSuffixes`
  - `httpsUpgrade`
  - `franc` (language detection)
  - `xregexp`
  - `textColor` (a tiny neural net that picks tab text color)
  - `icons`
  - `windows/trimMemory.exe` (committed binary, built from `scripts/trimMemory.cs` by `node scripts/buildTrimMemory.js` as a windowed app, so starting it doesn't also start a console host process; see section 10.4 for its arguments)
- `localization/languages/*.json` holds translations. Code uses `l('stringId')`; static HTML uses `data-string`, `data-label` and `data-value` attributes. Add new user-visible strings to `en-US.json`.

## 8. IPC catalogue

Channels are plain strings. To find both ends of a channel, search for its name.

### Handled in the main process

| Group | Channels (handler file) |
|---|---|
| Views (`viewManager.js`) | `createView`, `destroyView`, `destroyAllViews`, `setView`, `setBounds`, `focusView`, `hideCurrentView`, `loadURLInView`, `callViewMethod`, `getCapture`, `saveViewCapture`, `getNavigationHistory` (handle) |
| Window and app (`main.js`) | `set-window-title`, `focusMainWebContents`, `showSecondaryMenu`, `quit`, `handoffUpdate`, `tab-state-change`, `request-tab-state`, `return-tab-state` (once), `places-connect`, `page-translation-session-create` |
| `remoteActions.js` (handle) | `minimize`, `maximize`, `unmaximize`, `close`, `setFullScreen`, `showOpenDialog`, `showSaveDialog`, `showItemInFolder`, `startFileDrag`, `clearStorageData` (keeps installed extensions' data), `addWordToSpellCheckerDictionary`, `showFocusModeDialog2`, `clipboardReadText`, `clipboardWrite` (`{text, html, bookmark}`; UI only: renderers can't use Electron's `clipboard` since Electron 44, and the main-process API is async). Also `newWindow` (on) |
| Filtering | `inject-cosmetic-filters` (`filtering.js`, sent by the preload); `internal-page-fetch` (handle, `download.js`; from reader view, relayed by `js/preload/default.js`) |
| Permissions (`permissionManager.js`) | `permissionGranted`, `permissionDenied` (from the UI), `media-access-status` (from the preload) |
| Downloads | `cancelDownload` (`download.js`) |
| Settings | `settingChanged` (`settingsMain.js`) |
| Userscripts (`userscripts*.js`) | from the preload: `userscripts-get` (**sync**), `userscripts-set-values`, `userscripts-menu-command-add`/`-remove`, `userscripts-xhr`, `userscripts-xhr-abort`, `userscripts-download`, `userscripts-open-tab` (handle), `userscripts-close-tab`, `userscripts-set-clipboard`, `userscripts-notification`, `userscripts-resource` (**sync**), `userscripts-install-prompt` (`file:` only), `userscripts-page` (handle; the install page and Settings only). From the UI: `userscripts-list`, `userscripts-run`, `userscripts-menu-commands`, `userscripts-menu-command-run` (handle), `userscripts-tab-opened` |
| Extensions (`extensions.js`) | `extensions-page` (handle; from the top frame of `min://app/pages/settings/` only, relayed by the userscripts preload), `extensions-webstore` (handle; from the top frame of a `https://chromewebstore.google.com` tab only, sent by `webStore.js`), `extensions-tab-opened` (from the UI), `min-extension-lifecycle` (handle on an extension worker's `ServiceWorkerMain.ipc`, from `extensionSupport.js`). From the UI's toolbar: `extensions-toolbar-get` (handle), `extensions-toolbar-click` (handle; `{id, anchorRect}`), `extensions-toolbar-menu` (`{id, x, y}`), `extensions-command` (`{extensionId, name}`), `extensions-side-panel-close`, `extensions-tts-voices`, `extensions-tts-event` (`extensionAPIs.js`). Extensions' own calls to the APIs Min adds go through the library's `crx-msg` (section 10.9) |
| Passwords (`keychainService.js`, handle) | `credentialStoreGetCredentials`, `credentialStoreSetPassword`, `credentialStoreSetPasswordBulk`, `credentialStoreDeletePassword` |
| Menus and prompts | `open-context-menu` (`remoteMenu.js`; `extensionsTabId` in its data adds that tab's extension items); `prompt` (sync), `open-prompt`, `show-prompt`, `close-prompt` (`prompt.js`) |

### Main process to UI (`sendIPCToWindow(win, channel, data)`)

| Group | Channels |
|---|---|
| Views | `view-event` (page events, from `viewManager.js`), `view-ipc` (page IPC forwarded), `async-call-result`, `captureData` |
| App menu commands | `addTab`, `addPrivateTab`, `addTask`, `goBack`, `goForward`, `zoomIn`, `zoomOut`, `zoomReset`, `print`, `findInPage`, `inspectPage`, `showHistory`, `showBookmarks`, `toggleTaskOverlay`, `saveCurrentPage`, `openEditor`, `enterFocusMode`, `exitFocusMode` |
| Window state | `focus`, `blur`, `windowFocus`, `minimize`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `enter-html-full-screen`, `leave-html-full-screen`, `before-input-event` |
| Features | `updatePermissions` (fork), `hibernateTab` (fork), `userscripts-changed`, `userscripts-open-tab`, `userscripts-close-tab`, `extensions-open-tab`, `extensions-select-tab`, `extensions-close-tab`, `extensions-toolbar` (fork; and `extensions-webstore-event` straight to store tabs), `extensions-side-panel` (`{extensionId: null}` when closed), `extensions-tts`, `extensions-search`, `download-info`, `openPDF`, `set-file-view`, `tab-state-change-receive`, `read-tab-state` |

### From the preload (`ipcRenderer.send` in `js/preload/*`)

- **Forwarded to the UI and handled with `webviews.bindIPC(name)`:** `pageData`, `canReader`, `close-window`, `contextMenuData`, `downloadFile`, `getSettingsData`, `setSetting`, `scroll-position-change`, `wheel-event`, `password-autofill`, `password-autofill-check`, `password-form-filled`, `showCredentialList`, `showUserscriptDirectory`.
- **Handled directly in main:** `inject-cosmetic-filters`, `media-access-status`, the `userscripts-*` channels (`viewManager.js` doesn't forward these to the UI: they can carry saved values and request bodies), `page-translation-session-create` (`ipcRenderer.postMessage` with a `MessagePort`).

### From the UI to a page

`webviews.callAsync(tabId, 'send' | 'sendToFrame', [channel, ...args])`. The preload listens with `ipc.on`:

- `getContextMenuData`
- `password-autofill-match`, `password-autofill-enabled`, `password-autofill-shortcut`
- `generate-password`
- `translate-page`
- `enterPictureInPicture`
- `receiveSettingsData` (for `min://` pages)

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

### 10.1 Tab views

- **Lifecycle** (UI → main):
  - `webviews.add(tabId)` sends `createView` with the list of page events to forward.
  - `webviews.setSelected` sends `setView`.
  - `webviews.update(tabId, url)` runs `urlParser.parse`, then sends `loadURLInView`.
  - `webviews.destroy` sends `destroyView`.
- **Page events** reach the UI as `view-event` and are dispatched to `webviews.bindEvent(name, fn)` handlers. Main drops subframe `did-start-navigation`/`will-redirect` and subframe `did-navigate-in-page` events.
- **`callViewMethod`** calls a method or sets a property on the view's `webContents`, then replies `async-call-result`. History methods (`canGoBack`, `goBack`, `goToIndex`, ...) are called on `webContents.navigationHistory`, since the `webContents` versions are deprecated. Callers use `webviews.callAsync(id, method, argsOrCallback, callback)`.
- **Popups** reuse the default web preferences. `filterPopups(url)` in `filtering.js` blocks popups that the ad-block engine matches.

### 10.2 Ad blocking (`main/filtering.js`)

**Settings.** `filtering = {blockingLevel, contentTypes, exceptionDomains}`:

- `blockingLevel` 0 is off.
- At 1 (the default), the Ghostery engine checks all requests, and Min's own parser checks third-party requests only.
- At 2, Min's parser checks all requests.
- `exceptionDomains` are sites where blocking is off (the shield button, `contentBlockingToggle.js`).
- `contentTypes` can block all `script` or `image` requests.

**Engine lifecycle:**

1. `initFilterList` runs when blocking is turned on (including at startup). It deletes the legacy `adblocker-engine.bin`.
2. `loadCachedAdblockerEngine` reads `<userData>/adblocker-engine-v2.bin`, about 17 ms. If that fails, `downloadAdblockerEngine` runs `ElectronBlocker.fromLists(fetchAdblockerList, ADBLOCKER_LISTS)` and writes the cache. `fetchAdblockerList` uses Electron's `net.fetch`, never Node's `fetch` (pitfall 20).
3. If that fails too (offline), `loadBundledAdblockerEngine` parses `ext/filterLists/easylist+easyprivacy-noelementhiding.txt` and a retry is scheduled in 1 hour.
4. `scheduleAdblockerUpdate` refreshes the engine when the cache is older than `ADBLOCKER_ENGINE_MAX_AGE` (2 days). While blocking is off it doesn't download; it checks again hourly.
5. Building from lists takes about 1.2 s of main-thread time plus a ~6 MB download. The engine holds about 15 MB.

**List sources.** `ADBLOCKER_LISTS` uses official URLs: EasyList and EasyPrivacy (easylist.to), Peter Lowe's list, and uBlock Origin's lists from `https://ublockorigin.github.io/uAssets/filters/` (`filters.txt`, `badware.txt`, `privacy.txt`, `quick-fixes.txt`, `resource-abuse.txt`, `unbreak.txt`, `filters-2020.txt` through `filters-2026.txt`).

- **Add the new `filters-<year>.txt` every January.**
- Do **not** go back to `fromPrebuiltAdsAndTracking` / `fromPrebuiltAdsOnly` / `fromPrebuiltFull`. They download Ghostery's GitHub mirror, which stopped updating (last update 2026-08-14) and lacks the 2025/2026 lists.
- Scriptlet *implementations* (`resources.json`) still come from Ghostery's mirror inside `fromLists`. A brand-new uBO rule that needs a newer scriptlet silently does nothing.

**Per request (`handleRequest`):**

- The site is taken from `details.initiator`, then `details.referrer`, then the `webContents` URL.
- Tracking parameters are stripped (`removeTrackingParams`, `globalParamsToRemove`, `siteParamsToRemove`); main-frame requests get a redirect if anything was removed.
- `contentTypes` blocking applies.
- `adblockerEngine.match(request)` returns either `cancel` (`ERR_BLOCKED_BY_CLIENT`) or `redirect.dataUrl`.
- Min's own parser runs on `minFilters.txt` + `<userData>/customFilters.txt`.
- Blocked requests are counted into the `filteringBlockedCount` setting every 60 s.

**Cosmetic filters and scriptlets:**

- `js/preload/default.js` sends `inject-cosmetic-filters` for top-level http(s) pages.
- `injectCosmeticFiltersForSender` runs `engine.getCosmeticsFilters(...)` with base, hostname and injection rules (no DOM-based rules).
- CSS goes in with `insertCSS(styles, {cssOrigin: 'user'})`. Scriptlets are combined into one `executeJavaScript` call:

  ```js
  '(() => {\nconst minScriptletGlobals = {};\n' + scripts.map(s =>
    '((scriptletGlobals) => {\ntry {\n' + s + '\n} catch (e) {}\n})(minScriptletGlobals);').join('\n') + '\n})();'
  ```

- **Why the wrapper looks like this.** Running each scriptlet in its own scope stops the helper copies overwriting each other and fixes the `toString` recursion. Sharing `scriptletGlobals` lets Ghostery's ≥2.20 `SHARE_SAFE_SELF` prelude reuse the first native snapshot. Measured on YouTube's player request: 7 calls to `JSON.stringify` with the wrapper, versus 64 without sharing. Ghostery's own injector leaves `toString` broken, even in 2.20.1.
- **Late scriptlets.** Scriptlets arrive after the page's own scripts have started (an IPC round trip). Consequences:
  - On a freshly loaded or restored YouTube tab, the first ad can slip through (accepted).
  - In-app video clicks are normally ad-free, but sometimes stall on a spinner for about an ad's length.
  - A fix would be document-start injection from the preload (sync IPC + `contextBridge.executeInMainWorld`). It hasn't been done because it's new code; propose it only if needed.

**Normal tabs and extensions.** While an extension that filters requests is in charge of normal tabs (section 10.9), all of the above (requests, cosmetic filters, scriptlets, popups, the shield button) only applies in private tabs.

**YouTube** has no exemptions. Network rules, CSP, CSS and scriptlets all apply. The old hand-rolled mute/10× ad skipper was removed on purpose.

**Known engine quirk.** Ghostery redirects to `data:` URLs (for example `redirect=noop.txt` on doubleclick and `ad_status.js`), which Chromium rejects with `ERR_UNSAFE_REDIRECT`. Those requests just fail.

**Measured effect** (one tab, dev build):

| Page | Memory | Processes | Load CPU | Idle CPU (25 s) |
|---|---|---|---|---|
| Times of India, blocking off | 1,609 MB | 39 | 95.8 s | 26.3 s |
| Times of India, blocking on | 624 MB | 8 | 30.6 s | 10.8 s |
| YouTube, blocking off | 671 MB | 10 | 18.3 s | 0.1 s |
| YouTube, blocking on | 705 MB | 9 | 19.7 s | 0.7 s |

### 10.3 Permissions (`main/permissionManager.js` + `js/navbar/permissionRequests.js`)

**Handlers**, registered on the default session and on every new session:

- `setPermissionRequestHandler(pagePermissionRequestHandler)`: the site is asking.
  - Supported permissions: `media`, `notifications`, `pointerLock`.
  - `fullscreen`, `clipboard-sanitized-write` and `display-capture` always get `callback(true)`. Display capture still goes through the picker.
  - Anything else is denied.
- `setPermissionCheckHandler(pagePermissionCheckHandler)`: a synchronous check with no prompt. Cross-origin iframes (`requestingOrigin !== embeddingOrigin`) are denied.
- `setDisplayMediaRequestHandler(displayMediaRequestHandler)`: `desktopCapturer.getSources` → the picker in the UI → `{video: source, audio: 'loopback'}` on Windows when audio was requested.

**Flow:**

1. The request is checked against `isPermissionBlockedForOrigin`, then `isPermissionGrantedForOrigin(origin, permission, details, ses)`.
2. Otherwise it's pushed to `pendingPermissions` and `sendPermissionsToRenderers()` sends `updatePermissions`.
3. The UI shows the bar and replies `permissionGranted` / `permissionDenied` with `{permissionId, persist | block, sourceId}`.
4. Main calls the stored callback.

**Storage:**

- Persistent answers: setting `sitePermissions = { "<hostname>": { "notifications": "allow"|"block", "pointerLock": ..., "media:audio": ..., "media:video": ... } }`.
  - Keyed by **hostname**, not full origin (inherited from upstream).
  - Only persistent sessions write it.
- Session grants (`sessionPermissions`) store the `session` they were granted in and only match that session, so private tabs are isolated.

**Live capture tracking:**

- `js/preload/mediaTracker.js` wraps `getUserMedia`/`getDisplayMedia` in the page's main world and reports `media-access-status {kind: audio|video|screen, active}`.
- That updates `activeMediaByContents` (a Map keyed by `webContents`) and the `grantedPermissions` entries the tab icons use.
- The signal is best-effort: a page can read the token and spoof it.
- **`activeMediaByContents.has(wc)`** is the right way to ask "is this tab capturing?". Electron has no `isCapturing()`; `isBeingCaptured()` means something else.

### 10.4 Memory and background behavior (fork)

**Whole-app trimming** (`main/main.js`). `trimMemoryNow` runs `ext/windows/trimMemory.exe <procName> --exclude <pids>` (`EmptyWorkingSet`).

- When: on minimize, 4 s after blur, and every 90 s while unfocused (`startBackgroundTrimming`).
- Skipped when:
  - downloads are active;
  - the window is focused;
  - the window is visible on a multi-monitor setup.
- `getProtectedPids()` excludes media and capture tabs. Process names are `min`, or `Min-Dev` for dev apps. When running unpackaged (`npm start`), the processes are named `electron.exe`, so whole-app trimming matches nothing there; only inactive-tab trimming runs.
- **Potential issue, not reported yet:** `getProtectedPids()` protects only the *tab* that plays media or captures, not the shared processes that tab depends on. In the packaged app with a tab playing (silent) audio, minimizing trimmed Chromium's audio service (104 → 1 MB working set), the GPU process (236 → 1 MB; it also draws picture-in-picture video) and the network service (62 → 0 MB; it carries call data), while the tab itself kept its 113 MB (2026-11-07). Paging that memory back in could cause a short audio dropout or video stutter in a call or music, at minimize and then every 90 s while Min is unfocused. Not heard or measured as a glitch. If it's reported: while any web contents is `isTabActiveWithMedia`, also add the pids of the GPU process and the audio, network and video-capture utility processes (`app.getAppMetrics()`: `type` `GPU`, and `Utility` with `name` "Audio Service", "Network Service", "Video Capture") to `getProtectedPids()`, and check by minimizing the packaged app with a tab playing media and reading those processes' working sets.
- The `powerMonitor` suspend/resume listeners are added per window and removed on `closed`.

**Inactive-tab trimming and memory priority** (`viewManager.js`). Every 60 s, and 30 s after a tab switch, `trimInactiveTabsNow` uses `getTabProcessGroups` to split tab processes into inactive and protected ones. Inactive means the tab hasn't been used for 30 s or more.

- Inactive processes are trimmed and given **low memory priority** (`trimMemory.exe --memory-priority low <pids>`). They're remembered in `lowMemoryPriorityPids`.
- It includes their cross-site frame processes (ads, embeds), found with `getFramePids`, which uses `webContents.mainFrame.framesInSubtree` and each frame's `osProcessId`.
- It never touches a process that also serves a protected tab (selected, media or capture, or used in the last 30 s) or the browser UI. Chromium can share one process between tabs.
- **The setting `trimBackgroundTabs`** (Settings → Performance, on unless set to false): off, every tab counts as protected while any Min window is focused (`BaseWindow.getFocusedWindow()`, popups and sign-in windows included), so background tabs are trimmed only while Min isn't in use. Whole-app trimming and hibernation don't depend on it. The Settings page shows it on Windows only (`navigator.platform`), the only platform that trims. Measured (dev build, 2026-11-07, three test tabs of 100–200 MB, two runs): on and focused, they dropped to 2–19 MB within 100 s; off and focused, they kept their memory; off and minimized, 0–20 MB within 70 s. Going back to a trimmed tab with plenty of free RAM: redrawn in 15–25 ms, its 80 MB read back in about 20 ms. With RAM short, Windows may have reused the memory and it comes back from disk (not measured).
- **Normal priority comes back** (`trimMemory.exe --no-trim --memory-priority normal <pids>`):
  - straight away when the tab is selected (`setView`);
  - when it starts playing media (`media-started-playing` in `main.js`);
  - when it starts capturing (`updateActiveMediaPermissions` in `permissionManager.js`);
  - otherwise at the next 60 s pass, for any lowered process that is protected again. Pids of exited processes are dropped then too.
- **What memory priority does:** pages a process loads after the change get that priority. Windows trims low-priority pages first and reuses them first from its standby cache. A trimmed background tab's pages therefore come back at low priority and are the first RAM Windows gives to another program. It never reduces Min's reserved memory, and does nothing while RAM is plentiful.
- **Chromium's own settings:** it already sets background tabs' CPU priority to Idle, but leaves every process at normal memory priority (5) (checked 2026-10-29). Min can raise and lower renderer memory priority from outside: renderer processes accept `SetProcessInformation`.

**Hibernation** (`checkSmartHibernation`, every 5 min). It sends `hibernateTab`; the UI then destroys the view, and the tab reloads when selected.

- A tab is immune (`isTabImmuneFromHibernation`) if:
  - it's selected in any window;
  - it was used in the last 15 min (`HIBERNATION_IDLE_TIME`, lowered from 60 min after measuring that 10 background tabs hold about 1.45 GB that hibernation frees);
  - it has media or capture;
  - downloads are active;
  - its origin has notification permission (persistent or session);
  - an in-page probe finds any of these:
    - unsaved user input: the `data-min-unsaved-input` attribute on `<html>`;
    - `window.__minActiveSockets > 0` (WebSocket counter from `siteUnbreak.js`);
    - `onbeforeunload`;
    - playing media.
- How unsaved input is detected: `js/preload/default.js` tracks fields the user changed through trusted `input`/`change` events. Changed means text that differs from the field's default value, a checkbox or radio whose checked state differs from its default, or a contenteditable with text. Submitting a form clears its fields. The attribute is recomputed on each change and when the page is hidden.
- Don't go back to scanning `input.value`. Checkboxes and radios always have a value (`"on"`), and pages pre-fill search boxes, so that check made nearly every site permanently immune (measured: 6 of 8 tabs).
- The probe runs `executeJavaScript` in idle tabs, which pulls trimmed memory back in.

**Measured and rejected: asking tabs to free memory.** Trimming moves memory out of RAM but leaves it reserved (private/commit). To find out whether live background tabs would actually release memory, every background page and cross-site frame (13 CDP targets) was sent `HeapProfiler.collectGarbage`, then `Memory.simulatePressureNotification {level: 'critical'}` + GC. The setup was 10 tabs in the dev build (2026-10-29).

| | Alive | After GC | After pressure signal |
|---|---|---|---|
| All background tabs (private) | 1,309 MB | 1,277 MB | 1,260 MB (−49 MB, 4%) |

- Best case: YouTube home, −22 MB (14%). Chat tabs: WhatsApp −8 MB, Discord 0. The freed memory didn't come back within 90 s, but there was little of it.
- Background pages' memory is live state (JS heap, DOM, compiled code, per-process baseline), not caches.
- Don't build a purge feature. Only hibernation (closing the process) releases memory in bulk. Tabs that must stay alive (chats, calls, media) keep roughly 100–160 MB each.

**Measured and not worth doing** (dev build, Electron 45.2.2, 2026-11-07). Where Min's memory goes, and ideas that don't pay:

- **Min's own code holds little.** With eight tabs open: the UI process was 82–88 MB private, but its JS heap only about 11 MB (DOM 255 elements, tab previews under 7 KB); the main process 111 MB private, of which JS heap about 15 MB plus 18 MB of external buffers (the ad-block engine). The rest is Electron and Chromium per process. All ~40 translations are loaded in both processes (`dist/localization.build.js`): a few MB each.
- **The hibernation probe** (`isTabImmuneFromHibernation`) takes 2–5 ms and pulls about 3.5 MB back into a trimmed tab (once 29 MB on Wikipedia), re-trimmed within a minute: about 1 MB on average per tab that stays alive. Its media check is redundant (`isTabActiveWithMedia` already uses `_isMediaPlaying`).
- **Efficiency mode (EcoQoS):** Chromium already gives background tabs idle priority and EcoQoS, and the visible tab and the UI too once Min is minimized. Still normal: main, GPU (above normal), network service, crashpad, and the history service window (a hidden window, so never backgrounded). Putting the GPU process on EcoQoS could slow picture-in-picture and calls.
- **No spare renderer** (every renderer belongs to the UI, the history service or a tab) and **no back/forward cache** (a left page's process closes; Back reloads).
- **The GPU process** grows with sites' content, not with hidden tabs: 138 → 145 MB from 1 to 9 simple tabs (197 MB with YouTube, GitHub and others open); minimizing and hibernating didn't change it.
- **Node.js in a renderer** costs about 10 MB (a blank hidden window: 31 MB with `nodeIntegration`, 21 MB without). Removing it from the UI would mean rewriting the UI.
- **The history service** (`placesService.html`, a hidden window, 32–34 MB) could run as a `SharedWorker` inside the UI process (Chromium keeps it there; it added 4.5 MB), but its IndexedDB belongs to the `file://` origin and a worker started by the UI is `min://app`: everyone's history and bookmarks would need migrating. A smaller option, not done: drop Node from that window (a preload passing the `places-connect` ports, `stemmer` bundled), about 10 MB, same database.
- **Freezing background tabs** (Chromium's page lifecycle "frozen" state: no code runs, the page keeps its state and resumes instantly) works in Electron 45 through the DevTools protocol: `webContents.debugger.attach('1.3')`, then `sendCommand('Page.setWebLifecycleState', {state: 'frozen' | 'active'})`. Chrome freezes tabs by itself, but that logic lives in Chrome (its performance manager), not in the content layer Electron has. Measured with four background tabs, three 60 s periods each (hidden, frozen, resumed but still hidden), CPU per minute:
  - a test page with timers, animation and a dedicated worker (Chromium doesn't throttle workers): 0.40 s hidden, 0.001 s frozen, 0.42 s resumed;
  - once real sites have settled, Chromium's own throttling already leaves little: YouTube 0.011 s frozen vs 0.024 s resumed, Wikipedia 0.003 vs 0.002, Times of India 0.59 frozen vs 0.02 resumed (unexplained);
  - memory pulled back after a trim: 0–1.2 MB frozen, 0.5 MB or less for settled pages that weren't frozen (up to 34 MB while pages were still loading).
  
  The test page's timers and worker stopped exactly while frozen and carried on after resuming, with no reload. Not built: little to gain for most pages, and a frozen page also stops legitimate background work (uploads, chats without notification permission, a web app syncing). Chrome decides when freezing is safe with checks Electron doesn't have (Web Locks, IndexedDB transactions and the like). A narrow use if wanted later: tabs that hibernation can't close only because of unsaved input or an `onbeforeunload` handler, frozen instead of left running.

**Covered windows idle.** Upstream's `disable-backgrounding-occluded-windows` switch was removed. A fully covered window's pages are treated as hidden: 0 fps and 0% CPU/GPU, versus about 69 fps and about 40% of a core before. The user confirmed there's no focus flicker on Electron 43. On Electron 45 the covered case still measures 0 fps; the visible case and the flicker check haven't been redone (the screen was locked during testing, which hides every window). Audio, calls and notifications continue.

**Other:**

- `backgroundThrottling: true` in the tab web preferences.
- `js-flags=--optimize-for-size`, the setting `optimizeJavaScriptForSize` (Settings → Performance, off unless true; it was always on before these measurements). Measured (dev build, 2026-11-07; four real sites open, two runs each with and without it): Speedometer 3.1 scored 14.1 and 14.3 with it, 19.0 and 18.7 without, so JavaScript runs about a quarter slower; a local test (creating objects, JSON, sorting, text with regular expressions, DOM) took 1,393–1,435 ms vs 940–943 ms; the four sites' private memory was 352–363 MB vs 350–360 MB and the UI's 84–86 vs 86–87 MB, so no measurable saving; hence off by default. Electron applies a `js-flags` switch added at run time to renderers only, not to the main process.
- Preview capture runs only when the UI is focused, plus once on blur.

**Not done yet** (candidates):

- skipping the blur screenshot;
- a persistent trimming helper instead of spawning `trimMemory.exe` every minute;
- the history service's window without Node.js (about 10 MB, same database; see "Measured and not worth doing" above).

Efficiency mode (EcoQoS) and the hibernation probe's wake-ups were candidates too; measured, neither pays (above).

**Extensions' processes** (`getExtensionProcesses` in `extensions.js`, used by `getTabProcessGroups`): background workers report their process id when they start (`min-extension-lifecycle`), and extension pages are found among all web contents. While no Min window is focused, they're trimmed and get low memory priority at the 60 s pass, like inactive tabs; while Min is in use they're left alone (their workers would page back in on every page load). A process showing a popup or a side panel, or playing sound, is never touched. Measured with Dark Reader and Bitwarden: focused for two passes, 119 and 161–181 MB kept; minimized, 119 → 3 MB and 187 → about 10 MB at the next pass; both kept working.

### 10.5 Preload scripts (`dist/preload.js`)

| File | Role |
|---|---|
| `default.js` | `inject-cosmetic-filters`; marks unsaved user input for hibernation (`data-min-unsaved-input`); forwards wheel/swipe (`wheel-event`) and scroll position; context-menu helpers and picture-in-picture; relays `postMessage` from `min://` pages (`showCredentialList`, `showUserscriptDirectory`, `downloadFile`, and `internalPageFetch` for reader view) |
| `textExtractor.js` | page text (300k character cap) → `pageData`, sent on load and after `pushState`/`replaceState` (it hooks these in the main world) |
| `readerDetector.js` | `canReader` heuristic |
| `siteUnbreak.js` | main-world fixes run with `webFrame.executeJavaScript(scriptsToRun.join(';'))`: `window.close`, google.com/accounts/drive/news/calendar/meet, YouTube homepage title, WebSocket counter. Its stand-in `window.chrome` for `*.google.com` skips `chromewebstore.google.com`, which needs the real one (pitfall 21). |
| `mediaTracker.js` | capture tracking (see permissions) |
| `userscripts.js` | asks main for this frame's userscripts at document start and runs them at their `@run-at` time, with their Greasemonkey functions; notices local `.user.js` files; relays the install page's and Settings' requests (section 10.8), and Settings' extension requests (`extensions-page`, section 10.9) |
| `webStore.js` | on `https://chromewebstore.google.com` only (top frame): adds `chrome.webstorePrivate` and `chrome.management` for the store's "Add to Chrome" button (section 10.9) |
| `settingsPreload.js` | `getSettingsData`/`setSetting` bridge for `min://` origins only |
| `passwordFill.js` | login form detection and autofill |
| `translate.js` | page translation via a `MessagePort` (`page-translation-session-create`) |

Rules for preload code:

- The preload is sandboxed. Only the limited `require('electron')` API is available; don't require npm packages.
- It runs in iframes too (`nodeIntegrationInSubFrames`). Gate page-wide work on `window === window.top`.
- Main-world injection (`webFrame.executeJavaScript`) is visible to the page and can be altered by it. Don't rely on it for security.

`js/preload/extensionSupportEarly.js` and `js/preload/extensionSupport.js` aren't part of `dist/preload.js`: they're session preloads for extensions, registered only once one is enabled (section 10.9).

### 10.6 Settings

- **Storage:** `<userData>/settings.json`, written atomically by `settingsMain.js` (writes are queued).
- **UI API:** `settings.get(key)`, `settings.set(key, value)` (sends `settingChanged`), `settings.listen(key, cb)` / `settings.listen(cb)`. Main uses the same API on the global `settings`.
- **`min://` pages** use `postMessage` → `settingsPreload.js` → the UI (`webviews.bindIPC('setSetting')`, which checks `isInternalURL`).
- **Keys in use:**
  - **Blocking:** `filtering`, `filteringBlockedCount`, `customUserAgent`
  - **Permissions:** `sitePermissions`
  - **Appearance:** `darkMode`, `darkThemeIsActive`, `siteTheme`, `useSeparateTitlebar`, `showDividerBetweenTabs`, `windowAlwaysOnTop`
  - **Startup and tabs:** `startupTabOption`, `newWindowOption`, `openTabsInForeground`, `enableAutoplay`, `restartNow`
  - **Search and input:** `searchEngine`, `customBangs`, `keyMap`, `userSelectedLanguage`
  - **Passwords:** `passwordManager`, `passwordsNeverSaveDomains`, `1passwordDeviceID`
  - **Extensions:** `extensionsFilterNetwork` (an extension that filters requests blocks ads in normal tabs instead of Min), `extensionsFilteringNetworkNow` (derived by main: that is happening now; for the UI)
  - **Features:** `readerData`, `userscriptsEnabled`, `userscriptsInPrivateTabs`, `lastBookmarksBackup`, `phishingWhitelist`, `proxy`
  - **PDF viewer:** `pdfDayTheme`, `pdfNightTheme`, `PDFInvertColors`
  - **Performance** (Settings → Performance): `trimBackgroundTabs` (on unless false), `optimizeJavaScriptForSize` (off unless true; startup only, so the Settings page shows the restart notice)
  - **Updates and statistics:** `updateNotificationsEnabled`, `collectUsageStats`, `usageData`, `clientID`, `installTime`
- **Autoplay:** `enableAutoplay` is off by default, so a tab loaded without a click (restored, reloaded, opened from a link) won't autoplay.

### 10.7 History, session, other services

- **Places:**
  - The UI's `places.js` sends `places-connect` with a `MessagePort` to the hidden `placesService.html`.
  - It uses Dexie database `browsingData2`, table `places` (history and bookmarks together, flag `isBookmarked`), with an indexed `*searchIndex` (stemmed tokens) and `*tags`.
  - Non-bookmarks older than 42 days are deleted hourly.
  - Suggestions come from an in-memory cache.
- **Session restore:** `sessionRestore.json` every 30 s (private tabs excluded). `restore()` uses `restoreFromFile()` for the first window, otherwise `syncWithWindow()`.
- **Downloads:** `will-download` → `download-info` to the UI. There is no custom save path (Electron's default prompt applies).
- **Reader view:** `min://app/reader/index.html?url=...` (Readability). **PDF:** `min://app/pages/pdfViewer/index.html?url=...` (pdf.js).
- **Translation:** Bergamot WASM in a hidden window; models download from `services.minbrowser.org`.
- **Statistics:** daily POST to `services.minbrowser.org` unless `collectUsageStats === false`. The fork hasn't decided whether to keep this.

### 10.8 Userscripts (`main/userscripts.js`, `main/userscriptAPI.js`, `main/userscriptInstall.js`, `js/preload/userscripts.js`, `js/util/userscriptMatching.js`)

Compatible with Tampermonkey/Violentmonkey scripts (Greasy Fork, OpenUserJS, GitHub). Scripts run inside the page, like Violentmonkey's default mode, so `unsafeWindow` is the page's `window`.

**Files.**

- `<userData>/userscripts/*.js`: the scripts, one file each. The file name is the script's id.
- `<userData>/userscriptData/scripts.json`: per file, `{enabled, sourceURL, installedAt, updatedAt, hash, lastUpdateCheck, pendingUpdate, updateError}` (`getUserscriptRegistry`). Files without an entry are local scripts, enabled.
- `userscriptData/values/<file>.json`: saved values, `{key: JSON string}`.
- `userscriptData/cache/<sha256 of URL>` (+ `.type`): downloaded `@require` and `@resource` files.

**Loading.** While `userscriptsEnabled` is on, main reads the folder (sorted by file name; synchronously, so at startup scripts are ready before the first page loads) and watches it with `fs.watch` (reload 300 ms after the last `.js` change). Each load sends `userscripts-changed` (the list, no code) to every window and `userscripts-page-changed` to open Settings/install pages. A script runs only if it's enabled and all its `@require`/`@resource` files are cached; missing ones are downloaded in the background, then the folder is reloaded. A failed download (including a failed `#sha256=` integrity check) isn't retried until restart, and Settings shows the error. `getKnownUserscripts()` reads the folder even while userscripts are off (the install page needs it).

**Metadata** (`// ==UserScript==` block): `@name`/`@name:<locale>`, `@namespace`, `@version`, `@description`/`@description:<locale>`, `@author`, `@icon`, `@homepage`, `@match`, `@include`, `@exclude`, `@exclude-match`, `@run-at`, `@noframes`, `@grant`, `@connect`, `@require`, `@resource`, `@updateURL`, `@downloadURL`, `@antifeature`. Ignored: `@inject-into`, `@sandbox`, `@unwrap` (scripts always run in the page).

**Matching** (`userscriptMatching.js`):

- `@match` / `@exclude-match`: Chrome match patterns. `*` scheme is http and https; `*.example.com` includes example.com; an optional port; the path is matched against path + query. A missing path counts as `/*` (Chrome would reject it). `<all_urls>` and a bare `*` match everything.
- `@include` / `@exclude`: globs (`*` = anything, case-insensitive, whole URL) or `/regex/flags`. `.tld` stands for a top-level domain (approximate: one optional 2–3 letter label plus the last label).
- No `@match`/`@include` at all = runs everywhere. Declared but all invalid = runs nowhere.
- Only `http:`, `https:` and `file:` pages, never `min://`.
- Legacy files without metadata: `example.com.js` (a leading `www.` is dropped) = `*://*.example.com/*`; `global.js` = everywhere. They get no Greasemonkey functions and run unwrapped, as before.

**Running.** `js/preload/userscripts.js` (every frame) calls `ipc.sendSync('userscripts-get')` at document start. Main matches against `event.senderFrame.url` (not a renderer-supplied URL), drops `@noframes` scripts in subframes and `context-menu` scripts, and replies `[{id, name, runAt, code, params, grants, info, values}]` or `null`. The handler must always set `event.returnValue`, or the page hangs.

- `document-start`: immediately (before the page's first script); `document-body`: when `<body>` exists (MutationObserver); `document-end`: at DOMContentLoaded, before the page's own listeners; `document-idle` (the default): a task after that; `context-menu`: only from the page menu or `!run` (`userscripts-run` → main sends the script to the tab's main frame as `userscripts-run-script`).
- **How the Greasemonkey functions stay private:** main builds `code` as a function body: a prologue (`unsafeWindow = window`, plus `USERSCRIPT_XHR_PROLOGUE` for scripts with `GM_xmlhttpRequest`), the `@require` files, then the script, all in one scope as in Tampermonkey. The preload compiles it with `new Function(...params, code)` (params: `GM_info`, `GM`, `unsafeWindow`, `GM_<granted>`) and runs it in the page with `contextBridge.executeInMainWorld({func, args})`. The functions live in the preload's isolated world and reach the script only as arguments, so the page never sees them on `window`. Page CSP and Trusted Types block neither step (checked on a strict-CSP page, GitHub and YouTube). About 1 ms per script.
- Legacy scripts still run with `webFrame.executeJavaScript(code, false)`. `//# sourceURL=userscript:///<file>` names every script in DevTools. One script's error doesn't stop the others.
- Private tabs: skipped unless `userscriptsInPrivateTabs` is true (checked with `session.isPersistent()`). Manual runs work in any tab.
- **Security model.** The page can't call the Greasemonkey functions, but a hostile page can still interfere with a script running on it (it shares the page's built-ins). Main only accepts a function call from a frame it sent that script to (`userscriptFrames`, keyed `processId:routingId`; `getUserscriptForRequest`) and only for functions the script `@grant`s. A script without `@grant` gets the functions its code mentions (as in Tampermonkey); `@grant none` gets none. `GM_info`, `GM.info` and `unsafeWindow` are always there.

**Greasemonkey functions** (`GM_x` and `GM.x`; granting either form grants both; `GM.*` return promises):

| Functions | How |
|---|---|
| `getValue`, `setValue`, `deleteValue`, `listValues`, `getValues`, `setValues`, `deleteValues`, `addValueChangeListener`, `removeValueChangeListener` | Values arrive with the script, so reads are synchronous; each read returns a fresh copy. Writes go to main (`userscripts-set-values`), are saved a second later (and on quit), and are passed to the script's other frames (`remote: true` for listeners). |
| `addStyle`, `addElement` | Done in the preload. The page's CSP can block `<style>`, so when the style doesn't apply it falls back to `webFrame.insertCSS`; inline `<script>` from `addElement` runs with `executeJavaScript`. |
| `xmlhttpRequest` | Sent by main with `net.request` in the tab's session (cookies included unless `anonymous`). Only to the page's own host and `@connect` domains (a domain includes its subdomains; `*` = anything); anything else gets `onerror` with an explanation. Supports method, headers, body (string, ArrayBuffer, typed array, Blob, FormData, URLSearchParams), `responseType` (text, json, arraybuffer, blob, document), `responseXML`, `timeout`, `abort()`, redirects (`finalUrl`), progress events. Responses over 64 MB fail. |
| `download` | `webContents.downloadURL`; the suggested name is the save dialog's default. Same host rules as `xmlhttpRequest` (data: and blob: always allowed). |
| `openInTab` | The UI opens the tab (`userscripts-open-tab`), next to the current one, in the background unless `active`. The returned object's `close()` works; `closed`/`onclose` don't update (it's a copy). |
| `setClipboard`, `notification` | Main's `clipboard` (through `writeToClipboard` in `remoteActions.js`) and `Notification` (`onclick`, `ondone`, `timeout`; `image` as a data: or http(s) URL). |
| `registerMenuCommand`, `unregisterMenuCommand` | Shown under "Userscript commands" in the page's right-click menu. Main keeps them per frame and clears a frame's commands when it loads a new document. |
| `getResourceText`, `getResourceURL` | A synchronous request for the cached file when first used; the URL is a `blob:` URL (or `data:` with `isBlobUrl` false). |
| `log` | `console.log` with the script's name. |

Not supported: `GM_cookie`, `GM_webRequest`, `GM_getTab`/`saveTab`/`getTabs`, `window.onurlchange`, `GM_audio`.

**Installing** (`userscriptInstall.js`, `pages/userscriptInstall`):

- A tab that opens a `.user.js` URL shows `min://app/pages/userscriptInstall/index.html?url=…` instead. For http(s), `download.js`'s `onHeadersReceived` calls `promptUserscriptInstall` for 2xx main-frame responses that aren't HTML, before the file is shown, so it never enters the tab's history. The page itself can't do it: `raw.githubusercontent.com` sends `CSP: sandbox`, which turns off the preload. For `file:` (no headers) the preload asks once the file shows, and that history entry is then removed.
- The install page fetches the script (`session.fromPartition('persist:webcontent').fetch`, with cookies) and shows: name, version, author, source, what it runs on, `@connect` domains, what its grants allow, where its `@require`/`@resource` files come from, `@antifeature`s, warnings (every site, any domain, scripts off, older or same version, edited copy, and for an update what it adds), and the code. Install uses exactly the reviewed text (`pendingUserscriptInstalls`).
- Installing downloads every `@require`/`@resource`, writes `<name>.user.js` (or replaces the script with the same `@name` + `@namespace`, or the `id` being updated), records the source and a hash, and turns userscripts on if they were off. "Done"/"Cancel" go to the previous history entry (not `goBack()`, which skips pages that navigated away without a click), or close the tab.

**Updates.** Scripts installed from http(s) are checked 10 minutes after userscripts turn on, then every 24 hours (and on "Check for updates" in Settings). `@updateURL` (often a `.meta.js`) is compared by `@version` (`compareUserscriptVersions`), then `@downloadURL` is fetched; `none` turns updates off. An update installs automatically unless it adds sites, `@connect` domains or grants (`getUserscriptPermissionIncrease`), or the installed file was edited (its hash changed); then `pendingUpdate` is set and Settings offers "Review update", which opens the install page with `&id=`.

**Settings list** (`pages/settings`, through `js/util/userscriptPages.js` → preload → `userscripts-page`, accepted only from the Settings and install pages): on/off per script, version, description, sites, source, pending updates, download errors, Edit (Notepad on Windows, `open -t` on macOS: `shell.openPath` would run a `.js` file with Windows Script Host), Remove (to the trash, and its saved values deleted), New script (a template, opened for editing), Check for updates.

**Cost.** The sync request runs in every http/https/file frame even with no scripts; main answers in about 0.1–0.3 ms (about 1 ms for a page with nine matching scripts and their saved values). No background process; update checks are a few HTTP requests a day.

**Measured** (dev build, scripted with CDP): run-at order, iframes and `@noframes`, `@exclude`, strict CSP + Trusted Types, legacy scripts, manual runs, live reload, private tabs, switching off; every function in the table above, including `@connect` refusals and values reaching other tabs; installing from a link and from a local file, automatic and approved updates, edited scripts, disable and remove. Real scripts installed from GitHub through the install page: Return YouTube Dislike (shows the dislike count on YouTube), and Mottie's GitHub Code Show Whitespace, GitHub Toggle Expanders and GitHub Image Preview (their `@require` files from greasyfork.org and greasemonkey.github.io download fine).

### 10.9 Extensions (`main/extensions.js`, `js/util/extensionPackages.js`, `js/preload/extensionSupport.js`, `js/preload/webStore.js`, `js/extensions.js`)

Chrome extensions (MV3 and MV2) use Electron's extension support plus `electron-chrome-extensions` 4.10.0, which adds the APIs Electron lacks (tabs, windows, action and popups, contextMenus, commands, notifications, cookies, webNavigation…). All seven phases are done (section 15): `.crx` files, unpacked folders, the Chrome Web Store's "Add to Chrome", updates, the Settings list, Min's tabs, lifecycle events, toolbar buttons and popups, menu items, options pages, keyboard shortcuts, network-filtering extensions in place of Min's ad blocker, the APIs popular extensions use (`main/extensionAPIs.js`), and idle extensions trimmed.

**Zero cost with none enabled.** At `app.whenReady` main reads `<userData>/extensions.json`; if no extension is enabled, nothing else happens (the library isn't even required). The first enabled extension calls `startChromeExtensions()`: it creates the library on `persist:webcontent` only (private tabs have sessions of their own, so extensions never see them), registering `js/preload/extensionSupportEarly.js` before the library's own preload (the library registers it when it's created) and `js/preload/extensionSupport.js` after it, each as a frame and a service-worker preload. From then on, the three preloads start in every frame and service worker of that session; outside `chrome-extension://` they return at once.

**Files.** `extensions.json` is `{version: 1, extensions: {id: {source, path, name, version, enabled, installedAt, updatedAt, lifecycleEvent, lastUpdateCheck, pendingUpdate: {version}, updateError}}}`. `source` is `'webstore'` (the `.crx` is signed by the Chrome Web Store, however it was installed), `'crx'` or `'unpacked'`. A `.crx` install is unpacked to `<userData>/extensions/<id>/<version>/`. Unpacked folders load from where they are, and Min never deletes them.

**Installing a `.crx`** (`installExtensionFromCrx` → `readExtensionCrx` → review → `installCheckedExtension`; the store and updates share the last two):

- `parseCrx` (unit-tested) reads the CRX3 header and verifies **every** signature, as Chrome does: RSA (field 2) and ECDSA (field 3) proofs, over `"CRX3 SignedData\x00"` + the signed header's length (uint32 LE) + the signed header + the zip. One must be the developer's: the key whose SHA-256 gives the id (its first 16 bytes as letters a–p). `fromWebStore` is true when one is the Chrome Web Store's publisher key (SHA-256 `61f7f2a6…6367cf`, `EXTENSION_WEBSTORE_KEY_HASH`, Chromium's `kPublisherKeyHash`; every store file has it, checked on three). CRX2 is refused.
- `readExtensionZip` extracts in memory (stored or deflate; refuses `..`, absolute and drive paths; at most 512 MB and 20,000 entries).
- `readExtensionCrx` also refuses a `minimum_chrome_version` newer than Electron's Chromium, and can require an id (downloads) or the store's signature.
- The review is a native dialog (`confirmExtensionInstall`): which sites (all, or a list), permission warnings (`describeExtensionPermissions`, strings `extensionPermission*`), and for `webRequestBlocking`/DNR extensions a note that Min's ad blocker is in charge of network requests.
- The manifest gets `key` = the developer's public key, so Electron gives the extension its Web Store id (the same id and `chrome-extension://` origin as in Chrome).
- Files are written to `<version>.tmp`, then renamed; the previous version's folder is deleted once the new one is in place.

**The Chrome Web Store** (`js/preload/webStore.js` + `extensions-webstore` in main). The store's page calls `chrome.webstorePrivate` and `chrome.management`, which only Chrome gives it; the preload adds them in the page (main world) on `https://chromewebstore.google.com` and forwards calls to main, which accepts them only from that site's top frame in a Min tab. The store's button stays labeled "Add to Chrome", and the store shows its "Switch to Chrome" banner (Electron's brands are "Chromium", not "Google Chrome"); installing works anyway.

- `beginInstallWithManifest3` → `beginWebStoreInstall`: the review (from the manifest the store sends, with its translated name), then the `.crx` from `getWebStoreDownloadURL` (Google's update server, `response=redirect`), which must be signed by the developer and the Web Store and have the id asked for. If the file asks for more than the store's manifest said, it's reviewed again. `completeInstall` then just answers success.
- `getExtensionStatus` (`installable` / `enabled` / `disabled`), `management.getAll`/`get`/`setEnabled`/`uninstall` ("Remove from Chrome": Min's own confirmation, then the usual removal). Fixed answers for the rest (incognito: whether the tab is private; login, WebGL, MV2 deprecation…).
- Answers are `{result, error}`; the preload sets `chrome.runtime.lastError` from `error` while the page's callback runs.
- Installs, removals and on/off changes made anywhere send `extensions-webstore-event` (`onInstalled`, `onUninstalled`, `onEnabled`, `onDisabled`) to open store tabs, so their button follows.
- Downloads (`downloadForExtensions`): Electron's `net.fetch`, https only, no cookies (Chrome sends none to update servers), at most 256 MB, and the update server's SHA-256 checked when it gives one.

**Updates** (`checkExtensionUpdates`, Chrome's update protocol): every `.crx` install whose manifest has an https `update_url` (store extensions have Google's, `EXTENSION_WEBSTORE_UPDATE_URL`). One request per update server lists all its extensions with their versions (`getExtensionUpdateCheckURL`); the XML answer (`parseExtensionUpdateResponse`) gives each a newer version and its download URL, or `noupdate`.

- An update that asks for nothing new (`getExtensionPermissionIncrease`, unit-tested) installs at once and keeps the extension's on/off state; its worker gets `onInstalled` with reason `update`.
- One that asks for more waits: the installed version keeps running, `pendingUpdate` is set, a system notification says so once per version (click: Settings), and Settings offers "review the update". The review shows only what's new ("The new version also asks to: …").
- Updates from Google's server must be signed by the Web Store too.
- Schedule (`scheduleExtensionUpdates`, only when a `.crx` install exists): 10 minutes after startup, then hourly checks for extensions not checked in the last 5 hours; and "Check for updates" in Settings. Failures go to `updateError`, shown in Settings.

**Unpacked** (`loadUnpackedExtension`): loading a registered folder again, or "Reload" in Settings, replaces it and counts as an update, as in Chrome.

**Lifecycle events.** Electron never sends `runtime.onInstalled` or `onStartup`. `registerInstalledExtension` stores a `lifecycleEvent` (`{type: 'installed', reason: 'install' | 'update', previousVersion}`). When an extension's worker starts (`serviceWorkers` `running-status-changed` → `starting`), main adds a `min-extension-lifecycle` handler on `worker.ipc`. The worker preload asks it and calls the listeners the background script added, one task after the script's first run. Main answers with the stored event (then deletes it), else `{type: 'startup'}` once per run for extensions not installed in this run, else nothing. If Electron ever sends the events itself, the preload's copies stay quiet.

**Tabs.** `viewManager.js` calls `extensionsTabCreated` (in `createView`; persistent session only), `extensionsTabShown` (in `setView`; it also moves the tab to its window in the library's store, which has no API for that) and `extensionsTabDestroyed` (in `destroyView`).

- The library makes every tab it's given the active one and asks Min to switch to it (pitfall 16). `extensionsTabCreated` adds the tab without changing the active one; a tab becomes active only when Min shows it.
- `chrome.tabs.create` and `windows.create` → `openTabForExtension` → `extensions-open-tab` → `js/extensions.js` adds the tab (in the background unless `active`) and replies `extensions-tab-opened` with its id; main waits for its view and returns `[webContents, window]`. `windows.create` opens its URLs as tabs in the current window; extensions can't create or close Min's windows.
- `tabs.update({active: true})` → `extensions-select-tab` (switches task if needed); `tabs.remove` → `extensions-close-tab`.
- The library also calls these for switches and closes that Min itself made; those are ignored (`minIsSelectingTab`, `extensionTabsClosedByMin`).

**Toolbar buttons and popups.** Every enabled extension with an action (manifest `action`, or `browser_action` in MV2) gets a button in the navbar's `#extension-actions`, after the new-tab button, in install order. The library keeps each action's title, icon, badge and popup, overall and per tab (`browserAction.actionMap`), and tells observers when any of it or the active tab changes. Min adds one observer (`startChromeExtensions`).

- `scheduleExtensionToolbarUpdate` (batched, 50 ms) sends each window its shown tab's buttons (`extensions-toolbar`: `{buttons: [{id, title, badgeText, badgeColor, icon}], commands}`). Icons are data URLs (at most 32 px, cached). The UI asks once at start (`extensions-toolbar-get`).
- The shown tab per window is `shownTabByWindow` (set in `extensionsTabShown` for every tab, private ones too). A private tab shows no buttons. Every tab switch refreshes the toolbar, because the library doesn't report coming back from a private tab to the tab it still thinks is active.
- `setIcon` paths are relative to the script that set them (Dark Reader: `"../icons/…"` from `background/`). `getExtensionActionIcon` resolves them as addresses, from the background worker's folder and then the extension's root, so `..` can't leave the extension.
- A click (`extensions-toolbar-click`, with the button's rectangle) → `browserAction.activateClick`: the popup opens as a child `BrowserWindow` of Min's window, right-aligned with the button and just below it, sized to its content; it closes on a second click or when it loses focus. Without a popup, the extension gets `action.onClicked` with the tab.
- Right-click (`extensions-toolbar-menu`): Min's own menu, localized. The name (opens its store page or homepage), the extension's `chrome.contextMenus` items for the `action` context, Options, "Remove from Min…" (asks first), "Manage extensions" (Settings).
- The library's own toolbar element (`<browser-action-list>`), its `crx://` icon protocol and its English-only button menu aren't used.

**Menu items, options pages and keyboard shortcuts.**

- Page menu: each tab's last `context-menu` params are kept (`extensionContextMenuParams`). `webviewMenu.js` passes `extensionsTabId` to `remoteMenu.open`, and `main/remoteMenu.js` appends `getExtensionContextMenuItems(tabId)` (the library's `getContextMenuItems`, real Electron menu items with their clicks) after Min's own items. Several items from one extension go into a submenu named after it.
- Options: `options_ui.page` or `options_page`, opened in a tab ("Options" in Settings and in the button menu; `runtime.openOptionsPage` through the library).
- Shortcuts: `getExtensionCommands` turns each `commands.*.suggested_key` into a Min key combo (`getExtensionShortcutCombo`, unit-tested; Chrome's rules: Ctrl, Alt or Command required, Ctrl is Command on a Mac), and fills in `commands.getAll`'s `shortcut`. `js/extensions.js` defines each combo once (keybindings.js can't remove shortcuts) and looks up what it runs now. It skips combos Min already uses (`keybindings.hasShortcut`), as Chrome skips clashing suggestions; the first extension to ask gets a combo. `_execute_action` (and MV2's `_execute_browser_action`/`_execute_page_action`) acts like a click on the button; other names send `commands.onCommand` with the tab (`extensions-command`; the library's router wakes a sleeping worker for it).

**Settings → Extensions** (`pages/settings`, through `js/util/extensionPages.js` → the userscripts preload relay → `extensions-page`, accepted only from the top frame of `min://app/pages/settings/`). A "Get extensions from the Chrome Web Store" link. Actions: `list`, `install-crx`, `load-unpacked`, `set-enabled`, `remove`, `reload`, `open-options`, `check-updates`, `review-update`. Each item shows its icon, name, version, description, source, permissions, the network-filtering note, load errors, a pending update, update errors, and permissions Electron doesn't support ("parts may not work", from Electron's `ExtensionLoadWarning` minus `EXTENSION_PROVIDED_PERMISSIONS`). Changes send `extensions-page-changed` to open Settings pages.

**Disable and remove.** Disabling unloads (data kept). Removing unloads, forgets the extension, clears its origin's storage (`clearData({origins})`) and deletes Min's copy of a `.crx` install. `chrome.storage` and dynamic DNR rules live in `Partitions/webcontent/{Local Extension Settings, Sync Extension Settings, DNR Extension Rules}/<id>` and stay open while Min runs, so `removeLeftoverExtensionData` deletes removed ids' folders at the next startup.

**Clear browsing data** (`clearTabStorageKeepingExtensions`, used by `clearStorageData`) keeps installed extensions' data and workers, as Chrome does: `clearData({dataTypes, excludeOrigins})`. With none installed it's the old `clearStorageData()`, which would also unregister extensions' workers.

**Network filtering by extensions** (uBlock Origin Lite and the like; `applyExtensionNetworkFiltering`). Electron turns off extensions' `webRequest` and `declarativeNetRequest` in a session that has any `webRequest` listener, so an extension can only filter normal tabs' requests once Min's four hooks are gone from `persist:webcontent`.

- On when the setting `extensionsFilterNetwork` is true and an enabled extension filters requests (`extensionUsesNetworkFiltering`: `webRequestBlocking` or DNR permissions; `networkFiltering` in `extensions.json`). Then the four hooks are removed from normal tabs' session (`ses.webRequest.onX(null)`), and put back with `registerFiltering`, `enableGoogleUASwitcher` and `listenForDownloadHeaders` when it turns off. It takes effect for new requests at once; reload tabs for the rest. Private tabs' sessions keep the hooks, so Min's ad blocker still works there.
- Installing (or loading unpacked) a new extension that filters requests turns the setting on (`finishExtensionInstall`); its review says so ("Adding it turns off Min's ad blocker in normal tabs…"). Settings → Privacy has the switch ("Let <names> block ads and trackers in normal tabs, instead of Min's ad blocker"), shown while such an extension is on. Turning off or removing the last one brings Min's ad blocker back; the setting itself stays. Main keeps `extensionsFilteringNetworkNow` up to date for the UI.
- Min's ad blocker stands down in normal tabs: no cosmetic filters or scriptlets (`injectCosmeticFiltersForSender`), no popup filter (`filterPopups(url, ses)`), no shield button in the address bar (`contentBlockingToggle.update`). Its blocked-request count doesn't include the extension's blocks.
- **Static rulesets.** Electron loads an extension's `declarative_net_request.rule_resources` switched off (`getEnabledRulesets()` is `[]`). `updateEnabledRulesets`, called from inside the extension, turns them on, and Electron remembers that across restarts. uBO Lite does it itself; simpler extensions never do. So after an install, update or reload, `enableExtensionDefaultRulesets` turns on the rulesets the manifest marks `enabled` (on an update only new ones, so the extension's own choices stay; `rulesetIds` in `extensions.json`). It runs the call in a hidden page of the extension (`runInExtensionPage`: a `WebContentsView` at `chrome-extension://<id>/manifest.json`, about 200 ms), which works even for extensions without a background worker.
- **The hooks' other jobs** in normal tabs:
  - Google sign-in's Firefox user agent (no `Sec-CH-UA*` headers) and tracking-parameter removal become `declarativeNetRequest` rules of a built-in helper extension, `ext/minNetworkHelper` (id `gnpfkmcflhpbhcdmklkmnjkhebgdgnap` from the `key` in its manifest; no code; loaded only while this is on). Min sets its dynamic rules through `runInExtensionPage` (`getNetworkHelperRules`: `modifyHeaders` for `|https://accounts.google.com/`; a `redirect` with `queryTransform.removeParams` per parameter list, only for main-frame addresses that contain one, so form posts aren't redirected), again when the `filtering` setting changes. A per-tab `setUserAgent` doesn't work for this (pitfall 29).
  - `.user.js` installs: `did-start-navigation` on each tab (`extensionsTabCreated`) calls `promptUserscriptInstall`, so it works from the address alone.
  - File views (for saving): `did-finish-load` reads `document.contentType` in an isolated world (`reportExtensionTabFileView`), which works even on pages whose CSP sandbox turns off the preload.
  - Reader view: its `fetch` fails without the cross-origin exception, so it asks main (`internal-page-fetch` in `download.js`: only from a `min://app/reader/` top frame, and only for the address in its `url` parameter; fetched with the tab session's cookies).
  - PDFs open in Chromium's own viewer (`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/`) instead of Min's; a Min PDF viewer tab restored in this mode can't load its file.
  - Lost in this mode: the "block scripts/images" option and Min's fixed `Sec-CH-UA` header on other requests.
- Removed extensions' storage (`removeLeftoverExtensionData`) keeps the helper's rules folder only while the helper is going to be used.

**`extensionSupport.js`** makes `browser` the same object as `chrome` (pitfall 17), delivers the lifecycle events and adds the APIs below. A worker's preload realm has no `location` (pitfall 18), so the URL is checked in the main world. **`extensionSupportEarly.js`** runs before the library's preload: it skips the library's `Object.freeze(chrome)` (pitfall 31) and refuses media in extensions' hidden pages (pitfall 32).

**APIs Min adds** (`main/extensionAPIs.js`; phase 7). Chosen by a survey of 53 popular Chrome Web Store extensions: a text scan of the APIs their code mentions, against what Min offered (an extension asking for every permission listed `chrome.*` in its worker), then each one installed in the dev build with its errors recorded. The preload adds each API to `chrome` (only with its permission, as Chrome does) and calls main through the library's router (`ipcRenderer.invoke('crx-msg', extensionId, name, ...args)`, handlers from `router.apiHandler()`), which only takes calls from installed extensions and gives each handler the calling extension; events go back with `router.sendEvent` (to a worker too, which it wakes). Promises and Chrome's callbacks both work, with `runtime.lastError` set while a callback runs.

- `tabs.captureVisibleTab` (12 surveyed extensions: screenshots, colour pickers): `capturePage()` of the window's shown tab, JPEG (quality 92) or PNG; needs `activeTab` or all sites; not `min://` pages or other extensions' pages. A covered window has nothing to capture (pitfall 37).
- `tabs.detectLanguage` (6, translators): the page's `lang` attribute (`zh` becomes `zh-CN`/`zh-TW`), else `und`. Chrome guesses from the text.
- `tabs.discard`: Min's hibernation (`hibernateTab`); refused for a shown tab and one with sound, video or a call. Without a tab id it does nothing (Chrome picks one).
- `downloads` (7; the library's are stubs): every download in normal tabs' session is listed (`search`, `onCreated`, `onChanged` on state, pause, name and size changes, `erase`, `pause`/`resume`/`cancel`, `removeFile`, `getFileIcon`). An extension's own downloads go to the Downloads folder without a dialog (unless `saveAs`) under the name it gives (a relative path; `..` and absolute names are refused; " (1)" on a clash), started from its page (so its `blob:` addresses work) or the session. `open` shows the file in its folder instead of running it. They appear in Min's download bar.
- `privacy` (7, password managers and VPNs; the library's settings never answered): every Chrome setting reads and sets like Chrome's (the last extension to set one controls it, `onChange`), but doesn't change Min yet.
- `identity` (6): `getRedirectURL`; `launchWebAuthFlow` opens the sign-in page in a window of normal tabs' session (its cookies and Min's Google sign-in fix) and returns when it goes to `https://<id>.chromiumapp.org/`; closing it fails the flow; non-interactive fails once the page has loaded. `getAuthToken` fails as Chrome does with nobody signed in ("The user is not signed in."): it needs a Google account in the browser itself.
- `sidePanel` (6: Grammarly, DeepL, QuillBot, Bitwarden…): the panel page in a `WebContentsView` at the window's right edge, 360 px wide, under a 36 px title bar the UI draws with the extension's name and a close button; the tab is narrowed beside it (`webviews.adjustMargin`). `viewManager.js` reports the tab's bounds (`extensionsViewBoundsChanged`) and hidden views (`extensionsViewHidden`, for the task overlay and the like); `setView` removes every child view but the UI's, so `extensionsTabShown` puts the panel back (pitfall 38). One panel per window; `setOptions` (per tab too), `setPanelBehavior({openPanelOnActionClick})` (the toolbar button opens and closes it), `open`, `close`, `onOpened`/`onClosed`; the button's menu has "Open side panel". Hidden in full screen. Removing or turning off the extension closes it.
- `browsingData` (3): `remove` and the `removeX` helpers clear normal tabs' session (`clearData`, `clearCache`), for some sites or all, keeping installed extensions' own data. Electron can only clear everything, so a time range (`since` > 0) is refused.
- `search.query`: Min's search engine, in the tab or a new one. `tts` (3, Read Aloud): the UI window speaks with `speechSynthesis` and the system's voices; `onEvent` callbacks get start, word, sentence, end and the rest.
- `action.setIcon` with pixels (`imageData`; AdBlock, Adblock Plus): the library drops it for Manifest V3, so the preload turns it into PNG data with `OffscreenCanvas`. `action.onUserSettingsChanged` and `runtime.onPerformanceWarning` exist but never fire.
- `storage.sync`: Electron 45.2 added it (a second local area with Chrome's quotas; nothing leaves the computer), and content scripts get it. The library still points `sync` at `local` in extensions' pages and workers, so the preload puts back the real one, from Chromium's own `browser` object, before making `browser` the same as `chrome`. A worker, a content script and the popup then see the same settings and `onChanged` events (pitfall 39).
- Tab details get the favicon (for tab lists like OneTab) and `highlighted` (`assignTabDetails`). Big extensions install without freezing Min (pitfall 33).

**Startup.** While the enabled extensions load at startup (`extensionsLoadingAtStartup`), a normal tab's first `loadURLInView` waits for them (`whenExtensionsLoadedFor`), so content scripts run in the first page. Loading takes about 20 ms per extension.

**Measured** (dev build, a scripted run of 58 checks; Dark Reader 4.9.134, Bitwarden 2026.10.1 and uBO Lite 2026.1026.1812 from Chrome's update server, plus test extensions written for it):

- zero cost with none (library not loaded, no preloads), again after removing all;
- `.crx` installs get their Web Store ids, the review text and `key`; unpacked folders load;
- Dark Reader opens its welcome page on install (`onInstalled` → `tabs.create`); `onInstalled` with reason `update` and the previous version after Reload; `onStartup` once after a restart;
- `tabs.query`, `create` (foreground and background), `update({active})` and `remove` act on Min's tabs, and content scripts reach the worker; private tabs aren't listed;
- uBO Lite's worker runs (it crashed before the `browser` fix), but it can't block anything yet (no static rulesets, Min's hooks);
- disable and enable; clearing browsing data keeps extensions working and their storage while sites' data goes; removing deletes the files, and the storage at the next start; a restart loads everything again.
- Cost, the three real extensions with one page open: 3 more processes and 248 MB more private memory (about 80 MB each), 0% CPU when idle. The library starts in about 6 ms and an extension loads in 14–23 ms.
- Toolbar (a third scripted run, 23 checks, with a test extension written for it): no buttons without extensions; the button shows the action's title, icon and badge ("7", green); a click opens the popup under the button (right edges within 2 px), and the popup's `tabs.query` sees the page; a second click closes it; the button menu lists the name, the extension's action item, Options, Remove and Manage; Options opens the options page; the page menu ends with the extension's item; both menu items reach the extension; Alt+Shift+H sends `onCommand` with the tab, Alt+Shift+K opens the popup, and Ctrl+T stays Min's; `commands.getAll` shows "Alt+Shift+H"; with the popup removed, a click sends `onClicked`; no buttons on a private tab, and back afterwards; turning the extension off and on removes and restores its button. Real extensions: Dark Reader's and Bitwarden's buttons show their icons and their full popups open from them.
- Network filtering (a fourth scripted run, 28 checks, with a rules-only test extension that blocks one ad script, so it can be told apart from Min's ad blocker, which also blocks trackers): Min's blocker blocks both first; loading the extension turns the switch on and loads the helper; in normal tabs trackers then pass and the extension blocks the ad script (its ruleset turned on by Min); private tabs still block both; Settings shows the switch and the notes; the helper's rules are there, and `accounts.google.com` was requested with the Firefox user agent and no client hints (DevTools protocol); `?utm_source=…&keep=1` became `?keep=1`; a `.user.js` opened the install page; a text file counted as a file view and a page didn't; reader view loaded its article through main; a PDF opened in Chromium's viewer (screenshot); switching off in Settings, turning the extension off and removing it each brought Min's blocker back, and switching on or turning it on again handed back; uBO Lite's review shows the warning and uBO Lite blocks the trackers; all of it holds after a restart. Measured separately: uBO Lite blocks with Min's hooks gone (EasyPrivacy trackers), and only then.
- Phase 7: the survey (53 extensions; 3 more weren't in the store): all install, and all 52 with a background worker run it. Before the fixes, SponsorBlock's worker stopped at start (pitfall 31), Awesome Screenshot crashed Min when its popup opened (pitfall 32) and Wappalyzer froze Min for about 30 s while installing (pitfall 33). A fifth scripted run (35 checks, a test extension written for it) covers every API above: screenshots (PNG 18 KB, JPEG with a callback), French detected, a background tab hibernated and the shown one refused, a download saved under Downloads without a dialog with its events, " (1)" and a refused `..`, privacy get/set/clear/onChange, a sign-in flow through a redirect, a refused non-interactive one and a closed window, the side panel beside a 360 px narrower tab and under its title bar, on top after a tab switch, toggled by the button and closed by the title bar, cookies cleared for one site and a time range refused, a search in a new tab, Windows' voices and spoken events, an icon from pixels, and the panel closed when the extension is removed. Also: Return YouTube Dislike shows its count and SponsorBlock its player button on a real video; after two restarts with nine extensions, the first page had its content script; the footprint numbers in section 10.4.
- The Web Store (a second scripted run, 30 checks, on Dark Reader's real store page): "Add to Chrome" shows the review with the store's name, downloads, checks both signatures and installs as `webstore`; the button becomes "Remove from Chrome", and `getExtensionStatus`/`getAll` agree; turning it off in Settings shows on the store page; "Remove from Chrome" asks, removes, and the store says "Dark Reader has been removed from Chrome"; the store API is refused from other pages (even Min's UI). Updates: with the installed copy pretending to be 4.9.100, "Check for updates" installed 4.9.134 by itself; with it also pretending to have had fewer sites, the update waited, Settings offered the review, and the review showed only "Read and change all your data on all websites" before installing.

**Known gaps** (later phases, section 15):

- toolbar: every extension with an action gets a button (no overflow menu, pinning or hiding yet); MV2 `page_action` isn't shown; extensions' shortcuts can't be changed (Chrome's chrome://extensions/shortcuts);
- network filtering: Min's PDF viewer, the "block scripts/images" option and per-site exceptions for the extension aren't available in normal tabs while an extension filters requests; Min's and the extension's memory and CPU use haven't been compared;
- not possible or not done (survey): `userScripts` (Min's userscripts replace it; Violentmonkey and Tampermonkey ask for Chrome's "Allow User Scripts"), `identity.getAuthToken` (Google sign-in through Chrome), `tabCapture` and `desktopCapture` (Loom, Awesome Screenshot recording; Volume Master), `gcm`/`instanceID`, `tabGroups`, `tabs.move`/`highlight`/`group` (tab `index` is always -1: main doesn't know Min's tab order), `bookmarks`, `history`, `sessions`, `readingList`, `topSites` (empty), `omnibox`, `fontSettings`, `contentSettings`, `pageCapture`, `declarativeContent`, `chrome_url_overrides` (Momentum's new tab);
- content scripts: `chrome.extension` is missing (Momentum's site script);
- extensions' hidden pages (offscreen documents) can't use the camera, microphone or screen (pitfall 32);
- side panels: fixed width, one per window, a tab's own panel path only applies when the panel opens; privacy settings don't change Min (for example `passwordSavingEnabled` could turn off Min's own password capture).

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
- **Commits** use a conventional prefix (`feat:`, `fix:`, `perf:`, `chore:`, `feat(filtering):`), with a body listing changes as bullets. Branches are named `feat/…`, `fix/…`, `perf/…`, `chore/…`. Open a PR into `master`.
- **Don't reformat unrelated code.** `npm run lint` rewrites files, so don't run it as part of an unrelated change. `js/preload/siteUnbreak.js` lacks a trailing newline upstream; leave it.

## 13. Verifying changes

Apart from the unit tests for the userscript matcher and the extension package helpers (`npm run test:unit`), there are no automated tests, so verify by running the app.

- **Quick checks:**
  - `node --check <file>`
  - `npm run build`, then `node --check main.build.js`
  - Launch `npm start` and watch the terminal for exceptions.
- **Driving the app from a script** (this is how the YouTube bugs were found):
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
- **The dev profile holds the user's own test data too.** A test script must back up what it changes there and put it back (`settings.json`, `sessionRestore.json`, `passwordStore`; move `userscripts/`, `userscriptData/`, `extensions/` and `extensions.json` aside instead of deleting them). Running the app also rewrites `sessionRestore.json`.
- **Every scripted run must stop by itself, and put the profile back even when it's stopped.** An uncaught exception in main makes Electron show a dialog that **blocks the main process** until someone clicks OK, so a script waiting on main hangs (this happened, pitfall 20). So:
  - right after connecting to main, add `process.on('uncaughtException', …)` there (any listener stops the dialog) and record the errors;
  - a watchdog: every few seconds, read those errors, check main still answers (10 s) and Min is still running; stop the run on any of them;
  - a time limit for the whole run;
  - the profile backup script records what it set aside before touching anything (a `state.json` in the backup folder), so a run that was killed is restored by the next run, first thing; it also restores on Ctrl+C. After any interrupted run, check for leftover backup folders.
- **Driving dialogs and main from a script:** add `--inspect=9339` and connect to the Node inspector (`http://127.0.0.1:9339/json/list`) to run code in main, through `process.mainModule.require('electron')`. Main's top-level `let`/`const` aren't reachable there (module scope). Native dialogs can be replaced for a test: `electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })`, `showMessageBox = async () => ({ response: 0 })`. Then call `extensionPages.request(...)` in a Settings tab over CDP. The UI's own IPC handlers can be triggered with `ipc.emit('addTab', {}, { url })`. Extension workers are `service_worker` targets in `/json/list`, and `session.serviceWorkers.on('console-message')` shows their errors, preload failures included.
- **Comparing Electron versions:** install the other version in a separate folder (`npm install electron@<version>` there) and launch it with `cwd` set to the repo, so both run the same app code.
- **YouTube rations ads per visitor.** The dev profile keeps its YouTube cookies, so consecutive test runs alternate: one gets an ad (and in-app clicks stall about 20 s), the next doesn't. Alternating two builds (A, B, A, B) therefore makes one build look worse. Run each build at least twice in a row before blaming it.
- **A locked screen** counts as covering every window: visible-window tests (frames per second, flicker) give 0 while Windows is locked (`LogonUI` running).
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
32. Extensions' offscreen documents (and Manifest V2 background pages) are made by Electron's extension system, not as Electron web contents (`getLastWebPreferences()` is null, context isolation is off). `navigator.mediaDevices.enumerateDevices()` or `getUserMedia()` there crashes the whole browser (exit code 0x80000003, no message in a release build); Awesome Screenshot does it when its popup opens. `extensionSupportEarly.js` makes those calls fail in extension pages without context isolation. Creating the document and `navigator.permissions.query` are fine.
33. Writing an extension's files with synchronous `fs` calls froze the main process: Wappalyzer's 13,346 files took 21 s to write and 10 s to remove on Windows (each file is scanned). Written with `fs.promises`, 16 at a time, it takes 10 s and the main process never pauses more than about 80 ms.
34. `sendIPCToWindow` sends `data || {}`: `null` arrives as `{}`. Send an explicit value (the side panel sends `{extensionId: null}`).
35. `will-download` has no `webContents` for a download started with `session.downloadURL` (an extension's background worker); `download.js` assumed one and threw.
36. On YouTube, Chromium logs "Unsafe attempt to load URL chrome-extension://… Domains, protocols and ports must match." for extensions' web-accessible files that do load (checked with a test extension: images, scripts, frames, fetch and dynamic URLs all load there and on example.com). It isn't a failure.
37. `capturePage()` (and so `tabs.captureVisibleTab`) of a covered window fails ("Current display surface not available for capture"): covered windows draw nothing (section 10.4). Scripted tests keep the window on top.
38. `setView` removes every child view of the window but the UI's before adding the tab's, so any other view of Min's (the side panel) has to be added back after it, and placed from the tab's bounds.
39. Electron 45.2 added `chrome.storage.sync` (content scripts on 45.1 got the error `"sync" is not available in this instance of Chrome`), but `electron-chrome-extensions` 4.10 still sets `storage.sync = storage.local` in extensions' pages and workers: settings saved there by a popup were invisible to its content scripts. `extensionSupport.js` restores the real `sync`. Settings saved in `sync` before 45.2 stayed in `local`.
40. In the UI window, `settings` isn't a global: the bundle's modules are scoped, so a test's `Runtime.evaluate("settings.set(...)")` throws, and a harness that ignores the result silently changes nothing (two earlier test scripts did this). `ipc`, `tabs` and `tasks` are globals. Change a setting with `ipc.send('settingChanged', key, value)` (main saves it, applies it and tells the other windows), or edit `settings.json` while Min is closed.

## 15. Open work

- Decide on statistics (`js/statistics.js`): turn off by default, or point at a fork-owned endpoint.
- Bump `package.json` `version` for fork releases.
- Document-start scriptlet injection, only if YouTube's late-injection limits become a problem. It could share the userscripts' sync request (section 10.8).
- Userscripts: unsupported functions (`GM_cookie`, `GM_getTab`/`saveTab`/`getTabs`, `window.onurlchange`), and `GM_openInTab`'s `closed`/`onclose`. Add them if real scripts need them.
- Upstream's Electron upgrade (PalmerAL, `5c7b7aca` to 44 and `441e751e` to 45.2.1, compared 2026-11-05): the same changes as ours (clipboard through main, safeStorage's async methods with a queue, no 32-bit builds). Taken from it: Electron 45.2.x (45.2.2 here, newer) and async file reads and writes in `keychainService.js`. Ours stays where it's stricter: the clipboard handlers only answer Min's own windows (upstream's answer any sender), and back/forward use `webContents.navigationHistory` (upstream still calls the deprecated methods). Upstream's clipboard channel is `clipboardWriteItem` (`ipc.send` with raw `ClipboardItem` data); ours is `clipboardWrite` (`{text, html, bookmark}`); keep ours when merging upstream. Rechecked on 45.2.2: every extension suite (core 58, toolbar 23, network 28, Web Store 30, APIs 35, footprint 4, startup 3, YouTube 3, all passing; YouTube's page scripts no longer get the sync error), a new 9-check run (the Electron version, `storage.sync` shared by a worker, a content script and a popup and kept after a restart, the password store with five saves at once, a delete and a restart), and both userscript suites (the same results as on 45.1, apart from timings and log noise). Min's workarounds for Electron's own behaviour were each retested on 45.2.2 with the workaround switched off, and all are still needed: Electron still sends neither `runtime.onInstalled` nor `onStartup`; `browser` is still a separate object without the library's additions (pitfall 17); rulesets marked `enabled` still load switched off (pitfall 26); and media in an offscreen document still crashes the browser (pitfall 32). The only one 45.2 made unnecessary was the extension library's own `storage.sync` → `local` stand-in, which `extensionSupport.js` now undoes (pitfall 39).
- Chrome extension support, in seven phases. Done: (1) Electron 45.1 (PR #9, now 45.2.2); (2) a spike with real extensions (findings below and in section 10.9); (3) the core, (4) Chrome Web Store installs and updates, (5) toolbar buttons, popups, menus, options pages and shortcuts, (6) network-filtering extensions in place of Min's ad blocker, and (7) the APIs popular extensions use, a crash and a freeze fixed, idle extensions trimmed and restored tabs waiting for extensions, merged in PR #10 (section 10.9). Decisions: aim for any Chrome Web Store extension, installed as in Chrome; heavy extensions are the user's choice (Min shows their memory and CPU, and warns); zero cost with none installed. Open:
  - Open after phase 4: the store shows its "Switch to Chrome" banner and pop-up to Min (installing works anyway). Hiding them would mean telling the store, on that site only, that Min is Google Chrome (`navigator.userAgentData` brands and the `Sec-CH-UA` headers); not decided. Requests from the main process (the ad-block lists, extension downloads) go through Min's own ad blocker in the default session; none of their URLs match today's rules, but a rule that did would block them.
  - Open after phase 5: with many extensions the toolbar has no overflow menu, pinning or hiding (Chrome's puzzle-piece menu); no page for changing extensions' shortcuts; MV2 `page_action` buttons aren't shown.
  - Open after phase 6: compare the footprint of Min's ad blocker with an extension's (uBO Lite's rules are matched natively, so it may well be cheaper); Min's PDF viewer in that mode (it would need the PDF fetched through main, like reader view).
  - Open after phase 7: the API gaps listed in section 10.9 (the camera and microphone in offscreen documents would need an Electron fix; `tabCapture`/`desktopCapture` could use Min's screen-share picker; Min's tab order for `tabs.move` and `index`; `storage.sync` in content scripts); test real extensions' side panels (Grammarly, DeepL, Bitwarden) by hand; let the privacy settings act on Min (password saving).
  - Spike notes on real extensions: Dark Reader darkens pages and its full popup works. Bitwarden's worker runs (including its WebAssembly SDK) and its popup shows the log-in screen; signing in wasn't tried. uBO Lite crashed at start because of the separate `browser` object (pitfall 17), now fixed.
- Recheck on Electron 45 with the screen unlocked: a covered window's visible case (fps) and no flicker when switching back (section 10.4).
- Potential issue, fix only if reported: whole-app trimming also trims the audio, GPU and network processes while a tab plays media or is in a call (section 10.4, "Potential issue"), which could cause audio dropouts or video stutter. The fix is a few lines in `getProtectedPids()`.
- The remaining low-footprint items in section 10.4.
- Ghostery `data:` redirect failures. A possible fix is serving stubs from a privileged custom protocol.
- `.nvmrc` is stale (15.7.0).
