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

- `js/preload/default.js` gets them in the answer to the frame's one request to main as it starts (`ipc.sendSync('page-start', url)`, handled in `main/userscripts.js`; the same answer brings the frame's userscripts, so a page start makes one blocking request instead of two since 2026-11-12, when this part was its own `cosmetic-filters-start`). Main answers the ad blocker's part (`getCosmeticsForPageStart` in `main/filtering.js`) only to a tab's top frame, on http(s). The preload runs the scriptlets with `webFrame.executeJavaScript` straight away: before the page's own scripts (since 2026-11-09; before that it was `ipc.send('inject-cosmetic-filters')` and main's `executeJavaScript`, a round trip later, see "Late scriptlets" below).
- `injectCosmeticFiltersForSender(engine, sender, url, scriptsToCaller)` runs `engine.getCosmeticsFilters(...)` with base, hostname and injection rules: about 1 ms for YouTube (35 scriptlets, 313 KB), 0.02–0.2 ms elsewhere (measured 2026-11-09 in Node on the cached engine). It returns `{active, scriptlets}`; the start handler answers the preload `{scriptlets, dom}` (`dom`: report the page's classes, ids and links, below).
- **The domain** is the registrable one, `getDomain(hostname)` from `tldts-experimental` (`getCosmeticDomain`; a dependency of Min's own since 2026-11-10, and of Ghostery's), as Ghostery's Electron code does. Until 2026-11-10 it was `removeWWW(hostname)`, so on any host but `www.` the site's rules never applied (pitfall 52; item 1 of "The visible ad slots, explained").
- **Generic rules from the page** (since 2026-11-10). Ghostery keeps most generic rules (EasyList's `##.ad-slot`, link rules like `##a[href^="https://ad.doubleclick.net/"]`) in lookups by class, id and link (`getRulesFromDOM`), and returns them only for the ones a page has. When the start answer says `dom`, the preload (`reportCosmeticFeatures` in `js/preload/default.js`, top frame only, in its isolated world, so a page's patched built-ins don't change what it sees) runs **Ghostery's own page watcher**, `DOMMonitor` from `@ghostery/adblocker-content` (the code Ghostery's Electron preload uses; its 3.5 KB standalone build, unchanged, is put at the start of `dist/preload.js` by `scripts/buildPreload.js`, as `ghosteryContent`). It collects the page's classes, ids and links (`queryAll`, Ghostery's `extractFeaturesFromDOM`), then a `MutationObserver` (added elements; `class`, `id`, `href` changes) collects new ones: sent 25 ms after the page stops changing, at least once a second while it keeps changing, at once past 512 changed elements, and only those not sent before. Min sends each batch with `ipc.send('cosmetic-filters-dom', url, {classes, ids, hrefs})`. Min uses the watcher in two ways Ghostery's preload doesn't:
  - **From the page's first bytes, if the setting says so** (the setting `hideAdSpacesWhileLoading` (Settings → Performance, "Hide empty ad spaces while pages are still loading"; off unless true, since 2026-11-11); the code since 2026-11-10, on for everyone until the setting). Off, a shown page is watched from `DOMContentLoaded`, as in Ghostery's preload and on master. Main reads the setting as each page starts and answers it with the rest (`whileLoading` in `page-start`'s `cosmetics`), so a change applies to the next page loaded. On, a shown page is watched while it's still arriving: the preload runs before the document has its root element, so a `MutationObserver` on the document waits for `<html>`, then the watcher scans what's there and watches; what the parser adds after that reaches it like any other change. A page loaded hidden (a tab opened in the background) gets one scan once it's parsed. Why and what it costs: "When the rules arrive" below.
  - **Nothing while the page is hidden** (a background tab, a covered or minimized window): the watcher is stopped (`stop`); when it's shown again one scan catches up (`queryAll`, which sends only what's new) and it watches again (`start`).

  The first version (2026-11-10) had a hand-written copy of this watcher; it was replaced by Ghostery's the same day (rule 8: reuse, don't rewrite).
  - **When the rules arrive** (measured 2026-11-10). A site's own rules come with the page's start, so their boxes are never drawn. Generic rules come with the watcher's reports.
    - **Before:** until 2026-11-10 the watcher's first scan ran at `DOMContentLoaded`, as in Ghostery's preload. uBO Lite's `js/scripting/css-generic.js` runs even later, at `document_idle`, and batches changes every 64 ms (checked in its code). So on big pages a box only generic rules hide was on screen while the rest of the page arrived; the maintainer noticed the boxes during a test run.
    - **Now:** with `hideAdSpacesWhileLoading` on, a shown page is watched from its root element on (above); off (the default since 2026-11-11), as before.
    - **Measured:** `measure-generic-cosmetics.js`, three runs each way, alternating `on` with `late` (the old start). The figure is how long the page was drawn (first contentful paint) before its first report, in ms, old start → new:
      - CNN 349, 295, 318 → 0
      - Hindustan Times 213, 325, 204 → 0
      - Times of India 222, 134, 1,312 → 0
      - NDTV 870, 739, 912 → 0
      - Allrecipes 0, 0, 28 → 0
      - YouTube's home page 1,589 and 507 → 10, one run each (the other runs' first YouTube report to reach main came from the page YouTube replaced, so the script now records the time inside the page)
      - Wikipedia 0 → 0

      A first report doesn't cover every box: parts that arrive later get theirs in the watcher's next batch (25 ms after the parser pauses, at most 1 s, at once past 512 elements). `adblock-cosmetic` checks this on a page that arrives in two parts 1.5 s apart: the box is hidden at 75 ms, before the first paint. With the old start it was shown for 83 frames (1.5 s), and that check failed.
    - **Cost,** in the same runs, new start against old:
      - the watcher's own time in the pages for the seven page loads: 357, 339 and 347 ms against 220, 214 and 219 (about 20 ms more per page, spread over 115–210 calls);
      - reports: 78 against 51–57;
      - main's time answering them: 22–26 ms against 20–22;
      - all of Min while loading the seven sites: 73.5, 72.8 and 75.2 s against 72.4, 72.4 and 72.1. That is about 1.5% more: smaller than the spread between runs, but higher in all three. The watcher and main account for about 0.15 s of it; the rest wasn't traced (perhaps the pages restyling for CSS inserted while they load).

      - as shares of the processor (16 logical cores here), from three more pairs:
        - loading the seven sites took 65–81% of one core either way, 4.1–5.0% of the whole processor;
        - a minute shown: 10–12% of one core either way;
        - a minute minimized: 3–4.5% of one core either way.
      - private memory of all of Min after a minute minimized: 1,614, 1,628 and 1,636 MB against 1,559, 1,618 and 1,602. That is higher in all three pairs (+10 to +55 MB). Right after loading, the sites' own changes swamp it (±100 MB).
      - **on pages that are the same every run** (`measure-watcher-memory.js`: seven generated pages of about 10,000 elements each, arriving in ten parts; four pairs, with runs within 2% of each other):
        - loading took 5.31–5.43 s of processor time against 4.70–4.75, which is +13%. As shares: 20.5–20.9% of one core against 18.2–18.3%, or 1.28–1.31% of the whole processor against 1.13–1.14%. Of the extra, main took 0.07 s and the rest, mostly the pages' renderers, 0.55 s: about 80 ms a page.
        - memory, all of Min: +45 MB after loading, +28 MB after a minute shown, +25 MB after a minute minimized. The renderers had +37 MB, about 5 MB a tab. The GPU process had 12 MB less (perhaps because the ad boxes were never drawn).
        - the pages' JavaScript heap was the same (+0.7 MB used for the seven), so the extra memory is in the renderers' own (Blink) memory, not in the watcher's objects. Where exactly wasn't traced.
        - processor time while idle or minimized: within 0.2 s a minute either way. A minute shown was 1.49 against 1.51 s in these four pairs and 1.66 against 1.45 s in four more ("What these changes cost" below); nothing is sent while idle, so if the difference is real it's the renderers' own (not traced).

      While idle or minimized nothing is sent either way. Because of the extra memory it's a setting, off by default (2026-11-11; section 15).
    - **Speed** (looked at 2026-11-11 in the same runs; nothing new run). The early start can't make a page arrive or run sooner; it only adds work while the page loads (above). Time to first paint on the seven real sites, six runs each way: the medians were lower with the early start on every site (CNN 930 against 1,016 ms, Wikipedia 852 against 1,506), but the ranges overlap widely (Hindustan Times 288–2,068 against 324–1,336). The early start also always ran first in each pair, and Wikipedia, which has no ad boxes, moved the most. So that's run-to-run noise, not a speed-up.
      What it does change is visual: a box that only generic rules hide no longer appears and then collapses, which usually makes the content below it jump up. That jump wasn't measured (as layout shift).
      Speedometer wasn't run. Its tests run after the page has loaded, when the watcher runs with either start, and inside an iframe, which the watcher doesn't watch (top frame only), so no change is expected. `measure-javascript-flag.js` runs Speedometer 3.1 if that needs checking.
    - **The small test page:** `adblock-cosmetic`'s info check, frame by frame. CNN's own rule: 0 frames. Generic rules: before the first paint. A box added 2 s later: hidden 33 ms after it appeared (3 animation frames; the hand-written watcher waited up to 1 s).
    - **First measurement, superseded:** the first one-run measurement (old start, first report taken from main) gave CNN 227, Hindustan Times 442, Times of India 229, NDTV 470, Allrecipes 20, YouTube 1,808 and Wikipedia 0.

  Main answers with `getCosmeticsFilters({getRulesFromDOM: true, getRulesFromHostname: false, getBaseRules: false})` for them (at most 5,000 of each, strings under 1,000 characters, from the tab's main frame only) and inserts the CSS like the rest. Not while an extension filters, on a site with blocking off, or with blocking off. The engine gives no generic rules to a bare IP address. `test/e2e/old-behaviour.js`'s `noGenericCosmetics` turns this off for a run (for `measure-generic-cosmetics.js`; until 2026-11-12 the app's own code read an environment variable for it). Suite `adblock-cosmetic` (13 checks).
- The handler sets `event.returnValue` once, in `finally` (pitfall 49). If the engine is still loading (the first moments after startup), the page gets nothing then, and everything comes once the engine is ready, a round trip later, as before.
- CSS goes in from main with `insertCSS(styles, {cssOrigin: 'user'})`. Scriptlets are combined into one script:

  ```js
  '(() => {\nconst minScriptletGlobals = {};\n' + scripts.map(s =>
    '((scriptletGlobals) => {\ntry {\n' + s + '\n} catch (e) {}\n})(minScriptletGlobals);').join('\n') + '\n})();'
  ```

- **Why the wrapper looks like this.** Running each scriptlet in its own scope stops the helper copies overwriting each other and fixes the `toString` recursion. Sharing `scriptletGlobals` lets Ghostery's ≥2.20 `SHARE_SAFE_SELF` prelude reuse the first native snapshot. Measured on YouTube's player request: 7 calls to `JSON.stringify` with the wrapper, versus 64 without sharing. Ghostery's own injector leaves `toString` broken, even in 2.20.1.
- **Late scriptlets (fixed 2026-11-09).** Until then scriptlets arrived after the page's own scripts had started (an IPC round trip). Several YouTube rules only work when they're first: `set-constant ytInitialPlayerResponse.adPlacements undefined` (and `.playerAds`, `.adSlots`) traps the property before YouTube's inline `var ytInitialPlayerResponse = {...}` assigns it; run later, it can't touch the existing global, so the player got its ad data on every newly loaded YouTube page. Measured with `measure-youtube-ads.js` (screen unlocked, a new profile each run, three videos opened in new tabs, then one in-app click from each):

  | | New tabs with an ad | Ad data reached the player | Scriptlets there first (`trapped`) | In-app clicks with an ad |
  |---|---|---|---|---|
  | Before (late), 1 run, plus the comparison's run (2 of 3) | 1 of 3 | 3 of 3 | 0 of 3 | 0 of 3 |
  | At page start, 2 runs | 0 of 3, 0 of 3 | 0 of 3, 0 of 3 | 3 of 3, 3 of 3 | 0 of 3, 0 of 3 |

  The first video of a run still takes about 15 s to start (14.6 and 14.9 s), without an ad: YouTube's own wait for a new visitor whose ad didn't load. uBO Lite showed one such start too (13 s), and without blocking that first video is a 14 s ad. In-app clicks were ad-free before as well: YouTube changes video without loading a page, and the scriptlets were in place by then.
  - Not tried: `contextBridge.executeInMainWorld` instead of `webFrame.executeJavaScript` (both run before the page's scripts; the second takes a code string, which the scriptlets are).

**What these changes cost** (measured 2026-11-10 on the branch `chore/unlocked-remeasure`). Each change was switched back to master's behaviour for some runs (`test/e2e/old-behaviour.js`), alternating old and new, with the screen unlocked. The display had turned off for many runs, in both modes; the scripts that pass `--disable-features=CalculateNativeWinOcclusion` keep their pages visible anyway (pitfall 54), and `measure-youtube-ads.js` doesn't. All of Min's processor time; "% of one core" is seconds ÷ wall time, and the processor has 16 logical cores. Memory is all of Min's private memory. Medians, with the range in brackets.

- **Generic rules from the page** (`measure-watcher-memory.js <off|late|on>`, the seven generated pages, four runs each):

  | | Off (as on master) | On, watcher from `DOMContentLoaded` (the default) | On, watcher from the first bytes (`hideAdSpacesWhileLoading`) |
  |---|---|---|---|
  | Loading the seven pages | 4.42 s: 17.1% of one core, 1.07% of the processor | 4.79 s: 18.5%, 1.15% | 5.38 s: 20.7%, 1.30% |
  | of which main | 1.29 s | 1.36 s | 1.42 s |
  | A minute shown | 1.36 s (2.3%) | 1.45 s (2.5%) | 1.66 s (2.8%) |
  | A minute minimized | 0.44 s (0.75%) | 0.45 s (0.75%) | 0.51 s (0.85%) |
  | Memory after loading | 947 MB | 977 MB | 1,012 MB |
  | Memory after a minute minimized | 906 MB | 935 MB | 953 MB |
  | of which the pages' renderers | 610 MB | 630 MB | 658 MB |
  | The pages' JavaScript heap, minimized | 7.6 MB | 8.8 MB | 9.9 MB |

  So on pages of 10,000 elements the generic rules cost about 0.4 s of processor time per seven loads and 30 MB (about 4 MB a tab) with the old start, and 1 s and 50 MB (about 7 MB a tab) with the new one. Runs of the same setting were within 4% of each other, but for one `on` run at 6.12 s. Results: `measure-watcher-memory-*-g1` … `-g4` (made before the setting existed: `late` patched `dist/preload.js`; since 2026-11-11 `on` turns the setting on and `late` is the default). Rechecked through the setting on 2026-11-11, one run each: loading 7.77 s with it on, 7.34 s off; memory after a minute minimized 967 against 928 MB (renderers 671 against 620). The setting reproduces the difference; both runs took more processor time than the day before (the computer busier), so they are a check, not a new measurement (`-on-set1`, `-late-set1`). `adblock-cosmetic` the same day (14 of 14): the slow page's box hidden at 1,532 ms, after the page was parsed (1,517 ms; 87 frames shown) by default, and at 48 ms (2 frames) with the setting on.
- **The same, on seven real sites** (`measure-generic-cosmetics.js <on|off>`, three runs each, the watcher from the first bytes): loading 70.1 s [63.5–70.4] with the rules, 69.2 s [67.4–69.5] without (65% of one core either way, 4.1% of the processor); a minute shown 5.7 against 7.1 s; a minute minimized 2.2 against 0.9 s; memory after a minute minimized 1,575 MB [1,525–1,661] against 1,629 [1,607–1,650]. All inside the spread between runs of the same setting: on real sites, whose own work is far bigger, the rules' cost doesn't show. Results: `-on-g1` … `-off-g3`.
- **Scriptlets at the page's start** (2026-11-09; `MIN_TEST_OLD=scriptletsAfterStart` for the old round trip, three runs each). Each page now waits for main's answer before its scripts run: 1–9 ms on YouTube (`mainMs`, the time main took).
  - On the generated pages (no site rules, so only that question at each page's start): loading 6.64 s [5.73–8.39] against 7.19 [5.42–7.28], main 1.77 against 1.91 s; memory after a minute minimized 916 against 921 MB. No difference beyond the spread.
  - On YouTube (`measure-youtube-ads.js`): the old way showed an ad on 5 of 9 videos opened in new tabs, the new one on 0 of 9. The ads make the runs different lengths, so the totals differ for that reason: processor time over the run 79, 88 and 108 s new (main 6.1–7.5 s), 83, 111 and 128 s old (main 6.7–8.8 s; the old runs played 2, 50 and 61 s of ads). As a share it's higher new, 142–159% of one core against 104–127%, because the same videos are done in 56–68 s instead of 80–110 s. Memory while each video played: 1,019–1,461 MB new, 938–1,477 MB old. In the one pair where the old way showed only 2 s of ads, 78.9 s against 82.9 s. Results: `measure-youtube-ads-ynew1` … `-yold3`.
- **The registrable domain** (2026-11-10; `MIN_TEST_OLD=domainWithoutWWW`, the seven real sites, three runs each; of them it changes CNN's `edition.` and Times of India's `timesofindia.` host): loading 81.6 s [72.6–91.7] against 82.2 [77.4–99.6]; a minute shown 6.5 against 6.1 s; minimized 2.1 against 1.7 s; memory after a minute minimized 1,674 against 1,690 MB. No difference beyond the spread. Results: `measure-generic-cosmetics-on-dnew1` … `-dold3`.

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
- YouTube was inconclusive on 2026-11-07: the screen was locked, so players didn't draw and whether an ad played couldn't be seen.
- adblock-tester.com scored 65 for every setup that day, no blocking included: also the locked screen, it seems (below, unlocked: 27 without blocking).

**Redone with the screen unlocked** (2026-11-09, one round of the three setups, before the scriptlet fix above; `results/ad-blockers/summary.md`, the 2026-11-07 runs kept in `results/ad-blockers-2026-11-07/`):

| | No blocking | Min's blocker | uBO Lite |
|---|---|---|---|
| Ad/tracker requests that loaded (5 sites) | 1,313 | 0 | 0 |
| Requests blocked / swapped for a stand-in | 0 / 0 | 159 / 0 | 108 / 58 |
| Stand-ins Chromium refused, so blocked instead | 0 | 34 | 0 |
| Visible ad slots (5 sites) | 22 | 9 (CNN 8, Allrecipes 1) | 0 |
| YouTube videos with an ad (of 3, new tabs) | 1 | 2 | 0 |
| adblock-tester.com (of 100) | 27 | 65 | 65 |
| Data downloaded (5 sites) | 45.5 MB | 31.4 MB | 29.0 MB |
| CPU loading the sites / idle per minute with them open | 539 s / 15.6 s | 75.5 s / 12.8 s | 65.3 s / 5.3 s |
| Memory with the sites open | 5,656 MB | 1,344 MB | 1,367 MB |
| Start-up CPU (first 45 s) / time to window | 2.6 s / 7.4 s | 0.9 s / 1.0 s | 2.5 s / 0.6 s |

- Min's YouTube result was the late scriptlets (above; 0 of 3 since the fix). The 9 visible ad slots: below.
- The "blocker extension" memory rows read 0 for uBO Lite this time: the script's process grouping didn't find its process (the totals are right). Not looked into.
- Decision: Min's blocker stays the default; uBO Lite is a good alternative (section 10.9, network filtering).

**The visible ad slots, explained** (2026-11-10, `test/e2e/measure-ad-slots.js`, Min's blocker with the screen unlocked, then with uBO Lite installed for comparison; screenshots in `results/measure-ad-slots-*.png`). None of the 9 slots held an ad: the network rules had blocked them all. They are empty space the page keeps for ads, and three different gaps leave it:

1. **Min passed the wrong domain to the engine (a bug, fixed 2026-11-10: the right domain, above).** `injectCosmeticFiltersForSender` passes `domain: removeWWW(hostname)`; the engine expects the registrable domain (`tldts`'s `getDomain`, which Ghostery's own Electron code uses). On any host but `www.` the rules written for the site never apply: `edition.cnn.com` got none of CNN's hiding rules (EasyList's `cnn.com##.ad-slot-header__wrapper`, `##.zone__ads` and the rest) and 0 of its 8 scriptlets (`FAVE.settings.ads.ssai...`, for the video player). With `cnn.com`, all 8 CNN slots go and 59 elements in all, including a 276 px empty band at the top. Others, scriptlets / hiding CSS with Min's domain → the right one: `open.spotify.com` 0 → 2 scriptlets; `music.youtube.com` 7 → 9 and 0 → 1.3 KB; `m.youtube.com` 9 → 11 and 1.5 → 2.7 KB; `timesofindia.indiatimes.com` 1.7 → 2.1 KB; `old.reddit.com` 0 → 0.5 KB; `www.` hosts are unaffected. Network blocking isn't affected (Ghostery's `Request` works out the domain itself). The fix: `getDomain(hostname)` from `tldts-experimental` (already installed, Ghostery's dependency), in `injectCosmeticFiltersForSender`.
2. **Min never asked for the generic rules that need the page's classes, ids and links** (`getRulesFromDOM: false`; built 2026-11-10, "Generic rules from the page" above). Ghostery keeps generic EasyList rules such as `##.ad-slot` or `##.mm-ads-leaderboard-header` in lookups by class, id and link; its own content script collects those from the page (`extractFeaturesFromDOM`, then a `MutationObserver`) and asks for them on every DOM change. Min skips this. On Hindustan Times the slot counter found nothing, but there were two empty ad spaces (a blank band about 390 px tall above the header, and a grey "Advertisement" box); the generic rules removed both (17 elements), as uBO Lite does. On CNN they removed 7 of the 8 slots (not the band: that's a CNN-specific rule, item 1). Cost, measured in Node on the cached engine: the lookup takes 1–12 ms per page (CNN's 783 classes the slowest) and returns 0.5–1.2 KB of CSS; the page has to collect its classes, ids and links (hundreds to about a thousand), and dynamic pages change them all the time. Built 2026-11-10 with a throttled observer that stops while the page is hidden; its measured cost (`measure-generic-cosmetics.js`, 2026-11-10, screen unlocked, on and off alternating, two runs each, all of Min's processor time): loading and scrolling seven sites 77.9 and 71.8 s with them, 72.2 and 70.4 s without (about 5% more on average, inside the 6 s spread between two runs of the same setting); main's share 8.1 and 7.6 s vs 8.1 and 7.7 s, its time answering the pages 16 ms in all for 26–27 reports (about 3,800 classes, 3,300 ids and 3,000 links); idle one minute shown 5.5 and 5.9 vs 5.6 and 6.4 s; one minute minimized 1.6 and 2.3 vs 1.8 and 1.4 s, with no reports at all while idle or minimized. Remeasured the same day with Ghostery's `DOMMonitor` in place of the hand-written watcher (three runs each: on, off, on, off, then off, on; the display was off, so with Chromium's occlusion check off, pitfall 54): loading and scrolling 90.3, 71.6 and 73.8 s with them, 68.5, 69.7 and 68.6 s without (the middle values 73.8 vs 68.6, about 7% more; the hand-written one measured about 5%; the 90.3 s run, main 10.1 s instead of 7.9, is unexplained and not repeated); about twice as many reports (49, 53 and 52: it sends 25 ms after the page stops changing, not after a full second), the same classes, ids and links found (3,832–3,872, 3,324–3,332, 3,074–3,076), main's time answering them 30, 20 and 19 ms in all; idle shown 5.5, 6.5 and 6.2 vs 5.5, 6.9 and 5.3 s; minimized 1.2, 0.8 and 3.4 vs 2.7, 1.7 and 1.8 s; no reports while idle or minimized. Results: `test/e2e/results/measure-generic-cosmetics-*-dm1`, `-dm2`, `-dm3`. Effect, with both fixes in Min (`measure-ad-slots.js` again): CNN 0 slots (was 8), Hindustan Times' band and box gone as with uBO Lite (the box's reserved space stays blank, as with uBO Lite), Allrecipes still 1 (item 3); inserting the rules by hand on top hides nothing more on any of the five sites.
3. **Allrecipes: Ad-Shield "ad recovery".** Its 1 slot was a grey 90 px banner with "Advertisement" labels around a broken ad frame. The page loads Ad-Shield's scripts (`*.stg.html-load.com`, ten of them) and Blockthrough's (`btloader.com`, blocked). Ad-Shield rebuilt the ad with scrambled class names and ids (25 ids like `harzsgqwhvznvy7ngmsvgy7yixzn4yie`) and patched the page's `appendChild`, `matches` and class getters so the page's own code still sees `mm-ads-leaderboard-header`: no hiding rule can match the real names (EasyList's generic `##.mm-ads-leaderboard-header` is there and did nothing, even inserted on its own, while a made-up class applied). Read from the page's main world, the names look normal (the slot counter was fooled too; pitfall 53); read from an isolated world, they're scrambled. The lists don't block Ad-Shield's scripts (on purpose: blocking it breaks sites). With uBO Lite there was no banner and 0 scrambled ids: Ad-Shield never started its recovery. Most likely because uBO Lite serves stand-ins (a fake `gpt.js` among them), which Min's engine can't (the refused `data:` redirects above: 7 on Allrecipes, `gpt.js` → `googletagservices_gpt.js` among them), so the page sees its ad script blocked and calls in Ad-Shield. Not proven: serving the stand-in through DevTools interception didn't work (Min's `onBeforeRequest` fails the request first), so it would take serving stand-ins for real (section 15) to check.

Also checked and ruled out: the engine packs up to 1,024 selectors into one CSS rule, and Chromium drops a whole rule over one selector it doesn't support; no stylesheet on these five sites had one (`stylesheets` in the results). Min's CSS beats a page's own `!important` (user origin; checked on Allrecipes). The comparison's slot counter (`AD_SELECTOR` in `measure-ad-blockers-run.js`) only matches some class names (`ad-slot`, `ad-container`, `advertisement`...), so it missed Hindustan Times' empty spaces and can't see scrambled ones: a low count isn't proof of a clean page.

**YouTube** has no exemptions. Network rules, CSP, CSS and scriptlets all apply. The old hand-rolled mute/10× ad skipper was removed on purpose.

**Known engine quirk.** Ghostery redirects to `data:` URLs (for example `redirect=noop.txt` on doubleclick and `ad_status.js`), which Chromium rejects with `ERR_UNSAFE_REDIRECT` (pitfall 7). Those requests just fail, as if blocked: 34 on the five comparison sites (2026-11-09, `standInRefused`). Such `$redirect` rules exist so a site that waits for the script (a video player waiting for Google's IMA SDK, a page checking `ad_status.js` for an ad blocker, code calling `ga()` or `googletag.cmd.push`) gets a harmless stand-in and carries on; without it, that site can stall or show an anti-adblock message. From the 7 November comparison's results (`results/ad-blockers/*-1.json`, `redirectedAway`): uBO Lite swapped 78 requests on the five sites for its stand-ins (`chrome-extension://` web-accessible files, which Chromium allows), Min's blocker 0; since 2026-11-09 `measure-ad-blockers-run.js` counts Min's refused ones apart (`standInRefused`): 34 in that day's run. No broken site has been seen. A fix would serve the stand-ins from an address Chromium accepts (a privileged custom scheme, probably needing `bypassCSP`, or `min://app/`); not tried, and only worth building if a site breaks (section 15).

**Measured effect** (one tab, dev build):

| Page | Memory | Processes | Load CPU | Idle CPU (25 s) |
|---|---|---|---|---|
| Times of India, blocking off | 1,609 MB | 39 | 95.8 s | 26.3 s |
| Times of India, blocking on | 624 MB | 8 | 30.6 s | 10.8 s |
| YouTube, blocking off | 671 MB | 10 | 18.3 s | 0.1 s |
| YouTube, blocking on | 705 MB | 9 | 19.7 s | 0.7 s |
