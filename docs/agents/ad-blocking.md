# 10.2 Ad blocking (`main/filtering.js`)

Section 10.2 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

**Settings.** `filtering = {blockingLevel, contentTypes, exceptionDomains}`:

- `blockingLevel` 0 is off.
- At 1 (the default), the Ghostery engine checks all requests, and Min's own parser checks third-party requests only.
- At 2, Min's parser checks all requests.
- `exceptionDomains` are sites where blocking is off (the shield button, `contentBlockingToggle.js`).
- `contentTypes` can block all `script` or `image` requests.

**Engine lifecycle:**

1. `initFilterList` runs when blocking is turned on (including at startup). It deletes the legacy `adblocker-engine.bin`.
2. `loadCachedAdblockerEngine` reads `<userData>/adblocker-engine-v2.bin`, about 17 ms. If that fails, `downloadAdblockerEngine` runs `ElectronBlocker.fromLists(fetchAdblockerList, ADBLOCKER_LISTS)` and writes the cache. `fetchAdblockerList` uses Electron's `net.fetch`, never Node's `fetch` (pitfall 20), and waits for `app.whenReady()` first: at a new profile's first start the download begins while main is still loading (pitfall 44). Measured (2026-11-09, `adblock-first-start`): the full engine (7.1 MB file) is downloaded, built and saved within 2 s of a first start.
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

**Compared with uBlock Origin** (2026-11-07, dev build, `test/e2e/measure-ad-blockers.js`: each setup in a brand-new profile, two interleaved runs, five ad-heavy sites (Times of India, Hindustan Times, NDTV, CNN, Allrecipes) and three YouTube videos):

| | No blocking | Min's blocker | uBO Lite | Full uBO (MV2) |
|---|---|---|---|---|
| Ad/tracker requests that loaded | 1,223 / 958 | 0 / 1 | 1 / 0 | 0 / 0 |
| Visible ad slots | 23 / 16 | 9 / 9 | 8 / 8 | 0 / 0 |
| Requests made | about 3,060 | about 935 | about 835 | about 700 |
| Data downloaded | 34–35 MB | 28–29 MB | 27–28 MB | 25–26 MB |
| CPU while loading the sites | 270–389 s | 65 s | 55–59 s | 66–69 s |
| Idle CPU with them open, per minute | 15–17 s | 5.5 s | 2.4–2.5 s | 6.3–7.0 s |
| Memory with them open | 4.3–5.7 GB | 1.35–1.37 GB | 1.27–1.36 GB | 1.35–1.41 GB |
| Restart in a set-up profile: CPU, memory | – | 0.8 s, 275 MB | 4.1 s, 308 MB | 53 s, 3.0 GB |

- Min's blocker and uBO Lite block about equally. uBO Lite is a little lighter on pages (its rules are matched inside Chromium and its worker sleeps), but Min's blocker starts faster.
- Full uBlock Origin hides the most (every cosmetic filter), but it isn't usable in Min: IndexedDB failed in its background page (pitfall 41), unpacked installs don't update, and since 2026-11-09 Min refuses Manifest V2 extensions altogether (section 10.9), so `measure-ad-blockers.js` now compares the other three setups only.
- YouTube was inconclusive: the screen was locked, so players didn't draw and whether an ad played couldn't be seen. Ad markers appeared in 6 of 6 videos with Min's blocker, 5 of 6 with uBO Lite and 0 of 6 with full uBO, but only 1 of 6 without blocking (YouTube rations ads per visitor). Redo it with the screen unlocked.
- adblock-tester.com scored 65 for every setup, no blocking included, so it measures nothing useful.
- Decision: Min's blocker stays the default; uBO Lite is a good alternative (section 10.9, network filtering).

**YouTube** has no exemptions. Network rules, CSP, CSS and scriptlets all apply. The old hand-rolled mute/10× ad skipper was removed on purpose.

**Known engine quirk.** Ghostery redirects to `data:` URLs (for example `redirect=noop.txt` on doubleclick and `ad_status.js`), which Chromium rejects with `ERR_UNSAFE_REDIRECT`. Those requests just fail.

**Measured effect** (one tab, dev build):

| Page | Memory | Processes | Load CPU | Idle CPU (25 s) |
|---|---|---|---|---|
| Times of India, blocking off | 1,609 MB | 39 | 95.8 s | 26.3 s |
| Times of India, blocking on | 624 MB | 8 | 30.6 s | 10.8 s |
| YouTube, blocking off | 671 MB | 10 | 18.3 s | 0.1 s |
| YouTube, blocking on | 705 MB | 9 | 19.7 s | 0.7 s |
