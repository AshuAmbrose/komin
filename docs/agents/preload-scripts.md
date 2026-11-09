# 10.5 Preload scripts (`dist/preload.js`)

Section 10.5 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

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
