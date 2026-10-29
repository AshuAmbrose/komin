# AGENTS.md

Context for AI coding agents (and humans) working on this repository. Read it fully before changing code: it records facts that are hard to recover from the source, decisions already made, and bugs that were expensive to find.

This file describes the code as of commit `edd15667` on `master`. When the code and this file disagree, the code wins. Fix this file in the same change.

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
  - Ghostery ad blocking with fresh uBlock Origin / EasyList lists.

## 3. Stack and versions

| Thing | Version / detail |
|---|---|
| Electron | 43.4.1 (`package.json` `electronVersion` and devDependency), bundling Chromium 150 |
| Ad blocking | `@ghostery/adblocker-electron` 2.20.1 (with `@ghostery/adblocker`, `-content`, `-electron-preload`, `-extended-selectors` at the same version) |
| UI bundler | browserify 16 + `electron-renderify` |
| Packaging | electron-builder 24, `electron-installer-windows` (Squirrel), archiver |
| Lint | `standard` 14 (`npm test`), prettier for css/md/html/json (`npm run lint`) |
| Node | CI uses Node 25. Local development worked on Node 22. `.nvmrc` says 15.7.0, which is stale. |
| Platform focus | Windows (x64). `trimMemory.exe` and some optimizations are Windows-only. |

## 4. Commands

