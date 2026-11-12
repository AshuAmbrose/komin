/* Chrome extensions (AGENTS.md section 10.9). Extensions load into normal tabs' session (persist:webcontent), never private tabs.
   Nothing here costs anything until the first extension is enabled: only then is electron-chrome-extensions loaded, which adds
   the chrome.* APIs Electron lacks (tabs, windows, action popups, context menus…) and a preload to every frame of the session.
   - Installed extensions are listed in <userData>/extensions.json. A .crx file is checked (js/util/extensionPackages.js),
     unpacked into <userData>/extensions/<id>/<version>, and its developer key is put in the manifest so Electron gives it its
     Chrome Web Store id. Unpacked folders ("Load unpacked") are loaded where they are.
   - The Chrome Web Store's "Add to Chrome" button works through js/preload/webStore.js (extensions-webstore, below), and
     installed .crx files update from the server their manifest names (checkExtensionUpdates).
   - Min's tabs are attached to the library in viewManager.js (extensionsTabCreated, extensionsTabShown, extensionsTabDestroyed).
   - js/preload/extensionSupport.js, in extensions' pages and background workers, supplies what Electron never sends,
     runtime.onInstalled and onStartup (asked for here with "min-extension-lifecycle"), and makes `browser` the same as `chrome`. */

const extensionsDir = path.join(userDataPath, 'extensions')
const extensionRegistryPath = path.join(userDataPath, 'extensions.json')
// APIs electron-chrome-extensions or Min (extensionAPIs.js) provide, although Electron warns that their permissions are unknown
const EXTENSION_PROVIDED_PERMISSIONS = ['contextMenus', 'notifications', 'webNavigation', 'cookies', 'tabs', 'windows', 'commands',
  'downloads', 'privacy', 'identity', 'sidePanel', 'browsingData', 'search', 'tts']

// id: {source: 'webstore' (signed by the Web Store) | 'crx' | 'unpacked', path, name, version, enabled, installedAt, updatedAt,
// lifecycleEvent, lastUpdateCheck, pendingUpdate: {version}, updateError}
let extensionRegistry = null
let chromeExtensions = null // the electron-chrome-extensions instance, once started
let extensionSession = null
const extensionLoadErrors = {} // id: message
const extensionWarnings = {} // extension folder: [unsupported permission]
const extensionStartupSent = new Set() // ids that got runtime.onStartup in this run
const extensionIdsInstalledThisRun = new Set()
const extensionTabsClosedByMin = new WeakSet()
const extensionWorkersListening = new WeakSet()
let minIsSelectingTab = false

// Electron reports permissions it doesn't support as a process warning while loading an extension
process.on('warning', function (warning) {
  if (warning.name !== 'ExtensionLoadWarning') {
    return
  }
  const folder = (warning.message.match(/Warnings loading extension at (.+):/) || [])[1]
  if (folder) {
    extensionWarnings[path.resolve(folder)] = Array.from(warning.message.matchAll(/Permission '([^']+)' is unknown/g)).map(m => m[1]).filter(p => !EXTENSION_PROVIDED_PERMISSIONS.includes(p))
  }
})

function getExtensionRegistry () {
  if (!extensionRegistry) {
    try {
      extensionRegistry = JSON.parse(fs.readFileSync(extensionRegistryPath, 'utf-8')).extensions || {}
    } catch (e) {
      extensionRegistry = {}
    }
  }
  return extensionRegistry
}

function saveExtensionRegistry () {
  try {
    fs.writeFileSync(extensionRegistryPath + '.tmp', JSON.stringify({ version: 1, extensions: getExtensionRegistry() }))
    fs.renameSync(extensionRegistryPath + '.tmp', extensionRegistryPath)
  } catch (e) {
    console.warn('failed to save extensions.json', e)
  }
}

/* Starting the extension system (once, when the first extension is enabled) */

function getExtensionTabWindow (contents) {
  return getWindowFromViewContents(contents) || windows.getCurrent()
}

function startChromeExtensions () {
  if (chromeExtensions) {
    return
  }
  const { ElectronChromeExtensions } = require('electron-chrome-extensions')
  extensionSession = session.fromPartition('persist:webcontent')

  // before the library's own preload, which the library registers when it's created (see the file)
  const earlyPreload = path.join(__dirname, 'js/preload/extensionSupportEarly.js')
  extensionSession.registerPreloadScript({ id: 'min-extension-support-early-frame', type: 'frame', filePath: earlyPreload })
  extensionSession.registerPreloadScript({ id: 'min-extension-support-early-worker', type: 'service-worker', filePath: earlyPreload })

  chromeExtensions = new ElectronChromeExtensions({
    session: extensionSession,
    createTab: openTabForExtension,
    selectTab: function (contents, win) {
      // the library also calls this when Min itself reports a tab switch. A discarded tab is a stand-in (extensionTabs.js)
      const tabId = !minIsSelectingTab && (contents.isExtensionStandIn ? contents.minTabId : getTabIDFromWebContents(contents))
      if (tabId) {
        sendIPCToWindow(win || getExtensionTabWindow(contents), 'extensions-select-tab', tabId)
      }
    },
    removeTab: function (contents, win) {
      // the library also calls this when a tab Min closed is destroyed
      if (contents.isDestroyed() || extensionTabsClosedByMin.has(contents)) {
        return
      }
      const tabId = contents.isExtensionStandIn ? contents.minTabId : getTabIDFromWebContents(contents)
      if (tabId) {
        sendIPCToWindow(win || getExtensionTabWindow(contents), 'extensions-close-tab', tabId)
      }
    },
    // windows.create opens its URLs as tabs in the current window
    createWindow: async function (details) {
      const urls = [].concat(details.url || [])
      for (const url of urls) {
        await openTabForExtension({ url, active: true })
      }
      return windows.getCurrent()
    },
    removeWindow: function () {},
    requestPermissions: requestExtensionPermissions,
    // what the library leaves out of tabs.query and the like (tab lists such as OneTab's show favicons)
    assignTabDetails: function (details, contents) {
      details.favIconUrl = extensionTabFavicons.get(contents) || details.favIconUrl
      details.highlighted = details.active
      // Min's tab order, and tabs without a page (extensionTabs.js)
      assignExtensionTabDetails(details, contents)
    }
  })
  startExtensionTabSync()

  // the library tells observers whenever an action (title, icon, badge, popup) or the active tab changes
  chromeExtensions.api.browserAction.observers.add({ isDestroyed: () => false, send: scheduleExtensionToolbarUpdate })

  // registered after the library's own preload, which it runs after (see the file)
  const supportPreload = path.join(__dirname, 'js/preload/extensionSupport.js')
  extensionSession.registerPreloadScript({ id: 'min-extension-support-frame', type: 'frame', filePath: supportPreload })
  extensionSession.registerPreloadScript({ id: 'min-extension-support-worker', type: 'service-worker', filePath: supportPreload })
  registerExtensionAPIs()
  // every API handler is registered now: what extensions may see and do without permission (extensionPermissions.js)
  startExtensionPermissionChecks()

  extensionSession.serviceWorkers.on('running-status-changed', function ({ versionId, runningStatus }) {
    if (runningStatus !== 'starting') {
      return
    }
    const worker = extensionSession.serviceWorkers.getWorkerFromVersionID(versionId)
    if (worker && worker.scope.startsWith('chrome-extension://') && !extensionWorkersListening.has(worker)) {
      extensionWorkersListening.add(worker)
      worker.ipc.handle('min-extension-lifecycle', function (event, pid) {
        noteExtensionWorkerProcess(pid)
        return getExtensionLifecycleEvent(new URL(worker.scope).hostname)
      })
    }
  })

  // Loading or unloading any extension makes Chromium rebuild some API objects (chrome.runtime, tabs, extension, action,
  // storage, permissions) in every running extension worker and page, dropping what the library and Min added to them:
  // chrome.tabs.create was gone, and Dark Reader's popup never loaded. extensionSupport.js puts its own back when asked.
  extensionSession.extensions.on('extension-loaded', scheduleExtensionAPIRestore)
  extensionSession.extensions.on('extension-unloaded', scheduleExtensionAPIRestore)

  Object.values(viewMap).forEach(view => extensionsTabCreated(view))
}

let extensionAPIRestoreTimers = []

function scheduleExtensionAPIRestore () {
  extensionAPIRestoreTimers.forEach(clearTimeout)
  // Chromium's rebuild reaches each process separately from Min's message: asked twice, soon and once it has surely
  // arrived (putting back what's already there does nothing)
  extensionAPIRestoreTimers = [250, 2000].map(delay => setTimeout(restoreExtensionAPIsEverywhere, delay))
}

