/* What extensions see of Min's tabs (AGENTS.md section 10.9). electron-chrome-extensions only knows tabs that have a page
   loaded (a webContents), in the order they were created. Min also has tabs without one: hibernated, and restored but not
   shown yet. While extensions run, each window's UI sends its tabs in order (extensions-tab-list, js/extensions.js), and:
   - tabs.query lists them in Min's order, each with its place in the window as its index (the library numbered the matches);
   - a tab without a page is listed as a discarded tab: a stand-in object in the library's tab store;
   - a tab whose page Min closes isn't reported closed until the next list shows it gone (hibernation keeps the tab: its
     stand-in takes the page's id). When it loads again, its new page has a new id: extensions get tabs.onReplaced, as
     Chrome sends when a discarded tab comes back with a new id;
   - an extension can act on a discarded tab as in Chrome: reloading it or giving it a new address loads it again in the
     background, activating it shows it, muting it is remembered for when it loads.
   This reaches into the library's internals (the names in missingExtensionTabInternals). If a newer version lacks one,
   none of it runs: extensions then see what the library alone shows, and Min says so in its log. */

let extensionTabSyncOn = false // set by startExtensionTabSync once the internals are there
const extensionTabListByWindow = new Map() // Min window id: {win, tasks: [{selectedHere, tabs: [{id, url, title, muted, favicon, hasView}]}]}
const extensionStandInTabs = new Map() // Min's tab id: stand-in
const extensionTabIndexes = new Map() // extension tab id: its place in its window
const pendingExtensionTabRemovals = new Map() // extension tab id: {minTabId, windowId, timer}
const suppressedExtensionTabEvents = { removed: new Set(), created: new Set() } // extension tab ids
let nextExtensionStandInId = 1000000 // for tabs that never had a page in this run (webContents ids are small and never reused)

// a tab without a page, in the library's tab store: just enough of a webContents for its tab details
class ExtensionStandInTab extends (require('events').EventEmitter) {
  constructor (id, entry) {
    super()
    this.id = id
    this.minTabId = entry.id
    this.isExtensionStandIn = true
    this.destroyed = false
    this.update(entry)
  }

  update (entry) {
    this.url = entry.url || ''
    this.title = entry.title || ''
    this.audioMuted = !!entry.muted
    this.favicon = entry.favicon || undefined
  }

  isDestroyed () { return this.destroyed }
  getURL () { return this.url }
  getTitle () { return this.title }
  isLoading () { return false }
  isCurrentlyAudible () { return false }
  getType () { return 'window' }

  // What the library does to a tab's page when an extension asks (tabs.reload, tabs.update, tabs.insertCSS, tabs.goBack,
  // webNavigation.getFrame). A discarded tab has no page: its window's UI loads it again (js/extensions.js), which
  // extensions then see as tabs.onReplaced.
  tellWindow (channel, data) {
    const win = chromeExtensions.ctx.store.tabToWindow.get(this)
    if (win && !win.isDestroyed()) {
      sendIPCToWindow(win, channel, Object.assign({ tabId: this.minTabId }, data))
    }
  }

  reload () { this.tellWindow('extensions-load-tab', {}) }
  reloadIgnoringCache () { this.reload() }

  loadURL (url) {
    this.url = url
    this.tellWindow('extensions-load-tab', { url })
    return Promise.resolve()
  }

  setAudioMuted (muted) {
    this.audioMuted = !!muted
    this.tellWindow('extensions-mute-tab', { muted: !!muted })
  }

  insertCSS () { return Promise.resolve('') }

  get navigationHistory () {
    const noPage = function () {
      throw new Error('This tab is discarded, so it has no page to go back or forward in. Reload or activate it first.')
    }
    return { goBack: noPage, goForward: noPage }
  }

  // no frames
  get mainFrame () { return { framesInSubtree: [] } }
}

// the parts of electron-chrome-extensions (4.10) this file uses, by name: those missing or of another kind
function missingExtensionTabInternals () {
  const ctx = chromeExtensions && chromeExtensions.ctx
  const router = ctx && ctx.router
  const store = ctx && ctx.store
  const query = router && router.handlers instanceof Map && router.handlers.get('tabs.query')
  const tabsAPI = chromeExtensions && chromeExtensions.api && chromeExtensions.api.tabs
  const needed = {
    'ctx.router.broadcastEvent': router && typeof router.broadcastEvent === 'function',
    'ctx.router.handlers (tabs.query)': query && typeof query.callback === 'function',
    'ctx.store.tabs': store && store.tabs instanceof Set,
    'ctx.store.tabToWindow': store && store.tabToWindow instanceof WeakMap,
    'ctx.store.tabDetailsCache': store && store.tabDetailsCache instanceof Map,
    'ctx.store.addWindow': store && typeof store.addWindow === 'function',
    'api.tabs.getTabDetails': tabsAPI && typeof tabsAPI.getTabDetails === 'function'
  }
  return Object.keys(needed).filter(name => !needed[name])
}

