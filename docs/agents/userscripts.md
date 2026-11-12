# 10.8 Userscripts (`main/userscripts.js`, `main/userscriptAPI.js`, `main/userscriptInstall.js`, `js/preload/userscripts.js`, `js/util/userscriptMatching.js`)

Section 10.8 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

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

**Running.** A frame's scripts come in the answer to its one request to main at document start (`ipc.sendSync('page-start')` in `js/preload/default.js`, answered in `main/userscripts.js`; the answer's `userscripts`, which `js/preload/userscripts.js` runs; until 2026-11-12 a request of its own, `userscripts-get`). Main matches against `event.senderFrame.url` (not a renderer-supplied URL), drops `@noframes` scripts in subframes and `context-menu` scripts, and replies `[{id, name, runAt, code, params, grants, info, values}]` or `null`. The handler must always set `event.returnValue`, or the page hangs.

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

**Cost.** The sync request (`page-start`, shared with the ad blocker since 2026-11-12) runs in every http/https/file frame even with no scripts; main answers in about 0.1–0.3 ms (about 1 ms for a page with nine matching scripts and their saved values). No background process; update checks are a few HTTP requests a day.

**Measured** (dev build, scripted with CDP; now `test/e2e/userscripts-*.js`): run-at order, iframes and `@noframes`, `@exclude`, strict CSP + Trusted Types, legacy scripts, manual runs, live reload, private tabs, switching off; every function in the table above, including `@connect` refusals and values reaching other tabs; installing from a link and from a local file, automatic and approved updates, edited scripts, disable and remove. Real scripts installed from GitHub through the install page: Return YouTube Dislike (shows the dislike count on YouTube), and Mottie's GitHub Code Show Whitespace, GitHub Toggle Expanders and GitHub Image Preview (their `@require` files from greasyfork.org and greasemonkey.github.io download fine).