function restoreExtensionAPIsEverywhere () {
  if (!extensionSession) {
    return
  }
  const running = extensionSession.serviceWorkers.getAllRunning()
  Object.keys(running).forEach(function (versionId) {
    if (!running[versionId].scope.startsWith('chrome-extension://')) {
      return
    }
    const worker = extensionSession.serviceWorkers.getWorkerFromVersionID(Number(versionId))
    if (worker && !worker.isDestroyed()) {
      worker.send('min-extension-restore-apis')
    }
  })
  // popups, options pages, side panels
  webContents.getAllWebContents().forEach(function (contents) {
    if (contents.isDestroyed() || !contents.mainFrame) {
      return
    }
    contents.mainFrame.framesInSubtree.forEach(function (frame) {
      if (frame.url.startsWith('chrome-extension://')) {
        try {
          frame.send('min-extension-restore-apis')
        } catch (e) {} // a frame that has just gone
      }
    })
  })
}

/* Low-resource mode for extensions' processes (viewManager.js, getTabProcessGroups) */

const extensionWorkerPids = new Set() // OS process ids of background workers, as each one reports when it starts

function noteExtensionWorkerProcess (pid) {
  // only a renderer of Min's own
  if (Number.isInteger(pid) && app.getAppMetrics().some(metric => metric.pid === pid && metric.type === 'Tab')) {
    extensionWorkerPids.add(pid)
  }
}

// extensions' processes: busy ones show a popup or a side panel, or play sound; the others are idle
function getExtensionProcesses () {
  const idle = new Set()
  const busy = new Set()
  if (!chromeExtensions) {
    return { idle: [], busy: [] }
  }
  const livePids = new Set(app.getAppMetrics().map(metric => metric.pid))
  extensionWorkerPids.forEach(function (pid) {
    if (livePids.has(pid)) {
      idle.add(pid)
    } else {
      extensionWorkerPids.delete(pid)
    }
  })
  const sidePanels = getExtensionSidePanelContents()
  webContents.getAllWebContents().forEach(function (contents) {
    if (contents.isDestroyed() || contents.session !== extensionSession || !contents.getURL().startsWith('chrome-extension://')) {
      return
    }
    const popup = BrowserWindow.fromWebContents(contents)
    const shown = (popup && popup.isVisible()) || sidePanels.includes(contents) || contents.isCurrentlyAudible()
    ;(shown ? busy : idle).add(contents.getOSProcessId())
  })
  return { idle: [...idle].filter(pid => pid && !busy.has(pid)), busy: [...busy] }
}

// the runtime.onInstalled or onStartup event an extension's background worker should get when it starts, or null
async function getExtensionLifecycleEvent (id) {
  // an unpacked folder's id is only known once it has loaded, and its worker can start before it's recorded
  for (let i = 0; i < 40 && !getExtensionRegistry()[id]; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const entry = getExtensionRegistry()[id]
  if (!entry) {
    return null
  }
  if (entry.lifecycleEvent) {
    const event = entry.lifecycleEvent
    delete entry.lifecycleEvent
    saveExtensionRegistry()
    extensionStartupSent.add(id)
    return event
  }
  if (!extensionStartupSent.has(id) && !extensionIdsInstalledThisRun.has(id)) {
    extensionStartupSent.add(id)
    return { type: 'startup' }
  }
  return null
}

async function loadInstalledExtension (id) {
  const entry = getExtensionRegistry()[id]
  try {
    if (!fs.existsSync(entry.path)) {
      throw new Error('its folder is missing: ' + entry.path)
    }
    checkExtensionManifestVersion(parseExtensionManifest(fs.readFileSync(path.join(entry.path, 'manifest.json'))))
    const extension = await extensionSession.extensions.loadExtension(entry.path)
    if (extension.id !== id) {
      extensionSession.extensions.removeExtension(extension.id)
      throw new Error('its id changed (from ' + id + ' to ' + extension.id + ')')
    }
    delete extensionLoadErrors[id]
    return extension
  } catch (e) {
    console.warn('failed to load extension ' + entry.name, e)
    extensionLoadErrors[id] = e.message
    return null
  }
}

async function unloadExtension (id) {
  if (extensionSession && extensionSession.extensions.getExtension(id)) {
    extensionSession.extensions.removeExtension(id)
  }
}

// "clear browsing data" for normal tabs, keeping installed extensions' own data and background workers, as Chrome does
// (clearStorageData would also unregister their service workers)
function clearTabStorageKeepingExtensions () {
  const ses = session.fromPartition('persist:webcontent')
  const ids = Object.keys(getExtensionRegistry())
  if (ids.length === 0) {
    return ses.clearStorageData()
  }
  return ses.clearData({
    dataTypes: ['backgroundFetch', 'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'webSQL'],
    excludeOrigins: ids.map(id => 'chrome-extension://' + id)
  })
}

// chrome.storage and dynamic network rules of removed extensions; deleted at startup, since they stay open while Min runs
function removeLeftoverExtensionData () {
  const partitionPath = session.fromPartition('persist:webcontent').storagePath
  // Min's network helper keeps its rules while it's going to be used (applyExtensionNetworkFiltering)
  const helperNeeded = settings.get('extensionsFilterNetwork') === true && getNetworkFilteringExtensionIds().length > 0
  ;['Local Extension Settings', 'Sync Extension Settings', 'DNR Extension Rules'].forEach(function (name) {
    fs.readdir(path.join(partitionPath, name), function (err, ids) {
      if (err) {
        return
      }
      ids.filter(id => /^[a-p]{32}$/.test(id) && !getExtensionRegistry()[id] && !(id === NETWORK_HELPER_ID && helperNeeded)).forEach(function (id) {
        fs.rm(path.join(partitionPath, name, id), { recursive: true, force: true }, function () {})
      })
    })
  })
}

let extensionsLoadingAtStartup = null // while the enabled extensions load at startup

app.whenReady().then(async function () {
  removeLeftoverExtensionData()
  const registry = getExtensionRegistry()
  if (Object.values(registry).some(entry => entry.source !== 'unpacked')) {
    scheduleExtensionUpdates()
  }
  const enabled = Object.keys(registry).filter(id => registry[id].enabled)
  if (enabled.length === 0) {
    // no extension can be controlling Min's settings (extensionAPIs.js): correct a value saved by an earlier run
    if (settings.get('extensionsPasswordSavingOff') === true) {
      settings.set('extensionsPasswordSavingOff', false)
    }
    return
  }
  startChromeExtensions()
  extensionsLoadingAtStartup = (async function () {
    for (const id of enabled) {
      await loadInstalledExtension(id)
    }
  })()
  await extensionsLoadingAtStartup
  extensionsLoadingAtStartup = null
})

// tabs restored at startup load their page once extensions have loaded, so that content scripts run in them (viewManager.js)
function whenExtensionsLoadedFor (contents) {
  return extensionsLoadingAtStartup && contents.session === extensionSession ? extensionsLoadingAtStartup : null
}

app.whenReady().then(function () {
  // calls back at once with the current value, so only once the app is ready
  settings.listen('extensionsFilterNetwork', () => applyExtensionNetworkFiltering())
  settings.listen('filtering', function () {
    if (extensionNetworkFilteringOn) {
      updateNetworkHelperRules()
    }
  })
})

/* Min's tabs, attached by viewManager.js */

function extensionsTabCreated (view) {
  const contents = view.webContents
  if (!chromeExtensions || contents.isDestroyed() || contents.session !== extensionSession || chromeExtensions.ctx.store.tabs.has(contents)) {
    return
  }
  // the library makes every tab it's given the active one (and asks Min to switch to it), but Min opens tabs in the
  // background too: while it's added, it's marked active already, then the window's real active tab is put back.
  // It becomes active when Min shows it (extensionsTabShown).
  const store = chromeExtensions.ctx.store
  const win = getExtensionTabWindow(contents)
  const activeTab = store.windowToActiveTab.get(win)
  store.windowToActiveTab.set(win, contents)
  // a tab listed as discarded gets its page back: the page replaces it (extensionTabs.js)
  const replacedId = takeExtensionTabStandIn(contents)
  try {
    chromeExtensions.addTab(contents, win)
    noteExtensionTabPageAdded(contents, replacedId)
  } finally {
    if (activeTab) {
      store.windowToActiveTab.set(win, activeTab)
    } else {
      store.windowToActiveTab.delete(win)
    }
  }
  // what was right-clicked, for extensions' items in the page's menu (getExtensionContextMenuItems)
  contents.on('context-menu', function (e, params) {
    extensionContextMenuParams.set(contents, params)
  })
  contents.on('page-favicon-updated', function (e, favicons) {
    extensionTabFavicons.set(contents, favicons[0])
  })
  // while an extension filters normal tabs, Min's response hook (download.js) is gone: .user.js installs and file views from here
  contents.on('did-start-navigation', function (details) {
    if (extensionNetworkFilteringOn && details.isMainFrame && !details.isSameDocument && typeof promptUserscriptInstall === 'function') {
      promptUserscriptInstall(contents, details.url, null)
    }
  })
  contents.on('did-finish-load', function () {
    if (extensionNetworkFilteringOn) {
      reportExtensionTabFileView(contents)
    }
  })
}

const shownTabByWindow = new WeakMap() // window: webContents of the tab it shows, private ones too (for the toolbar)
const extensionTabFavicons = new WeakMap() // webContents: favicon address

function extensionsTabShown (view, win) {
  shownTabByWindow.set(win, view.webContents)
  if (!chromeExtensions) {
    return
  }
  // the buttons follow the shown tab: per-tab badges and icons, and none on private tabs (extensions don't run there).
  // The library only reports switches between its own tabs, not back from a private one.
  scheduleExtensionToolbarUpdate()
  // an extension's side panel goes back on top of the tab (Min removed every view but the UI to show this one)
  extensionsSidePanelShown(win)
  if (view.webContents.session !== extensionSession) {
    return
  }
  const store = chromeExtensions.ctx.store
  // a tab can move to another window when its task is opened there; the library has no API for that
  if (store.tabToWindow.get(view.webContents) !== win) {
    store.tabToWindow.set(view.webContents, win)
    store.addWindow(win)
  }
  minIsSelectingTab = true
  try {
    chromeExtensions.selectTab(view.webContents)
  } finally {
    minIsSelectingTab = false
  }
}

function extensionsTabDestroyed (contents) {
  extensionTabsClosedByMin.add(contents)
  // closed, or hibernated: the UI's next tab list tells (extensionTabs.js)
  noteExtensionTabPageClosing(contents)
}

// chrome.tabs.create (and windows.create): the UI adds the tab, and its view is returned
const pendingExtensionTabs = new Map() // request id: function (tabId)

function openTabForExtension (details) {
  const win = windows.getCurrent()
  const requestId = Math.random().toString(36).slice(2)
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      pendingExtensionTabs.delete(requestId)
      reject(new Error('Min didn\'t open the tab'))
    }, 10000)
    pendingExtensionTabs.set(requestId, function (tabId) {
      clearTimeout(timer)
      pendingExtensionTabs.delete(requestId)
      const waitForView = function (tries) {
        if (viewMap[tabId]) {
          extensionsTabCreated(viewMap[tabId])
          resolve([viewMap[tabId].webContents, win])
        } else if (tries > 0) {
          setTimeout(() => waitForView(tries - 1), 50)
        } else {
          reject(new Error('the new tab has no view'))
        }
      }
      waitForView(100)
    })
    sendIPCToWindow(win, 'extensions-open-tab', { requestId, url: details.url || '', active: details.active !== false })
  })
}

