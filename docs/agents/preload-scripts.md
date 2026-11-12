# 10.5 Preload scripts (`dist/preload.js`)

Section 10.5 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

| File | Role |
|---|---|
| `default.js` | the frame's one request to main as it starts (`page-start`, sync; http, https and file frames): the answer's `cosmetics` are the ad blocker's scriptlets, run with `webFrame.executeJavaScript` before the page's own scripts (section 10.2), and its `userscripts` are run by `userscripts.js` below; the page's classes, ids and links for generic hiding rules (`reportCosmeticFeatures`: Ghostery's `DOMMonitor`: a shown page once it's parsed, or from its root element on, while it's still arriving, when the start answer's `whileLoading` says so (the setting `hideAdSpacesWhileLoading`); one loaded hidden once it's parsed; then new ones as the page changes, stopped while hidden; `cosmetic-filters-dom`); marks unsaved user input for hibernation (`data-min-unsaved-input`); forwards wheel/swipe (`wheel-event`) and scroll position; context-menu helpers and picture-in-picture; relays `postMessage` from `min://` pages (`showCredentialList`, `showUserscriptDirectory`, `downloadFile`, and `internalPageFetch` for reader view) |
| (internal pages) | the messages internal pages send themselves (`settingsPreload.js`'s `getSettingsData`/`setSetting`, `default.js`'s `showCredentialList`, `downloadFile` and the others, and `settingsContent.js`'s `receiveSettingsData` in the page) are only taken from the page's own window (`e.source === window`), since 2026-11-13: a website that had opened an internal page as a popup could post it made-up settings (`security-checks` B1) |
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
