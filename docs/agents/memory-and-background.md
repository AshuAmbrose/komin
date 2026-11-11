# 10.4 Memory and background behavior (fork)

Section 10.4 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

**Whole-app trimming** (`main/main.js`). `trimMemoryNow` runs `ext/windows/trimMemory.exe <procName> --exclude <pids>` (`EmptyWorkingSet`).

- When (a minimized window counts as not in use even if Windows leaves focus on it, since 2026-11-09): on minimize, 4 s after blur, and every 90 s while unfocused (`startBackgroundTrimming`).
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
- **The setting `trimBackgroundTabs`** (Settings → Performance, on unless set to false): off, every tab counts as protected while any Min window is focused and not minimized (`BaseWindow.getFocusedWindow()`, popups and sign-in windows included; Windows can leave focus on a minimized window when nothing else takes it, and until 2026-11-09 that kept tabs untrimmed: `performance-settings` measured the minimized window focused 100% of 70 s and the tabs at 108, 84, 102 MB, then 1, 20, 1 MB with the fix; measured again 2026-11-10 below), so background tabs are trimmed only while Min isn't in use. Whole-app trimming and hibernation don't depend on it. The Settings page shows it on Windows only (`navigator.platform`), the only platform that trims. Measured (dev build, 2026-11-07, three test tabs of 100–200 MB, two runs): on and focused, they dropped to 2–19 MB within 100 s; off and focused, they kept their memory; off and minimized, 0–20 MB within 70 s. Going back to a trimmed tab with plenty of free RAM: redrawn in 15–25 ms, its 80 MB read back in about 20 ms. With RAM short, Windows may have reused the memory and it comes back from disk (not measured).
- **Normal priority comes back** (`trimMemory.exe --no-trim --memory-priority normal <pids>`):
  - straight away when the tab is selected (`setView`);
  - when it starts playing media (`media-started-playing` in `main.js`);
  - when it starts capturing (`updateActiveMediaPermissions` in `permissionManager.js`);
  - otherwise at the next 60 s pass, for any lowered process that is protected again. Pids of exited processes are dropped then too.
- **What memory priority does:** pages a process loads after the change get that priority. Windows trims low-priority pages first and reuses them first from its standby cache. A trimmed background tab's pages therefore come back at low priority and are the first RAM Windows gives to another program. It never reduces Min's reserved memory, and does nothing while RAM is plentiful.
- **Chromium's own settings:** it already sets background tabs' CPU priority to Idle, but leaves every process at normal memory priority (5) (checked 2026-10-29). Min can raise and lower renderer memory priority from outside: renderer processes accept `SetProcessInformation`.

- **What the minimized fix saves** (measured 2026-11-10, `measure-minimized-focus.js <new|old>`, three runs each, alternating; `old` counts a focused minimized window as in use again, with `test/e2e/old-behaviour.js`). Dev build, four big local pages (about 20,000 elements each, in four processes) and the test extension installed, `trimBackgroundTabs` off, Windows leaving focus on the minimized window (emulated, so every run sees it). After 80 s minimized:

  | Working set (what Task Manager shows) | Before minimizing | With the fix | Without (as on master) |
  |---|---|---|---|
  | All of Min | 1,422–1,424 MB | 726 MB [703–758] | 1,402 MB [1,356–1,425] |
  | The four tabs' processes | 786–787 MB | 199 MB [196–200] | 777 MB [745–784] |
  | The other renderers (extension, history service) | 188–190 MB | 87 MB [87–98] | 190 MB [187–190] |
  | The UI | 112–115 MB | 110 MB | 113 MB |

  The tabs' 199 MB is mostly the tab that was shown, never trimmed. Private memory (what Min has reserved) was the same either way, 806 against 816 MB: trimming moves pages out of RAM, it doesn't free them ("Trimmed isn't the same as freed" in the guide). Processor time while minimized: 0.59 s [0.43–0.6] with the fix, 0.30 s without (0.7% against 0.4% of one core over 80 s): the trim's own work, once. The whole-app trim, which the fix also lets run, works only in the packaged app, so this measured the tab and extension trimming only (section 15).