ipc.on('extensions-tab-opened', function (event, args) {
  const resolve = windows.windowFromContents(event.sender) && args && pendingExtensionTabs.get(args.requestId)
  if (resolve) {
    resolve(args.tabId)
  }
})

/* Installing */

function readExtensionLocaleMessages (folderOrFiles, manifest) {
  if (!manifest.default_locale) {
    return {}
  }
  const name = '_locales/' + manifest.default_locale + '/messages.json'
  try {
    const data = Array.isArray(folderOrFiles)
      ? folderOrFiles.find(file => file.path === name).data
      : fs.readFileSync(path.join(folderOrFiles, name))
    return JSON.parse(data.toString('utf-8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return {}
  }
}

function parseExtensionManifest (data) {
  return JSON.parse(data.toString('utf-8').replace(/^\uFEFF/, ''))
}

// the permission review's lines for describeExtensionPermissions' result
function describePermissionsForReview (permissions) {
  const lines = []
  if (permissions.allSites) {
    lines.push(l('extensionPermissionAllSites'))
  } else if (permissions.sites.length > 0) {
    lines.push(l('extensionPermissionSomeSites').replace('%s', permissions.sites.slice(0, 5).join(', ') + (permissions.sites.length > 5 ? ', …' : '')))
  }
  permissions.items.forEach(item => lines.push(l(item)))
  permissions.other.forEach(item => lines.push(item))
  return lines
}

function describeExtensionForReview (manifest) {
  return describePermissionsForReview(describeExtensionPermissions(manifest))
}

// the permission review. options.name replaces the manifest's name (the Web Store sends it translated);
// options.increase reviews an update: only what the new version adds (getExtensionPermissionIncrease)
async function confirmExtensionInstall (manifest, messages, win, options = {}) {
  const name = options.name || getExtensionManifestText(manifest, 'name', messages)
  let detail
  if (options.increase) {
    detail = l('extensionUpdateCan') + '\n• ' + describePermissionsForReview(options.increase).join('\n• ')
  } else {
    const lines = describeExtensionForReview(manifest)
    detail = lines.length > 0 ? l('extensionInstallCan') + '\n• ' + lines.join('\n• ') : l('extensionInstallNothing')
  }
  if (extensionUsesNetworkFiltering(manifest)) {
    detail += '\n\n' + l('extensionInstallNetwork')
  }
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [l(options.increase ? 'extensionUpdateButton' : 'extensionInstallButton'), l('extensionInstallCancel')],
    defaultId: 0,
    cancelId: 1,
    message: l(options.increase ? 'extensionUpdateTitle' : 'extensionInstallTitle').replace('%s', name),
    detail
  })
  return result.response === 0
}

// chrome.permissions.request for optional permissions
async function requestExtensionPermissions (extension, permissions) {
  const manifest = { manifest_version: 3, permissions: permissions.permissions || [], host_permissions: permissions.origins || [] }
  const lines = describeExtensionForReview(manifest)
  const result = await dialog.showMessageBox(windows.getCurrent(), {
    type: 'question',
    buttons: [l('extensionPermissionRequestAllow'), l('extensionPermissionRequestDeny')],
    defaultId: 1,
    cancelId: 1,
    message: l('extensionPermissionRequestTitle').replace('%s', extension.name),
    detail: lines.length > 0 ? '• ' + lines.join('\n• ') : ''
  })
  return result.response === 0
}

// options.keepEnabled: an automatic update leaves a turned-off extension off
function registerInstalledExtension (id, details, options = {}) {
  const registry = getExtensionRegistry()
  const previous = registry[id]
  registry[id] = Object.assign({}, previous, details, {
    enabled: previous && options.keepEnabled ? previous.enabled : true,
    installedAt: previous ? previous.installedAt : Date.now(),
    updatedAt: Date.now(),
    lifecycleEvent: previous
      ? { type: 'installed', reason: 'update', previousVersion: previous.version }
      : { type: 'installed', reason: 'install' }
  })
  delete registry[id].pendingUpdate
  delete registry[id].updateError
  if (!previous) {
    extensionIdsInstalledThisRun.add(id)
  }
  saveExtensionRegistry()
  return previous
}

// Manifest V2 (the older format: background pages, browser_action, blocking webRequest) isn't supported, as in Chrome
// since 2025: refused at every way in, and an installed one isn't loaded (Settings shows why)
function checkExtensionManifestVersion (manifest) {
  if (!manifest || manifest.manifest_version !== 3) {
    throw new Error(l('extensionManifestV2'))
  }
}

/*
A checked .crx: {crx, files, manifest, messages}. Throws if it isn't a valid, signed extension Min can run.
options.id: the id it must have (a download for a known extension); options.webStore: it must be signed by the Chrome Web Store.
*/
function readExtensionCrx (data, options = {}) {
  const crx = parseCrx(data)
  if (options.id && crx.id !== options.id) {
    throw new Error('The download is a different extension (' + crx.id + ')')
  }
  if (options.webStore && !crx.fromWebStore) {
    throw new Error('The download isn\'t signed by the Chrome Web Store')
  }
  const files = readExtensionZip(crx.zip)
  const manifestFile = files.find(file => file.path === 'manifest.json')
  if (!manifestFile) {
    throw new Error('The extension has no manifest.json')
  }
  const manifest = parseExtensionManifest(manifestFile.data)
  checkExtensionManifestVersion(manifest)
  // it becomes the extension's folder name (installCheckedExtension)
  if (!isValidExtensionVersion(manifest.version)) {
    throw new Error('The extension\'s version isn\'t valid: ' + String(manifest.version).slice(0, 40))
  }
  if (manifest.minimum_chrome_version && compareExtensionVersions(manifest.minimum_chrome_version, process.versions.chrome) > 0) {
    throw new Error(l('extensionNeedsNewerBrowser').replace('%s', manifest.minimum_chrome_version))
  }
  return { crx, files, manifest, messages: readExtensionLocaleMessages(files, manifest) }
}