function startExtensionTabSync () {
  const missing = missingExtensionTabInternals()
  if (missing.length > 0) {
    console.warn('extensions: Min\'s tab list for extensions is off: electron-chrome-extensions has changed (missing ' + missing.join(', ') + ')')
    return
  }
  extensionTabSyncOn = true
  const router = chromeExtensions.ctx.router
  // Min sends some tab events itself (see the top of the file), instead of the library's
  const broadcast = router.broadcastEvent.bind(router)
  router.broadcastEvent = function (name, ...args) {
    if (name === 'tabs.onRemoved' && suppressedExtensionTabEvents.removed.has(args[0])) {
      return
    }
    if (name === 'tabs.onCreated' && args[0] && suppressedExtensionTabEvents.created.delete(args[0].id)) {
      return
    }
    return broadcast(name, ...args)
  }
  // the library numbers the tabs a query matched; Chrome gives each its place in its window
  const query = router.handlers.get('tabs.query')
  router.handlers.set('tabs.query', Object.assign({}, query, {
    callback: function (...args) {
      const list = query.callback(...args)
      if (Array.isArray(list)) {
        list.forEach(function (details) {
          if (extensionTabIndexes.has(details.id)) {
            details.index = extensionTabIndexes.get(details.id)
          }
        })
      }
      return list
    }
  }))
  // windows' UIs send their tab lists from now on
  windows.getAll().forEach(win => sendIPCToWindow(win, 'extensions-tab-list-wanted', true))
}

// the library's assignTabDetails (extensions.js): stand-ins are discarded tabs; every tab gets its place in its window
function assignExtensionTabDetails (details, contents) {
  if (contents && contents.isExtensionStandIn) {
    details.discarded = true
    details.status = 'unloaded'
    details.audible = false
    details.active = false
    details.highlighted = false
    details.favIconUrl = contents.favicon
  }
  if (extensionTabIndexes.has(details.id)) {
    details.index = extensionTabIndexes.get(details.id)
  }
}

ipc.on('extensions-tab-list', function (e, tasks) {
  const state = windows.windowFromContents(e.sender)
  if (!state || !Array.isArray(tasks)) {
    return
  }
  extensionTabListByWindow.set(state.id, { win: state.win, tasks })
  try {
    syncExtensionTabs()
  } catch (err) {
    // an error here would stop the main process behind Electron's error dialog; logged instead
    console.error('extensions: updating the tab list for extensions failed', err)
  }
})

function removeStandInFromStore (standIn) {
  const store = chromeExtensions.ctx.store
  standIn.destroyed = true
  store.tabs.delete(standIn)
  store.tabToWindow.delete(standIn)
  store.tabDetailsCache.delete(standIn.id)
}

function broadcastExtensionTabRemoved (tabId, windowId) {
  suppressedExtensionTabEvents.removed.delete(tabId)
  extensionTabIndexes.delete(tabId)
  chromeExtensions.ctx.store.tabDetailsCache.delete(tabId)
  chromeExtensions.ctx.router.broadcastEvent('tabs.onRemoved', tabId, { windowId: typeof windowId === 'number' ? windowId : -1, isWindowClosing: false })
}

