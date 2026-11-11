# 10.6 Settings

Section 10.6 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

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
  - **Extensions:** `extensionsFilterNetwork` (an extension that filters requests blocks ads in normal tabs instead of Min), `extensionsFilteringNetworkNow` (derived by main: that is happening now; for the UI), `extensionsPasswordSavingOff` (derived by main: an extension turned off the browser's password saving, so Min doesn't offer to save; section 10.9)
  - **Features:** `readerData`, `userscriptsEnabled`, `userscriptsInPrivateTabs`, `lastBookmarksBackup`, `proxy` (`phishingWhitelist` belonged to the removed phishing page; old profiles may still have it)
  - **PDF viewer:** `pdfDayTheme`, `pdfNightTheme`, `PDFInvertColors`
  - **Performance** (Settings → Performance): `trimBackgroundTabs` (on unless false), `optimizeJavaScriptForSize` (off unless true; startup only, so the Settings page shows the restart notice), `hideAdSpacesWhileLoading` (off unless true; read by main as each page starts, `cosmetic-filters-start`, so it applies to the next page; section 10.2)
  - **Updates and statistics:** `updateNotificationsEnabled`, `collectUsageStats`, `usageData`, `clientID`, `installTime`
- **Adding a setting** (as `trimBackgroundTabs` was, commit `186e829a`):
  1. Pick a key and its default. A setting nobody has changed reads as `undefined`, so the default lives in each check: `value !== false` for on by default, `value === true` for off by default. Add the key to the list above.
  2. The Settings page: a `<div class="setting-section">` in `pages/settings/index.html` with a checkbox (`id="checkbox-…"`), its `<label for=… data-string="…">` and an explanation (`<div class="settings-info-subheading setting-secondary-label" data-string="…">`). In `pages/settings/settings.js`, `settings.get(key, function (value) {…})` sets the box (the page's `settings` takes a callback) and a `change` listener calls `settings.set(key, this.checked)`.
  3. Strings go in `localization/languages/en-US.json`, keeping its Windows line endings (pitfall 11); after `npm run build`, check they're in `dist/localization.build.js`.
  4. Main: `settings.get(key)` where it's used (it's always current), or `settings.listen(key, cb)` to act on changes (it calls back at once, pitfall 30). A setting read only at startup needs the page to call `showRestartRequiredBanner()` on change, as `optimizeJavaScriptForSize` does.
  5. The UI (`js/`): `const settings = require('util/settings/settings.js')`; it isn't a global there (pitfall 40).
  6. Tests change it from the UI window with `ipc.send('settingChanged', key, value)` (pitfall 40). Add checks to the suite of the feature it controls (`performance-settings` covers the Performance ones).
- **Autoplay:** `enableAutoplay` is off by default, so a tab loaded without a click (restored, reloaded, opened from a link) won't autoplay.