async function installExtensionFromCrx (filePath, win) {
  const checked = readExtensionCrx(fs.readFileSync(filePath))
  if (!(await confirmExtensionInstall(checked.manifest, checked.messages, win))) {
    return null
  }
  return installCheckedExtension(checked)
}

// writes a checked .crx to <userData>/extensions/<id>/<version> and loads it in place of the previous version, if any.
// options.update: an automatic or reviewed update
// writes an extension's files without blocking the main process: written one by one, Wappalyzer's 13,000 files took
// 21 s on Windows (each one is scanned), with Min frozen meanwhile
async function writeExtensionFiles (folder, files) {
  const directories = new Set(files.map(file => path.dirname(path.join(folder, file.path))))
  for (const directory of directories) {
    await fs.promises.mkdir(directory, { recursive: true })
  }
  let next = 0
  const writeNext = async function () {
    while (next < files.length) {
      const file = files[next++]
      await fs.promises.writeFile(path.join(folder, file.path), file.data)
    }
  }
  await Promise.all(Array.from({ length: 16 }, writeNext))
}

async function installCheckedExtension ({ crx, files, manifest, messages }, options = {}) {
  // with its developer key in the manifest, Electron gives the extension its Chrome Web Store id
  manifest.key = crx.publicKey.toString('base64')
  const folder = path.join(extensionsDir, crx.id, manifest.version)
  // readExtensionCrx checked the version; this is the last line of defence for the rm and rename below
  if (path.dirname(folder) !== path.join(extensionsDir, crx.id)) {
    throw new Error('The extension\'s version isn\'t valid: ' + manifest.version)
  }
  const temporary = folder + '.tmp'
  await fs.promises.rm(temporary, { recursive: true, force: true })
  // The manifest the user reviewed goes in last, once every other file is written, and is read back. On Windows
  // another entry of the zip can name the same file (MANIFEST.JSON, "manifest.json."), and written after it, it
  // replaced the reviewed manifest, permissions and all (security review A3).
  const manifestText = JSON.stringify(manifest, null, 2)
  await fs.promises.mkdir(temporary, { recursive: true })
  await writeExtensionFiles(temporary, files.filter(file => file.path !== 'manifest.json'))
  await fs.promises.writeFile(path.join(temporary, 'manifest.json'), manifestText)
  if ((await fs.promises.readFile(path.join(temporary, 'manifest.json'), 'utf8')) !== manifestText) {
    await fs.promises.rm(temporary, { recursive: true, force: true })
    throw new Error('The extension\'s files couldn\'t be written as checked')
  }
  await unloadExtension(crx.id)
  await fs.promises.rm(folder, { recursive: true, force: true })
  await fs.promises.rename(temporary, folder)

  const details = Object.assign({ source: crx.fromWebStore ? 'webstore' : 'crx', path: folder, name: getExtensionManifestText(manifest, 'name', messages), version: manifest.version }, getExtensionNetworkDetails(manifest))
  const previous = registerInstalledExtension(crx.id, details, { keepEnabled: options.update })
  if (getExtensionRegistry()[crx.id].enabled) {
    startChromeExtensions()
    await loadInstalledExtension(crx.id)
  }
  // the previous version's files go once the new one is in place
  if (previous && previous.source !== 'unpacked' && previous.path !== folder) {
    fs.rm(previous.path, { recursive: true, force: true }, function () {})
  }
  if (!previous) {
    notifyWebStorePages('onInstalled', getWebStoreExtensionInfo(crx.id))
  }
  finishExtensionInstall(crx.id, manifest, previous)
  scheduleExtensionUpdates()
  return crx.id
}

async function loadUnpackedExtension (folder) {
  const manifest = parseExtensionManifest(fs.readFileSync(path.join(folder, 'manifest.json')))
  checkExtensionManifestVersion(manifest)
  const messages = readExtensionLocaleMessages(folder, manifest)
  const details = Object.assign({ source: 'unpacked', path: folder, name: getExtensionManifestText(manifest, 'name', messages), version: manifest.version }, getExtensionNetworkDetails(manifest))
  startChromeExtensions()

  // loading a folder again (or "Reload") replaces it and is an update, as in Chrome; recorded first, since its worker asks as it starts
  const registry = getExtensionRegistry()
  const previousId = Object.keys(registry).find(id => registry[id].source === 'unpacked' && path.resolve(registry[id].path) === path.resolve(folder))
  const previous = previousId ? Object.assign({}, registry[previousId]) : null
  if (previousId) {
    await unloadExtension(previousId)
    registerInstalledExtension(previousId, details)
  }
  let extension
  try {
    extension = await extensionSession.extensions.loadExtension(folder)
  } catch (e) {
    if (previousId) {
      extensionLoadErrors[previousId] = e.message
    }
    throw e
  }
  if (extension.id !== previousId) {
    if (previousId) {
      delete registry[previousId]
    }
    registerInstalledExtension(extension.id, details)
  }
  delete extensionLoadErrors[extension.id]
  finishExtensionInstall(extension.id, manifest, previous)
  return extension.id
}

async function removeInstalledExtension (id) {
  const entry = getExtensionRegistry()[id]
  if (!entry) {
    return
  }
  await unloadExtension(id)
  delete getExtensionRegistry()[id]
  saveExtensionRegistry()
  // an extension's saved data goes with it, as in Chrome (its chrome.storage at the next start: removeLeftoverExtensionData);
  // Min's own copy of a .crx install too, but never an unpacked folder
  if (extensionSession) {
    extensionSession.clearData({ origins: ['chrome-extension://' + id] }).catch(() => {})
  }
  if (entry.source !== 'unpacked') {
    fs.rm(path.join(extensionsDir, id), { recursive: true, force: true }, function () {})
  }
  notifyWebStorePages('onUninstalled', id)
  applyExtensionNetworkFiltering()
}

async function setExtensionEnabled (id, enabled) {
  const entry = getExtensionRegistry()[id]
  if (!entry) {
    return
  }
  entry.enabled = !!enabled
  saveExtensionRegistry()
  if (enabled) {
    startChromeExtensions()
    await loadInstalledExtension(id)
  } else {
    await unloadExtension(id)
  }
  notifyWebStorePages(enabled ? 'onEnabled' : 'onDisabled', getWebStoreExtensionInfo(id))
  applyExtensionNetworkFiltering()
}

function getExtensionIcon (folder, manifest) {
  const icons = manifest.icons || {}
  const size = Object.keys(icons).map(Number).sort((a, b) => a - b).find(s => s >= 32) || Object.keys(icons).map(Number).pop()
  if (!size) {
    return ''
  }
  try {
    const file = path.join(folder, icons[size])
    if (path.relative(folder, file).startsWith('..')) {
      return ''
    }
    return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
  } catch (e) {
    return ''
  }
}

function getExtensionManagementList () {
  const registry = getExtensionRegistry()
  return Object.keys(registry).map(function (id) {
    const entry = registry[id]
    let manifest = {}
    let messages = {}
    try {
      manifest = parseExtensionManifest(fs.readFileSync(path.join(entry.path, 'manifest.json')))
      messages = readExtensionLocaleMessages(entry.path, manifest)
    } catch (e) {}
    const permissions = describeExtensionPermissions(manifest)
    return {
      id,
      name: getExtensionManifestText(manifest, 'name', messages) || entry.name,
      description: getExtensionManifestText(manifest, 'description', messages),
      version: manifest.version || entry.version,
      icon: getExtensionIcon(entry.path, manifest),
      enabled: entry.enabled,
      loaded: !!(extensionSession && extensionSession.extensions.getExtension(id)),
      source: entry.source,
      path: entry.source === 'unpacked' ? entry.path : '',
      error: extensionLoadErrors[id] || '',
      unsupported: extensionWarnings[path.resolve(entry.path)] || [],
      networkFiltering: extensionUsesNetworkFiltering(manifest),
      // its network filtering is in charge of normal tabs (else Min's ad blocker is)
      filteringNetwork: extensionNetworkFilteringOn && entry.enabled && extensionUsesNetworkFiltering(manifest),
      permissions: describeExtensionForReview(manifest),
      allSites: permissions.allSites,
      webStoreURL: entry.source === 'webstore' ? 'https://chromewebstore.google.com/detail/' + id : '',
      hasOptions: !!getExtensionOptionsURL(id, manifest),
      pendingUpdate: entry.pendingUpdate ? entry.pendingUpdate.version : '',
      updateError: entry.updateError || ''
    }
  })
}