**Hibernation** (`checkSmartHibernation`, every 5 min). It sends `hibernateTab`; the UI then destroys the view, and the tab reloads when selected.

- A tab is immune (`isTabImmuneFromHibernation`) if:
  - it's selected in any window;
  - it was used in the last 15 min (`HIBERNATION_IDLE_TIME`, lowered from 60 min after measuring that 10 background tabs hold about 1.45 GB that hibernation frees; rechecked 2026-11-09 with `measure-ten-tabs.js`, trimming off, screen unlocked: 10 real sites alive 2,097 MB private and 2,966 MB in RAM in 21 processes, trimmed 1,280 MB in RAM (private unchanged), hibernated 584 MB private and 975 MB in RAM in 8 processes, so about 1.5 GB freed);
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

**Covered windows idle.** Upstream's `disable-backgrounding-occluded-windows` switch was removed. A fully covered window's pages are treated as hidden (so is every page while the screen is locked or the display has turned off: `document.visibilityState` was `hidden` with Min's window on top, 2026-11-10, AGENTS.md pitfall 54): 0 fps and 0% CPU/GPU, versus about 69 fps and about 40% of a core before. The user confirmed there's no focus flicker on Electron 43, and again on 45 (their everyday 1.35.9, 2026-11-09). Measured on Electron 45.2.2 with the screen unlocked (2026-11-09, suite `covered-window`: a page drawing on every frame, covered by a plain window from `test/e2e/cover-screen.ps1`): visible 60 fps, the page's renderer 9% of a core, GPU 19%; half covered the same (60 fps, still `visible`); fully covered 0 fps, `hidden`, page and GPU 0%, all of Min 0.8%; uncovered, drawing again after 52 ms at 60 fps. Audio, calls and notifications continue.

**Other:**

- `backgroundThrottling: true` in the tab web preferences.
- `js-flags=--optimize-for-size`, the setting `optimizeJavaScriptForSize` (Settings → Performance, off unless true; it was always on before these measurements). Measured (dev build, 2026-11-07; four real sites open, two runs each with and without it): Speedometer 3.1 scored 14.1 and 14.3 with it, 19.0 and 18.7 without, so JavaScript runs about a quarter slower (rechecked 2026-11-09 with the screen unlocked, one round each: 12.1 with it, 18.3 without; the four sites' private memory 391 vs 355 MB); a local test (creating objects, JSON, sorting, text with regular expressions, DOM) took 1,393–1,435 ms vs 940–943 ms; the four sites' private memory was 352–363 MB vs 350–360 MB and the UI's 84–86 vs 86–87 MB, so no measurable saving; hence off by default. Electron applies a `js-flags` switch added at run time to renderers only, not to the main process.
- Preview capture runs only when the UI is focused, plus once on blur.

**Not done yet** (candidates):

- skipping the blur screenshot;
- a persistent trimming helper instead of spawning `trimMemory.exe` every minute;
- the history service's window without Node.js (about 10 MB, same database; see "Measured and not worth doing" above).

Efficiency mode (EcoQoS) and the hibernation probe's wake-ups were candidates too; measured, neither pays (above).

**Extensions' processes** (`getExtensionProcesses` in `extensions.js`, used by `getTabProcessGroups`): background workers report their process id when they start (`min-extension-lifecycle`), and extension pages are found among all web contents. While no Min window is focused, they're trimmed and get low memory priority at the 60 s pass, like inactive tabs; while Min is in use they're left alone (their workers would page back in on every page load). A process showing a popup or a side panel, or playing sound, is never touched. Measured with Dark Reader and Bitwarden: focused for two passes, 119 and 161–181 MB kept; minimized, 119 → 3 MB and 187 → about 10 MB at the next pass; both kept working.