```bash
npm install                 # postinstall runs scripts/setupDevEnv.js (flips an Electron fuse on node_modules/electron)
npm start                   # npm run build, then concurrently: scripts/watch.js + `electron . --development-mode`
npm run build               # buildMain + buildBrowser + buildBrowserStyles + buildPreload
npm test                    # lint only (standard). No unit tests exist.
npm run lint                # REWRITES files (prettier --write, standard --fix)
node scripts/buildWindows.js --arch=x64   # package x64 only (run `npm run build` first)
npm run buildWindows        # build + package x64, ia32, arm64 (slow)
npm run buildWindowsDev     # "Min-Dev" variant with a separate app identity
npm run updateFilters       # refresh ext/filterLists/easylist+easyprivacy-noelementhiding.txt (offline fallback list)
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
   - `js-flags=--optimize-for-size`
   - `settings.initialize`
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
| `scripts/buildMain.js` | `main.build.js` | concatenates in **this order**: `dist/localization.build.js`, `main/windowManagement.js`, `js/util/keyMap.js`, `main/menu.js`, `main/touchbar.js`, `main/registryConfig.js`, `js/util/settings/settingsMain.js`, `main/main.js`, `main/minInternalProtocol.js`, `main/filtering.js`, `main/viewManager.js`, `main/download.js`, `main/UASwitcher.js`, `main/permissionManager.js`, `main/prompt.js`, `main/remoteMenu.js`, `main/remoteActions.js`, `main/keychainService.js`, `js/util/proxy.js`, `main/themeMain.js` |
| `scripts/buildBrowser.js` | `dist/build.js` then `dist/bundle.js` | browserify of `dist/localization.build.js` + `js/default.js`, with `paths: [root, js/]` and `node: true`; `chokidar` and `write-file-atomic` excluded |
| `scripts/buildBrowserStyles.js` | `dist/bundle.css` | concatenates `css/*.css` (fixed list) + dragula css |
| `scripts/buildPreload.js` | `dist/preload.js` | concatenates `js/preload/default.js`, `textExtractor.js`, `readerDetector.js`, `siteUnbreak.js`, `mediaTracker.js`, `js/util/settings/settingsPreload.js`, `js/preload/passwordFill.js`, `js/preload/translate.js` |

Consequences of the concatenation:

- **Lint noise:** `npm test` reports many "X is not defined" errors for cross-file globals. These are noise, not bugs. The fork's main-process code often guards with `typeof fn === 'function'`; those guards are harmless.
- **Load order:** top-level code runs in the order above. A function defined in a later file can only be *called* after load (inside handlers), not at load time.
- **One script scope:** all main-process files share one scope, so two files must not declare the same top-level name.

### Packaging

- **`scripts/createPackage.js`** runs electron-builder with a `dir` target into `dist/app/win-unpacked`.
  - `asar: false`, `npmRebuild: false`.
  - `files` excludes `main/` (it's bundled), `scripts/`, `localization/`, `*.md`, maps, `icons/source` and `dist/app`.
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
| `viewManager.js` | tab views: globals `viewMap`, `viewStateMap`, `tabLastActivity`. Functions `createView`, `destroyView`, `destroyAllViews`, `setView`, `setBounds`, `focusView`, `hideCurrentView`, `loadURLInView`, `getView`, `getTabIDFromWebContents`, `getWindowFromViewContents`. `callViewMethod` lets the UI call any `webContents` method. It forwards page events (`view-event`) and page IPC (`view-ipc`) to the UI. Also tab memory trimming (`getInactiveTabPids`, `trimInactiveTabsNow`, `scheduleInactiveTabTrim`) and hibernation (`isTabImmuneFromHibernation`, `checkSmartHibernation`). |
| `filtering.js` | network blocking + Ghostery engine + cosmetic filters + scriptlets + tracking-parameter removal (section 10.2) |
| `download.js` | `will-download` handling (`downloadHandler`, `currrentDownloadItems`; the triple `r` is an upstream typo, keep it). Also `onHeadersReceived` (PDF to viewer, file-view detection, CORS for `min://` UI/reader/PDF pages, ad-block CSP) and `onBeforeRedirect` |
| `UASwitcher.js` | strips `Min`/`Electron` from the user agent; `customUserAgent` setting; Firefox UA and no `Sec-CH-UA*` headers for `accounts.google.com` (Google sign-in) |
| `permissionManager.js` | permission request/check/display-media handlers, prompts, persistence (section 10.3) |
| `minInternalProtocol.js` | `min://` scheme (privileged: standard, secure, supportFetchAPI). `registerBundleProtocol(ses)` serves only host `app` from the app directory and rejects path traversal |
| `menu.js`, `touchbar.js` | app menu (sends commands to the UI through `sendIPCToWindow`), dock menu, macOS Touch Bar |
| `remoteActions.js`, `remoteMenu.js`, `prompt.js` | `ipc.handle` wrappers for main-only APIs (dialogs, window controls, file drag, clear storage), native context menus, modal prompt windows |
| `keychainService.js` | built-in password store: `<userData>/passwordStore`, encrypted with `safeStorage` |
| `registryConfig.js` | Windows default-browser registry keys (on Squirrel install, update and uninstall) |
| `themeMain.js` | `darkMode` setting to `nativeTheme.themeSource`, `darkThemeIsActive` |

### `js/` (browser UI renderer)

| Path | Responsibility |
|---|---|
| `default.js` | entry point (see startup) |
| `tabState.js`, `tabState/` | data model: global `tasks` (`TaskList`), global `tabs` (the selected task's `TabList`) |
| `browserUI.js` | `addTab`, `closeTab`, `destroyTab`, `switchToTab`, `addTask`, `closeTask`, `switchToTask`, `setWindowTitle`. Each keeps the model, the tab bar DOM and the views in sync. |
| `webviews.js` | the UI's interface to tab views: `add`, `setSelected`, `update` (load URL), `destroy`, `bindEvent`, `bindIPC`, `callAsync`, `requestPlaceholder`, `hidePlaceholder`, `adjustMargin`, `focus`, `hasViewForTab`, `selectedId`. Also the `hibernateTab` handler, the error page on `did-fail-load`, and preview capture. |
| `navbar/` | `tabBar.js`, `tabEditor.js` (address bar), `navigationButtons.js`, `progressBar.js`, `tabColor.js`, `tabActivity.js`, `contentBlockingToggle.js` (per-site exception), `permissionRequests.js` (fork: permission bar and tab icons), `bookmarkStar.js`, `tabContextMenu.js`, `menuButton.js`, `addTabButton.js` |
| `searchbar/` | suggestion plugins: `searchbarPlugins.register(name, {index, trigger, showResults})`, `addResult(name, {title, url, icon, descriptionBlock, ...})`, `reset(name)`, `getContainer(name)`. Plugins are required and initialized in `js/default.js`. |
| `places/` | `places.js` (UI side, `MessageChannel` to the places service), `placesService.js`, `placesSearch.js`, `fullTextSearch.js` (tokenize, stem, `searchIndex` lookup), `tagIndex.js` |
| `taskOverlay/` | task overview screen |
| `keybindings.js`, `defaultKeybindings.js` | `keybindings.defineShortcut(nameOrKeys, fn, options)`. Names map to keys in `js/util/keyMap.js` (for example `addTab: 'mod+t'`); raw keys use `{ keys: 'mod+shift+y' }`. Users override keys with the `keyMap` setting. |
| `sessionRestore.js` | saves `<userData>/sessionRestore.json` every 30 s (private tabs excluded); `restore()`, `restoreFromFile()`, `syncWithWindow()` |
| `windowSync.js` | multi-window state sync through main (`tab-state-change`, then `tab-state-change-receive`) |
| `webviewMenu.js` | page context menu (asks the preload for `getContextMenuData`, then `contextMenuData`) |
| `readerView.js`, `readerDecision.js`, `pdfViewer.js` | reader view and PDF viewer integration |
| `passwordManager/` | Bitwarden / 1Password (CLI in `<userData>/tools`), built-in keychain, capture bar, viewer |
| `downloadManager.js` | download bar (state in memory only) |
| `userscripts.js` | runs `<userData>/userscripts/*.js` matched by `@match` (setting `userscriptsEnabled`); `!run` bang |
| `statistics.js` | anonymous daily usage stats to `https://services.minbrowser.org/stats/v1/collect` unless `collectUsageStats === false` |
| `util/` | `urlParser.js` (`parse`: adds `https://`, HTTPS upgrade list, search fallback, `min://name` expansion; `isInternalURL`, `getDomain`), `settings/settings.js` (UI settings API), `keyMap.js`, `searchEngine.js`, `database.js` (Dexie `browsingData2`), `theme.js`, `process.js` |

### Other folders

- `js/preload/` runs in pages (section 10.5).
- `pages/` holds internal pages served at `min://app/pages/...`: `settings` (includes the fork's site-settings UI), `error`, `newtab`, `pdfViewer`, `translateService`, `sessionRestoreError`, `prompt`, `phishing`.
- `reader/` is reader view; it uses Mozilla Readability from `ext/readability-master`.
- `ext/` holds:
  - `abp-filter-parser-modified` (Min's original filter parser)
  - `filterLists` (`minFilters.txt`; `easylist+easyprivacy-noelementhiding.txt`, the offline fallback)
  - `publicSuffixes`
  - `httpsUpgrade`
  - `franc` (language detection)
  - `xregexp`
  - `textColor` (a tiny neural net that picks tab text color)
  - `icons`
  - `windows/trimMemory.exe` (prebuilt; source `scripts/trimMemory.cs`; no build script)
- `localization/languages/*.json` holds translations. Code uses `l('stringId')`; static HTML uses `data-string`, `data-label` and `data-value` attributes. Add new user-visible strings to `en-US.json`.

## 8. IPC catalogue

Channels are plain strings. To find both ends of a channel, search for its name.

### Handled in the main process

| Group | Channels (handler file) |
|---|---|
| Views (`viewManager.js`) | `createView`, `destroyView`, `destroyAllViews`, `setView`, `setBounds`, `focusView`, `hideCurrentView`, `loadURLInView`, `callViewMethod`, `getCapture`, `saveViewCapture`, `getNavigationHistory` (handle) |
| Window and app (`main.js`) | `set-window-title`, `focusMainWebContents`, `showSecondaryMenu`, `quit`, `handoffUpdate`, `tab-state-change`, `request-tab-state`, `return-tab-state` (once), `places-connect`, `page-translation-session-create` |
| `remoteActions.js` (handle) | `minimize`, `maximize`, `unmaximize`, `close`, `setFullScreen`, `showOpenDialog`, `showSaveDialog`, `showItemInFolder`, `startFileDrag`, `clearStorageData`, `addWordToSpellCheckerDictionary`, `showFocusModeDialog2`. Also `newWindow` (on) |
| Filtering | `inject-cosmetic-filters` (`filtering.js`, sent by the preload) |
| Permissions (`permissionManager.js`) | `permissionGranted`, `permissionDenied` (from the UI), `media-access-status` (from the preload) |
| Downloads | `cancelDownload` (`download.js`) |
| Settings | `settingChanged` (`settingsMain.js`) |
| Passwords (`keychainService.js`, handle) | `credentialStoreGetCredentials`, `credentialStoreSetPassword`, `credentialStoreSetPasswordBulk`, `credentialStoreDeletePassword` |
| Menus and prompts | `open-context-menu` (`remoteMenu.js`); `prompt` (sync), `open-prompt`, `show-prompt`, `close-prompt` (`prompt.js`) |

### Main process to UI (`sendIPCToWindow(win, channel, data)`)

| Group | Channels |
|---|---|
| Views | `view-event` (page events, from `viewManager.js`), `view-ipc` (page IPC forwarded), `async-call-result`, `captureData` |
| App menu commands | `addTab`, `addPrivateTab`, `addTask`, `goBack`, `goForward`, `zoomIn`, `zoomOut`, `zoomReset`, `print`, `findInPage`, `inspectPage`, `showHistory`, `showBookmarks`, `toggleTaskOverlay`, `saveCurrentPage`, `openEditor`, `enterFocusMode`, `exitFocusMode` |
| Window state | `focus`, `blur`, `windowFocus`, `minimize`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `enter-html-full-screen`, `leave-html-full-screen`, `before-input-event` |
| Features | `updatePermissions` (fork), `hibernateTab` (fork), `download-info`, `openPDF`, `set-file-view`, `tab-state-change-receive`, `read-tab-state` |

### From the preload (`ipcRenderer.send` in `js/preload/*`)

- **Forwarded to the UI and handled with `webviews.bindIPC(name)`:** `pageData`, `canReader`, `close-window`, `contextMenuData`, `downloadFile`, `getSettingsData`, `setSetting`, `scroll-position-change`, `wheel-event`, `password-autofill`, `password-autofill-check`, `password-form-filled`, `showCredentialList`, `showUserscriptDirectory`.
- **Handled directly in main:** `inject-cosmetic-filters`, `media-access-status`, `page-translation-session-create` (`ipcRenderer.postMessage` with a `MessagePort`).

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
- **`callViewMethod`** calls a method or sets a property on the view's `webContents`, then replies `async-call-result`. Callers use `webviews.callAsync(id, method, argsOrCallback, callback)`.
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
2. `loadCachedAdblockerEngine` reads `<userData>/adblocker-engine-v2.bin`, about 17 ms. If that fails, `downloadAdblockerEngine` runs `ElectronBlocker.fromLists(fetch, ADBLOCKER_LISTS)` and writes the cache.
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
- The `powerMonitor` suspend/resume listeners are added per window and removed on `closed`.

**Inactive-tab trimming** (`viewManager.js`). Every 60 s, and 30 s after a tab switch, `getInactiveTabPids` trims tabs inactive for 30 s or more.

- It includes their cross-site frame processes (ads, embeds), found with `getFramePids`, which uses `webContents.mainFrame.framesInSubtree` and each frame's `osProcessId`.
- It never trims a process that also serves a protected tab (selected, media or capture, or used in the last 30 s) or the browser UI. Chromium can share one process between tabs.

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

**Covered windows idle.** Upstream's `disable-backgrounding-occluded-windows` switch was removed. A fully covered window's pages are treated as hidden: 0 fps and 0% CPU/GPU, versus about 69 fps and about 40% of a core before. The user confirmed there's no focus flicker on Electron 43. Audio, calls and notifications continue.

**Other:**

- `backgroundThrottling: true` in the tab web preferences.
- `js-flags=--optimize-for-size`.
- Preview capture runs only when the UI is focused, plus once on blur.

**Not done yet** (candidates):

- EcoQoS / Efficiency mode and low memory priority while unfocused, skipping call tabs;
- removing the hibernation probe's wake-ups;
- skipping the blur screenshot;
- a persistent trimming helper instead of spawning `trimMemory.exe` every minute.

### 10.5 Preload scripts (`dist/preload.js`)

| File | Role |
|---|---|
| `default.js` | `inject-cosmetic-filters`; marks unsaved user input for hibernation (`data-min-unsaved-input`); forwards wheel/swipe (`wheel-event`) and scroll position; context-menu helpers and picture-in-picture; relays `postMessage` from `min://` pages (`showCredentialList`, `showUserscriptDirectory`, `downloadFile`) |
| `textExtractor.js` | page text (300k character cap) → `pageData`, sent on load and after `pushState`/`replaceState` (it hooks these in the main world) |
| `readerDetector.js` | `canReader` heuristic |
| `siteUnbreak.js` | main-world fixes run with `webFrame.executeJavaScript(scriptsToRun.join(';'))`: `window.close`, google.com/accounts/drive/news/calendar/meet, YouTube homepage title, WebSocket counter |
| `mediaTracker.js` | capture tracking (see permissions) |
| `settingsPreload.js` | `getSettingsData`/`setSetting` bridge for `min://` origins only |
| `passwordFill.js` | login form detection and autofill |
| `translate.js` | page translation via a `MessagePort` (`page-translation-session-create`) |

Rules for preload code:

- The preload is sandboxed. Only the limited `require('electron')` API is available; don't require npm packages.
- It runs in iframes too (`nodeIntegrationInSubFrames`). Gate page-wide work on `window === window.top`.
- Main-world injection (`webFrame.executeJavaScript`) is visible to the page and can be altered by it. Don't rely on it for security.

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
  - **Features:** `readerData`, `userscriptsEnabled`, `lastBookmarksBackup`, `phishingWhitelist`, `proxy`
  - **PDF viewer:** `pdfDayTheme`, `pdfNightTheme`, `PDFInvertColors`
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

## 11. Profile folder (`app.getPath('userData')`)

| Item | Path / notes |
|---|---|
| Installed browser | `%APPDATA%\Min` |
| `npm start` / dev | `%APPDATA%\Min-development` |
| Min-Dev package | `%APPDATA%\Min Dev` (its own identity) |
| Files | `settings.json`, `sessionRestore.json`, `windowBounds.json`, `passwordStore` (safeStorage-encrypted), `adblocker-engine-v2.bin`, optional `customFilters.txt`, `userscripts/`, `tools/` (Bitwarden/1Password CLIs), plus Chromium's own folders (IndexedDB holds history) |

## 12. Conventions

- **Style:** JavaScript Standard Style. 2 spaces, single quotes, **no semicolons**, a space before function parentheses. Older code uses `var` and `function () {}`; match the file you're editing. Keep comments short, as in the surrounding code.
- **Globals** declared in `package.json` → `standard.globals`: `l`, `tabs`, `tasks`, `globalArgs`, `platformType`, `throttle`, `debounce`, `empty`, and others.
- **User-visible text** goes through `l('key')`, with the English string added to `localization/languages/en-US.json`.
- **Commits** use a conventional prefix (`feat:`, `fix:`, `perf:`, `feat(filtering):`), with a body listing changes as bullets. Branches are named `feat/…`, `fix/…`, `perf/…`. Open a PR into `master`.
- **Don't reformat unrelated code.** `npm run lint` rewrites files, so don't run it as part of an unrelated change. `js/preload/siteUnbreak.js` lacks a trailing newline upstream; leave it.

## 13. Verifying changes

There are no automated tests, so verify by running the app.

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
- **Testing occlusion:** a window launched from a background process may open *behind* other windows. Force it on top first, for example with `SetWindowPos(HWND_TOPMOST)` through PowerShell `Add-Type`.

## 14. Pitfalls already hit (don't repeat them)

1. A `windows.getFocused()` call doesn't exist. Use `windows.getCurrent()`.
2. App-wide emitters (`powerMonitor`, `app`, `screen`) added inside per-window code must be removed when the window closes, or they act on dead windows.
3. `wc.isCapturing()` doesn't exist in Electron 43.
4. Session-scoped state must be keyed by `session`, or private and normal tabs leak into each other.
5. The ad-block cache never refreshed. Engine caches need an age-based refresh and an offline fallback.
6. Ghostery's `onInjectCosmeticFilters` breaks pages (section 10.2). So does `userGesture: true`.
7. Chromium refuses redirects to `data:` URLs (`ERR_UNSAFE_REDIRECT`).
8. `getCosmeticsFilters` scriptlets assume a shared `scriptletGlobals`. Without it, wrappers stack (2^n calls).
9. `executeJavaScript` in idle tabs (the hibernation probe) defeats memory trimming.
10. Squirrel and the same version number: an installer for the version already installed may not replace it.

## 15. Open work

- Decide on statistics (`js/statistics.js`): turn off by default, or point at a fork-owned endpoint.
- Bump `package.json` `version` for fork releases.
- Document-start scriptlet injection, only if YouTube's late-injection limits become a problem.
- The remaining low-footprint items in section 10.4.
- Ghostery `data:` redirect failures. A possible fix is serving stubs from a privileged custom protocol.
- `.nvmrc` is stale (15.7.0).