function notifyExtensionPages () {
  Object.values(viewMap).forEach(function (view) {
    if (!view.webContents.isDestroyed() && view.webContents.getURL().startsWith('min://app/pages/settings/')) {
      view.webContents.send('extensions-page-changed')
    }
  })
}

const extensionPageActions = {
  list: () => getExtensionManagementList(),
  'install-crx': async function (args, event) {
    const win = getExtensionTabWindow(event.sender)
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: l('extensionCrxFiles'), extensions: ['crx'] }] })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    return installExtensionFromCrx(result.filePaths[0], win)
  },
  'load-unpacked': async function (args, event) {
    const win = getExtensionTabWindow(event.sender)
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    return loadUnpackedExtension(result.filePaths[0])
  },
  'set-enabled': args => setExtensionEnabled(args.id, args.enabled),
  remove: args => removeInstalledExtension(args.id),
  // unpacked folders only: picks up the developer's changes
  reload: async function (args) {
    const entry = getExtensionRegistry()[args.id]
    if (entry && entry.source === 'unpacked') {
      await loadUnpackedExtension(entry.path)
    }
    return null
  },
  'open-options': async function (args) {
    const extension = extensionSession && extensionSession.extensions.getExtension(args.id)
    const url = extension && getExtensionOptionsURL(extension.id, extension.manifest)
    if (url) {
      await openTabForExtension({ url, active: true })
    }
    return null
  },
  'check-updates': async function () {
    await checkExtensionUpdates()
    return getExtensionManagementList()
  },
  // an update that asks for more permissions: the review, then the update
  'review-update': async function (args, event) {
    const win = getExtensionTabWindow(event.sender)
    await checkExtensionUpdates({ id: args.id, win })
    return null
  }
}

ipc.handle('extensions-page', async function (event, request) {
  const frame = event.senderFrame
  if (!frame || frame.parent || !frame.url.startsWith('min://app/pages/settings/')) {
    throw new Error('Not allowed')
  }
  const action = request && Object.hasOwn(extensionPageActions, request.action) && extensionPageActions[request.action]
  if (!action) {
    throw new Error('Unknown action')
  }
  try {
    return await action(request.args || {}, event)
  } finally {
    if (request.action !== 'list') {
      notifyExtensionPages()
    }
  }
})

/* Downloads: .crx files and update checks, https only and without cookies (Chrome sends none to update servers) */

const EXTENSION_MAX_DOWNLOAD_SIZE = 256 * 1024 * 1024

async function downloadForExtensions (url, options = {}) {
  if (!url.startsWith('https://')) {
    throw new Error('Not an https address: ' + url)
  }
  const response = await net.fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(options.timeout || 120 * 1000) })
  if (!response.ok) {
    throw new Error('The server answered ' + response.status + ' (' + new URL(url).host + ')')
  }
  if (Number(response.headers.get('content-length')) > EXTENSION_MAX_DOWNLOAD_SIZE) {
    throw new Error('The download is too large')
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > EXTENSION_MAX_DOWNLOAD_SIZE) {
    throw new Error('The download is too large')
  }
  if (options.sha256 && extensionCrypto.createHash('sha256').update(data).digest('hex') !== options.sha256) {
    throw new Error('The download is damaged (its checksum doesn\'t match)')
  }
  return data
}

/*
The Chrome Web Store's "Add to Chrome" button. js/preload/webStore.js gives the store's page chrome.webstorePrivate and
chrome.management and forwards the calls here (extensions-webstore), only from the store's own top frame. Installing:
the review (from the manifest the store sends), then the .crx from Google's update server, which must be signed by the
developer and by the Web Store and have the id asked for; if it asks for more than the store said, it's reviewed again.
Answers are {result, error}: Chrome's result values, and the error for lastError.
*/

const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com'
const webStoreInstalling = new Set()

// chrome.management's ExtensionInfo, as much of it as the store uses
function getWebStoreExtensionInfo (id) {
  const entry = getExtensionRegistry()[id]
  if (!entry) {
    return null
  }
  let manifest = {}
  try {
    manifest = parseExtensionManifest(fs.readFileSync(path.join(entry.path, 'manifest.json')))
  } catch (e) {}
  return {
    id,
    name: entry.name,
    shortName: entry.name,
    description: '',
    version: entry.version,
    enabled: !!entry.enabled,
    mayDisable: true,
    type: 'extension',
    isApp: false,
    installType: entry.source === 'unpacked' ? 'development' : 'normal',
    offlineEnabled: false,
    homepageUrl: '',
    optionsUrl: '',
    updateUrl: manifest.update_url || '',
    permissions: (manifest.permissions || []).filter(p => typeof p === 'string'),
    hostPermissions: manifest.host_permissions || [],
    icons: []
  }
}

// tells open store pages, so the "Add to Chrome" / "Remove from Chrome" button follows changes made anywhere
function notifyWebStorePages (name, data) {
  Object.values(viewMap).forEach(function (view) {
    if (!view.webContents.isDestroyed() && view.webContents.getURL().startsWith(WEBSTORE_ORIGIN + '/')) {
      view.webContents.send('extensions-webstore-event', name, data)
    }
  })
}

async function beginWebStoreInstall (event, details) {
  const id = details && details.id
  if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) {
    return { result: 'invalid_id', error: 'Invalid id' }
  }
  if (getExtensionRegistry()[id]) {
    return { result: 'already_installed', error: 'Already installed' }
  }
  if (webStoreInstalling.has(id)) {
    return { result: 'install_in_progress', error: 'Already installing' }
  }
  let storeManifest
  try {
    storeManifest = JSON.parse(details.manifest)
  } catch (e) {
    return { result: 'manifest_error', error: 'Invalid manifest' }
  }
  if (!storeManifest || storeManifest.manifest_version !== 3) {
    return { result: 'manifest_error', error: l('extensionManifestV2') }
  }
  const win = getExtensionTabWindow(event.sender)
  webStoreInstalling.add(id)
  try {
    if (!(await confirmExtensionInstall(storeManifest, {}, win, { name: details.localizedName }))) {
      return { result: 'user_cancelled', error: 'User cancelled install' }
    }
    const checked = readExtensionCrx(await downloadForExtensions(getWebStoreDownloadURL(id, process.versions.chrome)), { id, webStore: true })
    if (getExtensionPermissionIncrease(storeManifest, checked.manifest) && !(await confirmExtensionInstall(checked.manifest, checked.messages, win))) {
      return { result: 'user_cancelled', error: 'User cancelled install' }
    }
    await installCheckedExtension(checked)
    notifyExtensionPages()
    return { result: 'success' }
  } catch (e) {
    console.warn('Chrome Web Store install failed', e)
    return { result: 'install_error', error: e.message }
  } finally {
    webStoreInstalling.delete(id)
  }
}

const webStoreActions = {
  beginInstall: beginWebStoreInstall,
  // beginInstall did everything
  completeInstall: () => ({ result: 'success' }),
  getExtensionStatus: function (event, id) {
    const entry = getExtensionRegistry()[id]
    return { result: entry ? (entry.enabled ? 'enabled' : 'disabled') : 'installable' }
  },
  isInIncognitoMode: event => ({ result: !event.sender.session.isPersistent() }),
  getAll: () => ({ result: Object.keys(getExtensionRegistry()).map(getWebStoreExtensionInfo) }),
  get: function (event, id) {
    const info = getWebStoreExtensionInfo(id)
    return info ? { result: info } : { error: 'Failed to find extension with id ' + id + '.' }
  },
  setEnabled: async function (event, id, enabled) {
    if (!getExtensionRegistry()[id]) {
      return { error: 'Failed to find extension with id ' + id + '.' }
    }
    await setExtensionEnabled(id, enabled)
    notifyExtensionPages()
    return {}
  },
  // the store's "Remove from Chrome" button
  uninstall: async function (event, id, options) {
    const entry = getExtensionRegistry()[id]
    if (!entry) {
      return { error: 'Failed to find extension with id ' + id + '.' }
    }
    const answer = await dialog.showMessageBox(getExtensionTabWindow(event.sender), {
      type: 'question',
      buttons: [l('settingsExtensionsRemove'), l('extensionInstallCancel')],
      defaultId: 0,
      cancelId: 1,
      message: l('settingsExtensionsRemoveConfirm').replace('%s', entry.name)
    })
    if (answer.response !== 0) {
      return { error: 'User cancelled uninstall' }
    }
    await removeInstalledExtension(id)
    notifyExtensionPages()
    return {}
  }
}

