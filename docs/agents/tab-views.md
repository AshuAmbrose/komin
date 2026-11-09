# 10.1 Tab views

Section 10.1 of the agent docs. [AGENTS.md](../../AGENTS.md) is the core (rules, commands, pitfalls, open work), loaded into every session, and lists every file in this folder; read its sections 0–2 first. "Section N" and "pitfall N" below mean AGENTS.md's numbering, and section 10.x is a file here.

- **Lifecycle** (UI → main):
  - `webviews.add(tabId)` sends `createView` with the list of page events to forward.
  - `webviews.setSelected` sends `setView`.
  - `webviews.update(tabId, url)` runs `urlParser.parse`, then sends `loadURLInView`.
  - `webviews.destroy` sends `destroyView`.
- **Page events** reach the UI as `view-event` and are dispatched to `webviews.bindEvent(name, fn)` handlers. Main drops subframe `did-start-navigation`/`will-redirect` and subframe `did-navigate-in-page` events.
- **`callViewMethod`** calls a method or sets a property on the view's `webContents`, then replies `async-call-result`. History methods (`canGoBack`, `goBack`, `goToIndex`, ...) are called on `webContents.navigationHistory`, since the `webContents` versions are deprecated. Callers use `webviews.callAsync(id, method, argsOrCallback, callback)`.
- **Popups** reuse the default web preferences. `filterPopups(url)` in `filtering.js` blocks popups that the ad-block engine matches.
