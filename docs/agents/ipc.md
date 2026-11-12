# 8. IPC catalogue

Section 8 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

Channels are plain strings. To find both ends of a channel, search for its name.

## Handled in the main process

| Group | Channels (handler file) |
|---|---|
| Views (`viewManager.js`) | `createView`, `destroyView`, `destroyAllViews`, `setView`, `setBounds`, `focusView`, `hideCurrentView`, `loadURLInView`, `callViewMethod`, `getCapture`, `saveViewCapture`, `getNavigationHistory` (handle) |
| Window and app (`main.js`) | `session-saved-before-close` (the UI saved, the window can close; `windowManagement.js`), `set-window-title`, `focusMainWebContents`, `showSecondaryMenu`, `quit`, `handoffUpdate`, `tab-state-change`, `request-tab-state`, `return-tab-state` (once), `places-connect`, `page-translation-session-create` |
| `remoteActions.js` (handle) | `minimize`, `maximize`, `unmaximize`, `close`, `setFullScreen`, `showOpenDialog`, `showSaveDialog`, `showItemInFolder`, `startFileDrag`, `clearStorageData` (keeps installed extensions' data), `addWordToSpellCheckerDictionary`, `showFocusModeDialog2`, `clipboardReadText`, `clipboardWrite` (`{text, html, bookmark}`; UI only: renderers can't use Electron's `clipboard` since Electron 44, and the main-process API is async). Also `newWindow` (on) |
| Page start | `page-start` (**sync**, `userscripts.js`; every http, https and file frame's preload sends it once as the frame starts and waits): answers `{cosmetics, userscripts}`. `cosmetics`, for a tab's top frame only (`getCosmeticsForPageStart` in `filtering.js`, which also inserts the hiding CSS): `{scriptlets, dom, whileLoading}` (`whileLoading`: the setting `hideAdSpacesWhileLoading`). `userscripts`: this frame's scripts. It replaced `cosmetic-filters-start` and `userscripts-get` on 2026-11-12 |
| Filtering | `cosmetic-filters-dom` (the page's new classes, ids and links, `{classes, ids, hrefs}`; main inserts the generic rules' CSS); `internal-page-fetch` (handle, `download.js`; from reader view, relayed by `js/preload/default.js`) |
| Permissions (`permissionManager.js`) | `permissionGranted`, `permissionDenied` (from the UI), `media-access-status` (from the preload) |
| Downloads | `cancelDownload` (`download.js`) |
| Settings | `settingChanged` (`settingsMain.js`) |
| Userscripts (`userscripts*.js`) | from the preload (a frame's scripts come in `page-start`'s answer): `userscripts-set-values`, `userscripts-menu-command-add`/`-remove`, `userscripts-xhr`, `userscripts-xhr-abort`, `userscripts-download`, `userscripts-open-tab` (handle), `userscripts-close-tab`, `userscripts-set-clipboard`, `userscripts-notification`, `userscripts-resource` (**sync**), `userscripts-install-prompt` (`file:` only), `userscripts-page` (handle; the install page and Settings only). From the UI: `userscripts-list`, `userscripts-run`, `userscripts-menu-commands`, `userscripts-menu-command-run` (handle), `userscripts-tab-opened` |
| Extensions (`extensions.js`) | `extensions-page` (handle; from the top frame of `min://app/pages/settings/` only, relayed by the userscripts preload), `extensions-webstore` (handle; from the top frame of a `https://chromewebstore.google.com` tab only, sent by `webStore.js`), `extensions-tab-opened` (from the UI), `extensions-tab-list` (from the UI: its tasks' tabs in order, `extensionTabs.js`), `min-extension-lifecycle` (handle on an extension worker's `ServiceWorkerMain.ipc`, from `extensionSupport.js`). From the UI's toolbar: `extensions-toolbar-get` (handle), `extensions-toolbar-click` (handle; `{id, anchorRect}`), `extensions-toolbar-menu` (`{id, x, y}`), `extensions-command` (`{extensionId, name}`), `extensions-side-panel-close`, `extensions-tts-voices`, `extensions-tts-event` (`extensionAPIs.js`). Extensions' own calls to the APIs Min adds go through the library's `crx-msg` (section 10.9). To extensions' workers and frames: `min-extension-restore-apis` (`restoreExtensionAPIsEverywhere`, after any extension loads or unloads; pitfall 47) |
| Passwords (`keychainService.js`, handle) | `credentialStoreGetCredentials`, `credentialStoreSetPassword`, `credentialStoreSetPasswordBulk`, `credentialStoreDeletePassword` |
| Menus and prompts | `open-context-menu` (`remoteMenu.js`; `extensionsTabId` in its data adds that tab's extension items); `prompt` (sync), `open-prompt`, `show-prompt`, `close-prompt` (`prompt.js`) |

## Main process to UI (`sendIPCToWindow(win, channel, data)`)

| Group | Channels |
|---|---|
| Views | `view-event` (page events, from `viewManager.js`), `view-ipc` (page IPC forwarded), `async-call-result`, `captureData` |
| App menu commands | `addTab`, `addPrivateTab`, `addTask`, `goBack`, `goForward`, `zoomIn`, `zoomOut`, `zoomReset`, `print`, `findInPage`, `inspectPage`, `showHistory`, `showBookmarks`, `toggleTaskOverlay`, `saveCurrentPage`, `openEditor`, `enterFocusMode`, `exitFocusMode` |
| Window state | `save-session-before-close` (save now: the window is closing, Min is quitting or Windows is shutting down; `{evenInBackground: this window saves although it isn't focused, noAnswer: don't reply (a shutdown)}`), `focus`, `blur`, `windowFocus`, `minimize`, `maximize`, `unmaximize`, `enter-full-screen`, `leave-full-screen`, `enter-html-full-screen`, `leave-html-full-screen`, `before-input-event` |
| Features | `updatePermissions` (fork), `hibernateTab` (fork), `userscripts-changed`, `userscripts-open-tab`, `userscripts-close-tab`, `extensions-open-tab`, `extensions-select-tab`, `extensions-close-tab`, `extensions-load-tab` (`{tabId, url}`: an extension reloaded a discarded tab or gave it an address), `extensions-mute-tab` (`{tabId, muted}`), `extensions-tab-list-wanted` (send tab lists from now on), `extensions-toolbar` (fork; and `extensions-webstore-event` straight to store tabs), `extensions-side-panel` (`{extensionId: null}` when closed), `extensions-tts`, `extensions-search`, `download-info`, `openPDF`, `set-file-view`, `tab-state-change-receive`, `read-tab-state` |

## From the preload (`ipcRenderer.send` in `js/preload/*`)

- **Forwarded to the UI and handled with `webviews.bindIPC(name)`:** `pageData`, `canReader`, `close-window`, `contextMenuData`, `downloadFile`, `getSettingsData`, `setSetting`, `scroll-position-change`, `wheel-event`, `password-autofill`, `password-autofill-check`, `password-form-filled`, `showCredentialList`, `showUserscriptDirectory`.
- **Handled directly in main:** `page-start` (sync), `cosmetic-filters-dom`, `media-access-status`, the `userscripts-*` channels (`viewManager.js` doesn't forward these to the UI: they can carry saved values and request bodies), `page-translation-session-create` (`ipcRenderer.postMessage` with a `MessagePort`).

## From the UI to a page

`webviews.callAsync(tabId, 'send' | 'sendToFrame', [channel, ...args])`. The preload listens with `ipc.on`:

- `getContextMenuData`
- `password-autofill-match`, `password-autofill-enabled`, `password-autofill-shortcut`
- `generate-password`
- `translate-page`
- `enterPictureInPicture`
- `receiveSettingsData` (for `min://` pages)