ipc.handle('extensions-webstore', async function (event, request) {
  const frame = event.senderFrame
  let origin = null
  try {
    origin = frame && !frame.parent && new URL(frame.url).origin
  } catch (e) {}
  if (origin !== WEBSTORE_ORIGIN || !getTabIDFromWebContents(event.sender)) {
    return { error: 'Not allowed' }
  }
  const action = request && Object.hasOwn(webStoreActions, request.action) && webStoreActions[request.action]
  if (!action) {
    return { error: 'Not supported' }
  }
  try {
    return await action(event, ...(Array.isArray(request.args) ? request.args : []))
  } catch (e) {
    return { result: 'unknown_error', error: e.message }
  }
})

/*
Updates, with Chrome's update protocol, for every installed .crx whose manifest names an update server (Web Store
extensions name Google's: EXTENSION_WEBSTORE_UPDATE_URL, whose files must also be signed by the Web Store). An update
that asks for nothing new installs at once. One that asks for more waits, with the installed version still running,
until the user reviews it in Settings ("Review update"), as Chrome asks before granting new permissions.
Checked 10 minutes after startup, then every 5 hours while Min runs (a request per update server).
*/

const EXTENSION_UPDATE_INTERVAL = 5 * 60 * 60 * 1000
const EXTENSION_FIRST_UPDATE_DELAY = 10 * 60 * 1000
let extensionUpdateTimer = null
let extensionUpdateCheck = null

function readInstalledExtensionManifest (entry) {
  try {
    return parseExtensionManifest(fs.readFileSync(path.join(entry.path, 'manifest.json')))
  } catch (e) {
    return null
  }
}

function scheduleExtensionUpdates () {
  if (extensionUpdateTimer) {
    return
  }
  function checkIfDue () {
    const entries = Object.values(getExtensionRegistry()).filter(entry => entry.source !== 'unpacked')
    if (entries.some(entry => !(entry.lastUpdateCheck > Date.now() - EXTENSION_UPDATE_INTERVAL))) {
      checkExtensionUpdates().catch(e => console.warn('extension update check failed', e))
    }
  }
  extensionUpdateTimer = setTimeout(function () {
    checkIfDue()
    extensionUpdateTimer = setInterval(checkIfDue, 60 * 60 * 1000)
  }, EXTENSION_FIRST_UPDATE_DELAY)
}

// options.id: only that extension; options.win: review an update that asks for more now, instead of leaving it pending
function checkExtensionUpdates (options = {}) {
  if (extensionUpdateCheck) {
    return extensionUpdateCheck.then(() => options.id ? checkExtensionUpdates(options) : null)
  }
  extensionUpdateCheck = (async function () {
    const registry = getExtensionRegistry()
    const servers = {} // update URL: [{id, version}]
    Object.keys(registry).filter(id => !options.id || id === options.id).forEach(function (id) {
      const manifest = registry[id].source !== 'unpacked' && readInstalledExtensionManifest(registry[id])
      if (manifest && typeof manifest.update_url === 'string' && manifest.update_url.startsWith('https://')) {
        (servers[manifest.update_url] = servers[manifest.update_url] || []).push({ id, version: manifest.version })
      }
    })
    for (const updateURL of Object.keys(servers)) {
      let answers
      try {
        const checkURL = getExtensionUpdateCheckURL(updateURL, servers[updateURL], process.versions.chrome)
        answers = parseExtensionUpdateResponse((await downloadForExtensions(checkURL, { timeout: 30 * 1000 })).toString('utf-8'))
      } catch (e) {
        servers[updateURL].forEach(({ id }) => { registry[id].updateError = e.message })
        continue
      }
      for (const { id, version } of servers[updateURL]) {
        const answer = answers[id]
        if (!registry[id]) {
          continue
        }
        registry[id].lastUpdateCheck = Date.now()
        delete registry[id].updateError
        if (!answer || answer.status !== 'ok' || !answer.codebase || compareExtensionVersions(answer.version, version) <= 0) {
          delete registry[id].pendingUpdate
          continue
        }
        try {
          await updateExtension(id, answer, { webStore: updateURL === EXTENSION_WEBSTORE_UPDATE_URL, win: options.win })
        } catch (e) {
          console.warn('failed to update extension ' + registry[id].name, e)
          if (registry[id]) {
            registry[id].updateError = e.message
          }
        }
      }
    }
    saveExtensionRegistry()
    notifyExtensionPages()
  })().finally(function () {
    extensionUpdateCheck = null
  })
  return extensionUpdateCheck
}

async function updateExtension (id, answer, options) {
  const entry = getExtensionRegistry()[id]
  const checked = readExtensionCrx(await downloadForExtensions(answer.codebase, { sha256: answer.hashSha256 }), { id, webStore: options.webStore })
  // as Chrome: an update is a newer version, never an older one (an older one may have a known flaw; security review B8).
  // Compared with the installed manifest's version, as the update check is (checkExtensionUpdates)
  const installedManifest = readInstalledExtensionManifest(entry) || {}
  const installedVersion = installedManifest.version || entry.version
  if (compareExtensionVersions(checked.manifest.version, installedVersion) <= 0) {
    throw new Error('The update server offered version ' + checked.manifest.version + ', not newer than ' + installedVersion)
  }
  const increase = getExtensionPermissionIncrease(installedManifest, checked.manifest)
  if (increase) {
    if (!options.win) {
      if (!entry.pendingUpdate || entry.pendingUpdate.version !== checked.manifest.version) {
        showPendingExtensionUpdateNotification(entry.name)
      }
      entry.pendingUpdate = { version: checked.manifest.version }
      return
    }
    if (!(await confirmExtensionInstall(checked.manifest, checked.messages, options.win, { increase }))) {
      return
    }
  }
  await installCheckedExtension(checked, { update: true })
}

// once per new version that asks for more; clicking it opens Settings at the extension list
function showPendingExtensionUpdateNotification (name) {
  if (!electron.Notification.isSupported()) {
    return
  }
  const notification = new electron.Notification({
    title: l('extensionUpdateNotificationTitle').replace('%s', name),
    body: l('extensionUpdateNotificationBody')
  })
  notification.on('click', function () {
    const win = windows.getCurrent()
    if (win) {
      sendIPCToWindow(win, 'addTab', { url: 'min://app/pages/settings/index.html#extensions-settings-container' })
    }
  })
  notification.show()
}

/*
Toolbar buttons, popups, menus, options pages and keyboard commands. js/extensions.js draws a button for each extension
with an action (manifest "action"). The library keeps each action's title, icon, badge and
popup, overall and per tab, and tells observers when any of it or the active tab changes (startChromeExtensions); each
window then gets its shown tab's buttons (extensions-toolbar), icons as data URLs. The library's own toolbar element,
crx:// icons and English-only button menu aren't used. A click opens the extension's popup, a child window of Min's
placed under the button, or sends action.onClicked.
*/

const extensionContextMenuParams = new WeakMap() // tab webContents: the params of its last 'context-menu' event
const extensionIconCache = new Map() // extension path + icon path: data URL
let extensionToolbarTimer = null

function scheduleExtensionToolbarUpdate () {
  if (extensionToolbarTimer) {
    return
  }
  extensionToolbarTimer = setTimeout(function () {
    extensionToolbarTimer = null
    windows.getAll().forEach(function (win) {
      if (!win.isDestroyed()) {
        sendIPCToWindow(win, 'extensions-toolbar', getExtensionToolbar(win))
      }
    })
  }, 50)
}

// the webContents of the normal tab a window shows, or null (none, or a private tab)
function getShownExtensionTab (win) {
  const contents = win && shownTabByWindow.get(win)
  return chromeExtensions && contents && !contents.isDestroyed() && contents.session === extensionSession ? contents : null
}

// an action icon ({path} or {imageData}, each a string or one per size) as a data URL, at most 32 px
function getExtensionActionIcon (extension, icon) {
  function pickSize (value) {
    if (!value || typeof value !== 'object') {
      return value
    }
    const sizes = Object.keys(value).map(Number).filter(n => n > 0).sort((a, b) => a - b)
    return value[sizes.find(size => size >= 32) || sizes[sizes.length - 1]]
  }
  if (!icon) {
    return ''
  }
  const imageData = pickSize(icon.imageData)
  if (typeof imageData === 'string' && imageData.startsWith('data:image/')) {
    return imageData
  }
  const iconPath = pickSize(icon.path)
  if (typeof iconPath !== 'string') {
    return ''
  }
  const key = extension.path + '|' + iconPath
  if (!extensionIconCache.has(key)) {
    // a setIcon path is relative to the page or worker that set it ("../icons/x.png" from background/), which isn't
    // known here: tried from the worker's folder, then the extension's root. As addresses, ".." can't leave the extension.
    const worker = extension.manifest.background && extension.manifest.background.service_worker
    const bases = [typeof worker === 'string' ? worker : '', ''].map(file => 'chrome-extension://' + extension.id + '/' + file)
    let url = ''
    for (const base of bases) {
      let file
      try {
        file = path.join(extension.path, decodeURIComponent(new URL(iconPath, base).pathname))
      } catch (e) {
        continue
      }
      if (!path.relative(extension.path, file).startsWith('..') && fs.existsSync(file)) {
        const image = electron.nativeImage.createFromPath(file)
        if (!image.isEmpty()) {
          url = (image.getSize().width > 32 ? image.resize({ width: 32, quality: 'best' }) : image).toDataURL()
          break
        }
      }
    }
    if (extensionIconCache.size > 200) {
      extensionIconCache.clear()
    }
    extensionIconCache.set(key, url)
  }
  return extensionIconCache.get(key)
}

