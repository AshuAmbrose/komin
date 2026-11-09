# 10.7 History, session, other services

Section 10.7 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

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
