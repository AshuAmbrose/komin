# 7. Repository map

Section 7 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

## `main/` (main process)

| File | Responsibility |
|---|---|
| `windowManagement.js` | global `windows`: `addWindow`, `removeWindow`, `getCurrent` (last focused), `getAll`, `getState(win)` (**throws** if the window was removed), `windowFromContents`, `openWindows` (`{id, win, state, closed}`). A closing window first asks its UI to save the session (`save-session-before-close`, section 10.7), and `savesSessionAtClose` picks the one window that saves even when none is focused; `query-session-end` (Windows shutting down) asks for the same save. Quits when the last window closes (except macOS). |
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
| `extensions.js` | Chrome extensions (section 10.9): `extensions.json`, starting `electron-chrome-extensions`, loading, `.crx` and unpacked installs with the permission review (`readExtensionCrx`, `installCheckedExtension`), Min's tabs for the library (`extensionsTabCreated`/`Shown`/`Destroyed`, `openTabForExtension`), lifecycle events, Settings requests, `clearTabStorageKeepingExtensions`, the Chrome Web Store page's API (`extensions-webstore`), updates (`checkExtensionUpdates`, `scheduleExtensionUpdates`), toolbar state and clicks (`getExtensionToolbar`, `scheduleExtensionToolbarUpdate`), the button menu, page menu items (`getExtensionContextMenuItems`), options pages, keyboard commands; extensions' processes for low-resource mode (`getExtensionProcesses`); restored tabs waiting for extensions at startup (`whenExtensionsLoadedFor`); telling running extensions to put their APIs back after another extension loads or unloads (`scheduleExtensionAPIRestore`, pitfall 47) |
| `extensionTabs.js` | what extensions see of Min's tabs (section 10.9): the UI's tab lists (`extensions-tab-list`), the library's tab store in Min's order with each tab's index, stand-ins for tabs without a page (discarded), hibernation not reported as closing (`tabs.onReplaced` when the tab loads again); checks first that the library's internals it uses are there, and stays off if not (`missingExtensionTabInternals`) |
| `extensionPermissions.js` | what an extension may know and do without the permission for it (section 10.9, pitfall 55): tabs' addresses, titles and icons (`tabsForExtension`, `extensionCanSeeTab`), cookies by permission and site, the webNavigation, notifications and contextMenus permissions, `activeTab` grants (`grantExtensionActiveTab`); wraps the library's handlers and its event sending (`startExtensionPermissionChecks`), and stays off if the library's internals changed |
| `extensionAPIs.js` | the extension APIs Min adds (section 10.9): `tabs.captureVisibleTab`/`detectLanguage`/`discard`, `downloads`, `privacy`, `identity`, side panels (`openExtensionSidePanel`, placed by `extensionsViewBoundsChanged`), `browsingData`, `search`, `tts`; handlers on the library's router (`registerExtensionAPIs`) |

## `js/` (browser UI renderer)

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

## Other folders

- `js/preload/` runs in pages (section 10.5).
- `pages/` holds internal pages served at `min://app/pages/...`: `settings` (includes the fork's site-settings UI, the userscript list and the Extensions section), `userscriptInstall` (fork), `error`, `newtab`, `pdfViewer`, `translateService`, `sessionRestoreError`, `prompt`. (Upstream's unused `phishing` page was removed, upstream `6350af50`, taken 2026-11-09.)
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
- `test/` holds the unit tests (`*.test.js`), `manual/` (a demo userscript) and `e2e/`: the end-to-end suites, the measurement scripts, the test extensions and their shared harness (section 13, `test/e2e/README.md`).
- `docs/` holds `inside-min.html` (the beginner's guide's source), `statistics.md` and `agents/` (the topic files that go with AGENTS.md, one per subsystem).
- `.claude/skills/` holds skills for Claude Code agents: `release` (shipping: checks, commit, push, PR text, installer).
- `localization/languages/*.json` holds translations. Code uses `l('stringId')`; static HTML uses `data-string`, `data-label` and `data-value` attributes. Add new user-visible strings to `en-US.json`.