function getExtensionBadgeColor (color) {
  if (Array.isArray(color)) {
    return 'rgba(' + color.slice(0, 3).join(', ') + ', ' + ((color[3] === undefined ? 255 : color[3]) / 255) + ')'
  }
  return typeof color === 'string' ? color : ''
}

function getExtensionOptionsURL (id, manifest) {
  const page = (manifest.options_ui && manifest.options_ui.page) || manifest.options_page
  return typeof page === 'string' && page ? 'chrome-extension://' + id + '/' + page.replace(/^\/+/, '') : ''
}

// {buttons: [{id, title, badgeText, badgeColor, icon}], commands: [{extensionId, name, combo}]} for a window
function getExtensionToolbar (win) {
  const contents = getShownExtensionTab(win)
  // tabList: the UI sends its tabs while extensions run (extensionTabs.js)
  if (!contents) {
    return { buttons: [], commands: [], tabList: extensionTabSyncOn }
  }
  const registry = getExtensionRegistry()
  const actions = chromeExtensions.api.browserAction.actionMap
  const extensions = extensionSession.extensions.getAllExtensions()
    .sort((a, b) => ((registry[a.id] || {}).installedAt || 0) - ((registry[b.id] || {}).installedAt || 0))
  const buttons = []
  extensions.forEach(function (extension) {
    const manifest = extension.manifest
    if (typeof manifest.action !== 'object') {
      return
    }
    const action = actions.get(extension.id) || {}
    const state = Object.assign({}, action, action.tabs && action.tabs[contents.id])
    buttons.push({
      id: extension.id,
      title: state.title || extension.name,
      badgeText: state.text || '',
      badgeColor: getExtensionBadgeColor(state.color),
      icon: getExtensionActionIcon(extension, state.icon)
    })
  })
  return { buttons, commands: getExtensionCommands(extensions), tabList: extensionTabSyncOn }
}

