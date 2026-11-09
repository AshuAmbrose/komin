# 10.3 Permissions (`main/permissionManager.js` + `js/navbar/permissionRequests.js`)

Section 10.3 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

**Handlers**, registered on the default session and on every new session:

- `setPermissionRequestHandler(pagePermissionRequestHandler)`: the site is asking.
  - Supported permissions: `media`, `notifications`, `pointerLock`.
  - `fullscreen`, `clipboard-sanitized-write` and `display-capture` always get `callback(true)`. Display capture still goes through the picker.
  - Anything else is denied.
- `setPermissionCheckHandler(pagePermissionCheckHandler)`: a synchronous check with no prompt. Cross-origin iframes (`requestingOrigin !== embeddingOrigin`) are denied.
- `setDisplayMediaRequestHandler(displayMediaRequestHandler)`: `desktopCapturer.getSources` → the picker in the UI → `{video: source, audio: 'loopback'}` on Windows when audio was requested.

**Flow:**

1. The request is checked against `isPermissionBlockedForOrigin`, then `isPermissionGrantedForOrigin(origin, permission, details, ses)`.
2. Otherwise it's pushed to `pendingPermissions` and `sendPermissionsToRenderers()` sends `updatePermissions`.
3. The UI shows the bar and replies `permissionGranted` / `permissionDenied` with `{permissionId, persist | block, sourceId}`.
4. Main calls the stored callback.

**Storage:**

- Persistent answers: setting `sitePermissions = { "<hostname>": { "notifications": "allow"|"block", "pointerLock": ..., "media:audio": ..., "media:video": ... } }`.
  - Keyed by **hostname**, not full origin (inherited from upstream).
  - Only persistent sessions write it.
- Session grants (`sessionPermissions`) store the `session` they were granted in and only match that session, so private tabs are isolated.

**Live capture tracking:**

- `js/preload/mediaTracker.js` wraps `getUserMedia`/`getDisplayMedia` in the page's main world and reports `media-access-status {kind: audio|video|screen, active}`.
- That updates `activeMediaByContents` (a Map keyed by `webContents`) and the `grantedPermissions` entries the tab icons use.
- The signal is best-effort: a page can read the token and spoof it.
- **`activeMediaByContents.has(wc)`** is the right way to ask "is this tab capturing?". Electron has no `isCapturing()`; `isBeingCaptured()` means something else.