// from the windows' latest lists: stand-ins for tabs without a page, the store's order, every tab's index
function syncExtensionTabs () {
  if (!chromeExtensions || !extensionTabSyncOn) {
    return
  }
  const store = chromeExtensions.ctx.store
  const ordered = [] // [contents or stand-in, window]
  const listed = new Set() // Min's tab ids
  // windows' lists in Min's window order; tasks shown in no window go after the first window's own tabs
  const lists = windows.openWindows.filter(w => !w.closed).map(w => extensionTabListByWindow.get(w.id)).filter(l => l && !l.win.isDestroyed())
  const add = function (entry, win) {
    if (!entry || listed.has(entry.id)) {
      return
    }
    listed.add(entry.id)
    const view = viewMap[entry.id]
    if (view && !view.webContents.isDestroyed() && store.tabs.has(view.webContents)) {
      ordered.push([view.webContents, win])
      return
    }
    let standIn = extensionStandInTabs.get(entry.id)
    if (entry.hasView && !standIn) {
      // its page is being created: the library gets it from viewManager.js
      return
    }
    if (standIn) {
      standIn.update(entry)
    } else {
      // a page Min just closed, still in the list: hibernated. The stand-in keeps the page's id
      const pending = [...pendingExtensionTabRemovals].find(([, p]) => p.minTabId === entry.id)
      const id = pending ? pending[0] : nextExtensionStandInId++
      standIn = new ExtensionStandInTab(id, entry)
      extensionStandInTabs.set(entry.id, standIn)
      if (pending) {
        clearTimeout(pending[1].timer)
        pendingExtensionTabRemovals.delete(id)
        standIn.discardedNow = true
      }
    }
    ordered.push([standIn, win])
  }
  lists.forEach(function (list) {
    list.tasks.filter(task => task.selectedHere).forEach(task => task.tabs.forEach(entry => add(entry, list.win)))
  })
  if (lists[0]) {
    lists[0].tasks.filter(task => !task.selectedInAnyWindow).forEach(task => task.tabs.forEach(entry => add(entry, lists[0].win)))
  }
  if (lists.length === 0) {
    return
  }

  // stand-ins of tabs that are gone: closed while they had no page
  for (const [minTabId, standIn] of extensionStandInTabs) {
    if (!listed.has(minTabId) || !ordered.some(([c]) => c === standIn)) {
      extensionStandInTabs.delete(minTabId)
      const win = store.tabToWindow.get(standIn)
      removeStandInFromStore(standIn)
      broadcastExtensionTabRemoved(standIn.id, win && !win.isDestroyed() ? win.id : -1)
    }
  }
  // pages Min closed whose tab is no longer in a list: closed
  for (const [tabId, pending] of pendingExtensionTabRemovals) {
    if (!listed.has(pending.minTabId)) {
      clearTimeout(pending.timer)
      pendingExtensionTabRemovals.delete(tabId)
      broadcastExtensionTabRemoved(tabId, pending.windowId)
    }
  }

  // the store's order is the order of tabs.query and windows' tab lists: Min's, then any tab Min didn't list
  const rest = [...store.tabs].filter(tab => !ordered.some(([c]) => c === tab))
  store.tabs.clear()
  const places = new Map() // window: next index
  for (const [tab, win] of ordered) {
    store.tabs.add(tab)
    if (tab.isExtensionStandIn) {
      store.tabToWindow.set(tab, win)
      store.addWindow(win)
    }
    const place = places.get(win) || 0
    places.set(win, place + 1)
    extensionTabIndexes.set(tab.id, place)
    const cached = store.tabDetailsCache.get(tab.id)
    if (cached) {
      cached.index = place
    }
  }
  rest.forEach(tab => store.tabs.add(tab))

  // tabs that just lost their page: still there, discarded (Chrome sends onUpdated with discarded: true)
  for (const [, standIn] of extensionStandInTabs) {
    if (standIn.discardedNow) {
      delete standIn.discardedNow
      suppressedExtensionTabEvents.removed.delete(standIn.id)
      const details = chromeExtensions.api.tabs.getTabDetails(standIn)
      chromeExtensions.ctx.router.broadcastEvent('tabs.onUpdated', standIn.id, { discarded: true, status: 'unloaded' }, details)
    }
  }
}

// viewManager.js is closing a tab's page (extensionsTabDestroyed): closed or hibernated, the next list tells
function noteExtensionTabPageClosing (contents) {
  if (!chromeExtensions || !extensionTabSyncOn || contents.isDestroyed() || !chromeExtensions.ctx.store.tabs.has(contents)) {
    return
  }
  const tabId = contents.id
  const win = chromeExtensions.ctx.store.tabToWindow.get(contents)
  suppressedExtensionTabEvents.removed.add(tabId)
  const pending = {
    minTabId: getTabIDFromWebContents(contents),
    windowId: win && !win.isDestroyed() ? win.id : -1,
    // no list came (the window closed, say): it was closed
    timer: setTimeout(function () {
      if (pendingExtensionTabRemovals.delete(tabId)) {
        broadcastExtensionTabRemoved(tabId, pending.windowId)
      }
    }, 2000)
  }
  pendingExtensionTabRemovals.set(tabId, pending)
}

// before the library is given a tab's new page (extensionsTabCreated): if the tab was listed as discarded, the new page
// replaces it. Returns the old id, for noteExtensionTabPageAdded.
function takeExtensionTabStandIn (contents) {
  if (!chromeExtensions || !extensionTabSyncOn) {
    return null
  }
  const minTabId = getTabIDFromWebContents(contents)
  const standIn = minTabId && extensionStandInTabs.get(minTabId)
  if (standIn) {
    extensionStandInTabs.delete(minTabId)
    removeStandInFromStore(standIn)
    suppressedExtensionTabEvents.created.add(contents.id)
    return standIn.id
  }
  // closed and opened again before the UI's list came: the same tab
  const pending = [...pendingExtensionTabRemovals].find(([, p]) => p.minTabId === minTabId)
  if (minTabId && pending) {
    clearTimeout(pending[1].timer)
    pendingExtensionTabRemovals.delete(pending[0])
    suppressedExtensionTabEvents.removed.delete(pending[0])
    suppressedExtensionTabEvents.created.add(contents.id)
    return pending[0]
  }
  return null
}

function noteExtensionTabPageAdded (contents, replacedId) {
  suppressedExtensionTabEvents.created.delete(contents.id)
  if (replacedId !== null && replacedId !== undefined) {
    extensionTabIndexes.set(contents.id, extensionTabIndexes.get(replacedId))
    extensionTabIndexes.delete(replacedId)
    chromeExtensions.ctx.router.broadcastEvent('tabs.onReplaced', contents.id, replacedId)
  }
}