// the keyboard shortcuts extensions suggest in their manifest (commands.*.suggested_key); js/extensions.js skips any Min
// already uses. commands.getAll shows them too.
function getExtensionCommands (extensions) {
  const commands = []
  extensions.forEach(function (extension) {
    const manifestCommands = extension.manifest.commands || {}
    const listed = chromeExtensions.api.commands.commandMap.get(extension.id) || []
    Object.keys(manifestCommands).forEach(function (name) {
      const combo = getExtensionShortcutCombo(manifestCommands[name] && manifestCommands[name].suggested_key, process.platform)
      if (!combo) {
        return
      }
      commands.push({ extensionId: extension.id, name, combo })
      const command = listed.find(c => c.name === name)
      if (command) {
        command.shortcut = combo.split('+').map(key => ({ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', super: 'Command' })[key] || key.toUpperCase()).join('+')
      }
    })
  })
  return commands
}

ipc.handle('extensions-toolbar-get', function (event) {
  const win = windows.windowFromContents(event.sender)?.win
  return win ? getExtensionToolbar(win) : { buttons: [], commands: [] }
})

// args: {id, anchorRect: the button's {x, y, width, height} in the window}
ipc.handle('extensions-toolbar-click', function (event, args) {
  const win = windows.windowFromContents(event.sender)?.win
  const contents = getShownExtensionTab(win)
  if (!contents || !args || !extensionSession.extensions.getExtension(args.id)) {
    return
  }
  // the user used the extension on this tab: "activeTab" (extensionPermissions.js)
  grantExtensionActiveTab(extensionSession.extensions.getExtension(args.id), chromeExtensions.api.tabs.getTabDetails(contents))
  // some extensions' buttons open their side panel (sidePanel.setPanelBehavior)
  if (toggleExtensionSidePanelFromAction(args.id, win)) {
    return
  }
  try {
    chromeExtensions.api.browserAction.activateClick({ eventType: 'click', extensionId: args.id, tabId: contents.id, anchorRect: args.anchorRect })
  } catch (e) {
    console.warn('failed to open an extension\'s popup', e)
  }
})

// a button's right-click menu; args: {id, x, y}
ipc.on('extensions-toolbar-menu', function (event, args) {
  const win = windows.windowFromContents(event.sender)?.win
  const extension = getShownExtensionTab(win) && args && extensionSession.extensions.getExtension(args.id)
  if (!extension) {
    return
  }
  const manifest = extension.manifest
  const entry = getExtensionRegistry()[extension.id] || {}
  const homepage = entry.source === 'webstore' ? 'https://chromewebstore.google.com/detail/' + extension.id : manifest.homepage_url
  const optionsURL = getExtensionOptionsURL(extension.id, manifest)
  const menu = new Menu()
  menu.append(new MenuItem({
    label: extension.name,
    enabled: typeof homepage === 'string' && /^https?:\/\//.test(homepage),
    click: () => openTabForExtension({ url: homepage, active: true }).catch(() => {})
  }))
  // the extension's own items (chrome.contextMenus with the "action" context)
  const items = chromeExtensions.ctx.store.buildMenuItems(extension.id, 'action')
  if (items.length > 0) {
    menu.append(new MenuItem({ type: 'separator' }))
    items.forEach(item => menu.append(item))
  }
  menu.append(new MenuItem({ type: 'separator' }))
  if (manifest.side_panel && (manifest.permissions || []).includes('sidePanel')) {
    menu.append(new MenuItem({
      label: l('extensionMenuSidePanel'),
      click: function () {
        try {
          openExtensionSidePanel(extension, win)
        } catch (e) {
          console.warn('failed to open an extension\'s side panel', e)
        }
      }
    }))
  }
  menu.append(new MenuItem({
    label: l('extensionMenuOptions'),
    enabled: !!optionsURL,
    click: () => openTabForExtension({ url: optionsURL, active: true }).catch(() => {})
  }))
  menu.append(new MenuItem({
    label: l('extensionMenuRemove'),
    click: async function () {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [l('settingsExtensionsRemove'), l('extensionInstallCancel')],
        defaultId: 0,
        cancelId: 1,
        message: l('settingsExtensionsRemoveConfirm').replace('%s', extension.name)
      })
      if (answer.response === 0) {
        await removeInstalledExtension(extension.id)
        notifyExtensionPages()
      }
    }
  }))
  menu.append(new MenuItem({
    label: l('extensionMenuManage'),
    click: () => sendIPCToWindow(win, 'addTab', { url: 'min://app/pages/settings/index.html#extensions-settings-container' })
  }))
  menu.popup({ window: win, x: Math.round(args.x), y: Math.round(args.y) })
})

// extensions' items for a page's right-click menu (chrome.contextMenus), added by main/remoteMenu.js
function getExtensionContextMenuItems (tabId) {
  const contents = viewMap[tabId] && viewMap[tabId].webContents
  const params = contents && extensionContextMenuParams.get(contents)
  if (!chromeExtensions || !params || contents.isDestroyed()) {
    return []
  }
  return chromeExtensions.getContextMenuItems(contents, params)
}

// a keyboard shortcut (js/extensions.js runs _execute_action itself, like a click); args: {extensionId, name}
ipc.on('extensions-command', function (event, args) {
  const contents = getShownExtensionTab(windows.windowFromContents(event.sender)?.win)
  if (!contents || !args || !extensionSession.extensions.getExtension(args.extensionId)) {
    return
  }
  chromeExtensions.ctx.router.sendEvent(args.extensionId, 'commands.onCommand', String(args.name), chromeExtensions.api.tabs.getTabDetails(contents))
})

/*
Network filtering by extensions (uBlock Origin Lite and the like). Electron turns off extensions' webRequest and
declarativeNetRequest in a session that has any webRequest listener, and Min has four in persist:webcontent (filtering.js,
UASwitcher.js, download.js). So while the setting extensionsFilterNetwork is on and an enabled extension filters requests,
those hooks are removed from normal tabs' session: the extension blocks there, and Min's ad blocker (requests, cosmetic
filters, scriptlets, popups, the shield button) only works in private tabs, whose sessions keep the hooks. The hooks'
other jobs: Google sign-in's user agent and tracking-parameter removal become rules of a built-in helper extension
(ext/minNetworkHelper, loaded only then); .user.js installs and file views come from navigation events (extensionsTabCreated);
reader view fetches through main when it can't itself (internal-page-fetch in download.js); PDFs open in Chromium's viewer.
Installing such an extension turns the setting on (the review says so); without one, nothing here runs.
*/

const NETWORK_HELPER_PATH = path.join(__dirname, 'ext/minNetworkHelper')
const NETWORK_HELPER_ID = 'gnpfkmcflhpbhcdmklkmnjkhebgdgnap' // from the "key" in its manifest
const ALL_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other']
const SEC_CH_UA_HEADERS = ['sec-ch-ua', 'sec-ch-ua-arch', 'sec-ch-ua-bitness', 'sec-ch-ua-form-factors', 'sec-ch-ua-full-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-mobile', 'sec-ch-ua-model', 'sec-ch-ua-platform', 'sec-ch-ua-platform-version', 'sec-ch-ua-wow64']
const EXTENSION_FILE_VIEW_WORLD = 2001 // an isolated world: it works even on pages whose CSP sandbox turns off scripts
let extensionNetworkFilteringOn = false
let networkHelperLoading = null

// recorded with each install, so updates can tell which rulesets are new
function getExtensionNetworkDetails (manifest) {
  const resources = (manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || []
  return {
    networkFiltering: extensionUsesNetworkFiltering(manifest),
    rulesetIds: resources.map(resource => resource && resource.id).filter(id => typeof id === 'string')
  }
}

// whether an extension filters normal tabs' requests now (instead of Min's ad blocker); ses: only for that session
function isExtensionNetworkFilteringOn (ses) {
  return extensionNetworkFilteringOn && (!ses || ses === session.fromPartition('persist:webcontent'))
}

function getNetworkFilteringExtensionIds () {
  const registry = getExtensionRegistry()
  return Object.keys(registry).filter(function (id) {
    if (!registry[id].enabled) {
      return false
    }
    if (registry[id].networkFiltering === undefined) {
      registry[id].networkFiltering = extensionUsesNetworkFiltering(readInstalledExtensionManifest(registry[id]) || {})
    }
    return registry[id].networkFiltering
  })
}

// runs code in a hidden page of an extension (its manifest.json, which every extension has) with the extension's chrome.*
// APIs, for what only the extension may do, such as turning on its rulesets, even when it has no background worker
async function runInExtensionPage (id, code) {
  const view = new WebContentsView({ webPreferences: { session: extensionSession } })
  try {
    await view.webContents.loadURL('chrome-extension://' + id + '/manifest.json')
    return await view.webContents.executeJavaScript(code)
  } finally {
    view.webContents.close()
  }
}

// Electron loads an extension's static rulesets switched off; uBO Lite turns its own on, simpler extensions never do.
// Turns on those the manifest marks "enabled" (on an update, only new ones, so the extension's own choices stay).
function enableExtensionDefaultRulesets (id, manifest, previousRulesetIds) {
  const resources = (manifest.declarative_net_request && manifest.declarative_net_request.rule_resources) || []
  const ids = resources.filter(resource => resource && resource.enabled === true && typeof resource.id === 'string' && !previousRulesetIds.includes(resource.id)).map(resource => resource.id)
  if (ids.length === 0) {
    return
  }
  runInExtensionPage(id, 'chrome.declarativeNetRequest.updateEnabledRulesets(' + JSON.stringify({ enableRulesetIds: ids }) + ').then(() => true)').catch(function (e) {
    console.warn('failed to turn on the rulesets of extension ' + id, e)
  })
}

// after an install, update or reload
function finishExtensionInstall (id, manifest, previous) {
  const entry = getExtensionRegistry()[id]
  if (entry && entry.enabled && extensionSession && extensionSession.extensions.getExtension(id)) {
    enableExtensionDefaultRulesets(id, manifest, previous ? previous.rulesetIds || [] : [])
  }
  // a new extension that filters requests takes over normal tabs, as its install review said
  if (!previous && extensionUsesNetworkFiltering(manifest)) {
    settings.set('extensionsFilterNetwork', true)
  }
  applyExtensionNetworkFiltering()
}

// matches the hooks of normal tabs' session to the setting and the extensions that are on
function applyExtensionNetworkFiltering () {
  const ses = session.fromPartition('persist:webcontent')
  const on = settings.get('extensionsFilterNetwork') === true && getNetworkFilteringExtensionIds().length > 0
  if (on !== extensionNetworkFilteringOn) {
    extensionNetworkFilteringOn = on
    if (on) {
      ses.webRequest.onBeforeRequest(null)
      ses.webRequest.onBeforeSendHeaders(null)
      ses.webRequest.onHeadersReceived(null)
      ses.webRequest.onBeforeRedirect(null)
    } else {
      registerFiltering(ses)
      enableGoogleUASwitcher(ses)
      listenForDownloadHeaders(ses)
    }
    notifyExtensionPages()
  }
  // for the UI (the shield button) and Settings; also corrects a value saved by an earlier run
  if (settings.get('extensionsFilteringNetworkNow') !== on) {
    settings.set('extensionsFilteringNetworkNow', on)
  }
  if (on) {
    loadNetworkHelper().catch(e => console.warn('failed to load Min\'s network helper', e))
  } else {
    unloadNetworkHelper()
  }
}

function loadNetworkHelper () {
  if (!networkHelperLoading) {
    startChromeExtensions()
    networkHelperLoading = (extensionSession.extensions.getExtension(NETWORK_HELPER_ID)
      ? Promise.resolve()
      : extensionSession.extensions.loadExtension(NETWORK_HELPER_PATH)
    ).then(() => updateNetworkHelperRules())
    networkHelperLoading.catch(() => { networkHelperLoading = null })
  }
  return networkHelperLoading
}

function unloadNetworkHelper () {
  networkHelperLoading = null
  if (extensionSession && extensionSession.extensions.getExtension(NETWORK_HELPER_ID)) {
    extensionSession.extensions.removeExtension(NETWORK_HELPER_ID)
  }
}

// UASwitcher.js's Google sign-in user agent, and filtering.js's tracking-parameter removal, as declarativeNetRequest rules
function getNetworkHelperRules () {
  const rules = []
  if (!hasCustomUserAgent) {
    rules.push({
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'user-agent', operation: 'set', value: getFirefoxUA() }].concat(SEC_CH_UA_HEADERS.map(header => ({ header, operation: 'remove' })))
      },
      condition: { urlFilter: '|https://accounts.google.com/', resourceTypes: ALL_RESOURCE_TYPES }
    })
  }
  // as filtering.js applies them (with its defaults; the setting only exists once changed)
  if (enabledFilteringOptions.blockingLevel > 0) {
    const exceptions = enabledFilteringOptions.exceptionDomains || []
    const removeParams = function (id, params, requestDomains) {
      const condition = {
        // only pages with one of the parameters: a redirect for every page would also turn form posts into GETs
        regexFilter: '[?&](' + params.map(param => param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')=',
        resourceTypes: ['main_frame']
      }
      if (requestDomains) {
        condition.requestDomains = requestDomains
      }
      if (exceptions.length > 0) {
        condition.excludedRequestDomains = exceptions
      }
      return { id, priority: 1, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } }, condition }
    }
    rules.push(removeParams(2, globalParamsToRemove))
    Object.keys(siteParamsToRemove).forEach((host, i) => rules.push(removeParams(3 + i, siteParamsToRemove[host], [host])))
  }
  return rules
}

function updateNetworkHelperRules () {
  if (!extensionSession || !extensionSession.extensions.getExtension(NETWORK_HELPER_ID)) {
    return Promise.resolve()
  }
  return runInExtensionPage(NETWORK_HELPER_ID, 'chrome.declarativeNetRequest.getDynamicRules().then(old => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(rule => rule.id), addRules: ' + JSON.stringify(getNetworkHelperRules()) + ' })).then(() => true)')
}

// whether a tab shows a file (an image, text, a PDF) rather than a page, for saving it (download.js does this from the response)
function reportExtensionTabFileView (contents) {
  contents.executeJavaScriptInIsolatedWorld(EXTENSION_FILE_VIEW_WORLD, [{ code: 'document.contentType' }]).then(function (type) {
    const win = !contents.isDestroyed() && (getWindowFromViewContents(contents) || windows.getCurrent())
    if (win && typeof type === 'string') {
      sendIPCToWindow(win, 'set-file-view', { url: contents.getURL(), tabId: getTabIDFromWebContents(contents) || null, isFileView: !type.includes('text/html') })
    }
  }, function () {})
}
