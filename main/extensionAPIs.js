/* Extension APIs that Electron and electron-chrome-extensions lack or leave as stubs (AGENTS.md section 10.9), chosen by
   surveying 53 popular extensions: screenshots and a page's language (tabs.captureVisibleTab, tabs.detectLanguage),
   tabs.discard (Min's hibernation), downloads, privacy settings, sign-in windows (identity.launchWebAuthFlow), side panels,
   clearing browsing data, search and speech (tts). js/preload/extensionSupport.js adds them to chrome.* and calls these
   handlers through the library's router ("crx-msg"), which only takes calls from installed extensions and tells each handler
   which extension called; the handlers check that extension's permissions. Events go back with router.sendEvent. */

const EXTENSION_API_WORLD = 2002 // isolated world for reading a page's language
const EXTENSION_SIDE_PANEL_WIDTH = 360
const EXTENSION_SIDE_PANEL_HEADER = 36 // the UI's title bar above the panel (js/extensions.js)

function extensionHasPermission (extension, permission) {
  return (extension.manifest.permissions || []).includes(permission)
}

function extensionHasAllSites (extension) {
  const manifest = extension.manifest
  return [].concat(manifest.host_permissions || [], manifest.permissions || []).some(p => EXTENSION_ALL_SITES.includes(p))
}

function requireExtensionPermission (extension, permission) {
  if (!extensionHasPermission(extension, permission)) {
    throw new Error('This extension doesn\'t have the "' + permission + '" permission.')
  }
}

// sends an event to one extension, or to every loaded extension with a permission
function sendExtensionAPIEvent (target, name, ...args) {
  if (!chromeExtensions) {
    return
  }
  const ids = typeof target === 'string'
    ? [target]
    : extensionSession.extensions.getAllExtensions().filter(e => extensionHasPermission(e, target.permission)).map(e => e.id)
  ids.forEach(id => chromeExtensions.ctx.router.sendEvent(id, name, ...args))
}

// a tab by the library's id (its webContents id), or the current window's shown tab; normal tabs only
function getExtensionAPITab (tabId) {
  const contents = typeof tabId === 'number' ? chromeExtensions.ctx.store.getTabById(tabId) : getShownExtensionTab(windows.getCurrent())
  if (!contents || contents.isDestroyed() || contents.session !== extensionSession) {
    throw new Error(typeof tabId === 'number' ? 'No tab with id: ' + tabId + '.' : 'There is no active tab.')
  }
  return contents
}

function getExtensionAPIWindow (windowId) {
  if (typeof windowId !== 'number' || windowId === -2) {
    return windows.getCurrent()
  }
  const win = chromeExtensions.ctx.store.getWindowById(windowId)
  if (!win) {
    throw new Error('No window with id: ' + windowId + '.')
  }
  return win
}

function registerExtensionAPIs () {
  const handle = chromeExtensions.ctx.router.apiHandler()

  /* Tabs */

  handle('tabs.captureVisibleTab', async function ({ extension }, windowId, options) {
    if (windowId && typeof windowId === 'object') {
      options = windowId
      windowId = undefined
    }
    options = options || {}
    if (!extensionHasPermission(extension, 'activeTab') && !extensionHasAllSites(extension)) {
      throw new Error('Either the \'<all_urls>\' or \'activeTab\' permission is required.')
    }
    const contents = getShownExtensionTab(getExtensionAPIWindow(windowId))
    if (!contents) {
      throw new Error('Cannot access contents of the page.')
    }
    // "activeTab" only counts once the user has used the extension on this tab, and until the tab goes to another site
    // (extensionPermissions.js). Until 2026-11-12 having it in the manifest was enough: a picture of whatever was
    // shown, at any time.
    if (extensionPermissionChecksOn && !extensionHasAllSites(extension) && !extensionCanAccessTabSite(extension, chromeExtensions.api.tabs.getTabDetails(contents))) {
      throw new Error('The \'activeTab\' permission is not in effect because this extension has not been invoked on this tab.')
    }
    const url = contents.getURL()
    if (!/^(https?|file|data):/i.test(url) && !url.startsWith('chrome-extension://' + extension.id + '/')) {
      throw new Error('Cannot access contents of url "' + url + '".')
    }
    const image = await contents.capturePage()
    if (options.format === 'png') {
      return image.toDataURL()
    }
    const quality = typeof options.quality === 'number' ? Math.max(0, Math.min(100, Math.round(options.quality))) : 92
    return 'data:image/jpeg;base64,' + image.toJPEG(quality).toString('base64')
  })

  // from the page's lang attribute (Chrome guesses from the text); 'und' when it doesn't say
  handle('tabs.detectLanguage', async function ({ extension }, tabId) {
    const contents = getExtensionAPITab(tabId)
    const lang = await contents.executeJavaScriptInIsolatedWorld(EXTENSION_API_WORLD, [{ code: 'document.documentElement.lang' }]).catch(() => '')
    const parts = String(lang || '').trim().replace(/_/g, '-').split('-')
    const language = parts[0].toLowerCase()
    if (!/^[a-z]{2,3}$/.test(language)) {
      return 'und'
    }
    if (language === 'zh') {
      return /^(tw|hk|mo|hant)$/i.test(parts[1] || '') ? 'zh-TW' : 'zh-CN'
    }
    return language
  })

  // Min's hibernation: the tab keeps its place and reloads when selected. Like hibernation, it never closes a tab that's
  // shown, playing sound or video, or in a call. Without a tab id, Chrome picks one; Min doesn't.
  handle('tabs.discard', function ({ extension }, tabId) {
    if (typeof tabId !== 'number') {
      return undefined
    }
    // already discarded (extensionTabs.js)
    const standIn = chromeExtensions.ctx.store.getTabById(tabId)
    if (standIn && standIn.isExtensionStandIn) {
      return chromeExtensions.api.tabs.getTabDetails(standIn)
    }
    const contents = getExtensionAPITab(tabId)
    const minTabId = getTabIDFromWebContents(contents)
    const shown = windows.getAll().some(win => windows.getState(win).selectedView === minTabId)
    if (!minTabId || shown || isTabActiveWithMedia(contents) || activeMediaByContents.has(contents)) {
      throw new Error('Cannot discard tab with id: ' + tabId + '.')
    }
    const details = Object.assign({}, chromeExtensions.api.tabs.getTabDetails(contents), { discarded: true })
    windows.getAll().forEach(win => sendIPCToWindow(win, 'hibernateTab', minTabId))
    return details
  })

  registerExtensionDownloadAPIs(handle)
  registerExtensionPrivacyAPIs(handle)
  registerExtensionIdentityAPIs(handle)
  registerExtensionSidePanelAPIs(handle)
  registerExtensionSpeechAPIs(handle)

  /* Clearing browsing data, in normal tabs' session. Electron can't clear a time range, only everything. */

  const BROWSING_DATA_TYPES = {
    appcache: 'cacheStorage',
    cacheStorage: 'cacheStorage',
    cookies: 'cookies',
    fileSystems: 'fileSystems',
    indexedDB: 'indexedDB',
    localStorage: 'localStorage',
    serviceWorkers: 'serviceWorkers',
    webSQL: 'webSQL'
  }
  handle('browsingData.remove', async function ({ extension }, options, dataToRemove) {
    requireExtensionPermission(extension, 'browsingData')
    options = options || {}
    dataToRemove = dataToRemove || {}
    if (options.since > 0) {
      throw new Error('Min can only remove browsing data from all time (since: 0).')
    }
    const dataTypes = Array.from(new Set(Object.keys(dataToRemove).filter(key => dataToRemove[key] && BROWSING_DATA_TYPES[key]).map(key => BROWSING_DATA_TYPES[key])))
    if (dataTypes.length > 0) {
      // installed extensions keep their own data, as when Min clears browsing data
      const extensionOrigins = Object.keys(getExtensionRegistry()).map(id => 'chrome-extension://' + id)
      const origins = Array.isArray(options.origins) ? options.origins.filter(origin => !String(origin).startsWith('chrome-extension://')) : null
      if (origins && origins.length > 0) {
        await extensionSession.clearData({ dataTypes, origins })
      } else if (!origins) {
        await extensionSession.clearData({ dataTypes, excludeOrigins: extensionOrigins.concat(options.excludeOrigins || []) })
      }
    }
    if (dataToRemove.cache) {
      await extensionSession.clearCache()
    }
    if (dataToRemove.downloads) {
      eraseExtensionDownloads({})
    }
  })
  handle('browsingData.settings', function ({ extension }) {
    requireExtensionPermission(extension, 'browsingData')
    const types = Object.keys(BROWSING_DATA_TYPES).concat(['cache', 'downloads'])
    return {
      options: { since: 0 },
      dataToRemove: Object.fromEntries(types.map(type => [type, false])),
      dataRemovalPermitted: Object.fromEntries(types.map(type => [type, true]))
    }
  })

  /* Searching with Min's search engine */

  handle('search.query', function ({ extension }, details) {
    requireExtensionPermission(extension, 'search')
    details = details || {}
    if (typeof details.text !== 'string' || !details.text.trim()) {
      throw new Error('The search text is empty.')
    }
    const contents = typeof details.tabId === 'number' ? getExtensionAPITab(details.tabId) : null
    const win = (contents && getExtensionTabWindow(contents)) || windows.getCurrent()
    sendIPCToWindow(win, 'extensions-search', {
      text: details.text,
      newTab: details.disposition === 'NEW_TAB' || details.disposition === 'NEW_WINDOW',
      tabId: contents ? getTabIDFromWebContents(contents) : null
    })
  })
}

/* Downloads (the library's are stubs). Every download in normal tabs' session is listed, as in Chrome; an extension's own
   go to the Downloads folder without asking (unless saveAs), under the name it gives. */

const extensionDownloads = new Map() // id: {id, item, byExtensionId, byExtensionName, endTime, error, last}
const pendingExtensionDownloads = [] // {url, extension, filename, saveAs, conflictAction, resolve, reject, timer}
let nextExtensionDownloadId = 1

function getChromeDownloadState (item) {
  const state = item.getState()
  return state === 'completed' ? 'complete' : (state === 'progressing' ? 'in_progress' : 'interrupted')
}

function getChromeDownloadItem (entry) {
  const item = entry.item
  const state = getChromeDownloadState(item)
  const filename = item.getSavePath()
  return {
    id: entry.id,
    url: item.getURLChain()[0] || item.getURL(),
    finalUrl: item.getURL(),
    referrer: '',
    filename,
    incognito: false,
    danger: 'safe',
    mime: item.getMimeType(),
    startTime: new Date(item.getStartTime() * 1000).toISOString(),
    endTime: entry.endTime,
    state,
    paused: item.isPaused(),
    canResume: item.canResume(),
    error: entry.error,
    bytesReceived: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes() || -1,
    fileSize: item.getTotalBytes() || -1,
    exists: state === 'complete' ? !entry.removed && !!filename && fs.existsSync(filename) : state === 'in_progress',
    byExtensionId: entry.byExtensionId,
    byExtensionName: entry.byExtensionName
  }
}

// a name under the Downloads folder from an extension's relative path ("folder/name.png"), or an error
function getExtensionDownloadPath (filename, conflictAction) {
  const parts = String(filename).replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..') || path.isAbsolute(filename) || /^[a-zA-Z]:/.test(filename)) {
    throw new Error('Invalid filename')
  }
  // characters Windows doesn't allow (control characters too), and trailing dots and spaces
  const safeParts = parts.map(part => Array.from(part, c => c.charCodeAt(0) < 32 || '<>:"|?*'.includes(c) ? '_' : c).join('').replace(/[. ]+$/, '') || '_')
  let file = path.join(app.getPath('downloads'), ...safeParts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (conflictAction !== 'overwrite') {
    const extension = path.extname(file)
    const base = file.slice(0, file.length - extension.length)
    for (let i = 1; fs.existsSync(file) && i < 1000; i++) {
      file = base + ' (' + i + ')' + extension
    }
  }
  return file
}

function trackExtensionSessionDownload (event, item) {
  const index = pendingExtensionDownloads.findIndex(pending => pending.url === item.getURL() || pending.url === item.getURLChain()[0])
  const pending = index >= 0 ? pendingExtensionDownloads.splice(index, 1)[0] : null
  const entry = { id: nextExtensionDownloadId++, item, byExtensionId: pending ? pending.extension.id : undefined, byExtensionName: pending ? pending.extension.name : undefined }
  if (pending) {
    clearTimeout(pending.timer)
    try {
      if (pending.saveAs) {
        item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(pending.filename || item.getFilename())) })
      } else {
        item.setSavePath(getExtensionDownloadPath(pending.filename || item.getFilename(), pending.conflictAction))
      }
      pending.resolve(entry.id)
    } catch (e) {
      item.cancel()
      pending.reject(e)
      return
    }
  }
  extensionDownloads.set(entry.id, entry)
  const created = getChromeDownloadItem(entry)
  entry.last = { state: created.state, paused: created.paused, filename: created.filename, totalBytes: created.totalBytes }
  sendExtensionAPIEvent({ permission: 'downloads' }, 'downloads.onCreated', created)

  // Chrome reports changes of state, pause, name and size (not progress)
  const reportChanges = function () {
    if (!extensionDownloads.has(entry.id)) {
      return
    }
    const now = getChromeDownloadItem(entry)
    const delta = { id: entry.id }
    for (const key of ['state', 'paused', 'filename', 'totalBytes', 'error', 'endTime', 'canResume', 'exists']) {
      const previous = entry.last[key]
      if (previous !== now[key] && (key in entry.last || now[key] !== undefined)) {
        delta[key] = { previous, current: now[key] }
        entry.last[key] = now[key]
      }
    }
    if (Object.keys(delta).length > 1) {
      sendExtensionAPIEvent({ permission: 'downloads' }, 'downloads.onChanged', delta)
    }
  }
  item.on('updated', reportChanges)
  item.once('done', function (e, state) {
    entry.endTime = new Date().toISOString()
    if (state !== 'completed') {
      entry.error = state === 'cancelled' ? 'USER_CANCELED' : 'NETWORK_FAILED'
    }
    reportChanges()
  })
}

function getExtensionDownload (id) {
  const entry = extensionDownloads.get(id)
  if (!entry) {
    throw new Error('Invalid download id ' + id)
  }
  return entry
}

function searchExtensionDownloads (query) {
  query = query || {}
  const terms = typeof query.query === 'string' ? query.query.split(/\s+/).filter(Boolean) : (Array.isArray(query.query) ? query.query : [])
  let results = Array.from(extensionDownloads.values()).map(getChromeDownloadItem).filter(function (item) {
    for (const key of ['id', 'url', 'finalUrl', 'filename', 'state', 'paused', 'mime', 'danger', 'exists', 'error', 'byExtensionId', 'totalBytes']) {
      if (query[key] !== undefined && query[key] !== item[key]) {
        return false
      }
    }
    try {
      if (query.urlRegex && !new RegExp(query.urlRegex).test(item.url)) {
        return false
      }
      if (query.filenameRegex && !new RegExp(query.filenameRegex).test(item.filename)) {
        return false
      }
    } catch (e) {
      return false
    }
    if (query.startedAfter && !(item.startTime > query.startedAfter)) {
      return false
    }
    if (query.startedBefore && !(item.startTime < query.startedBefore)) {
      return false
    }
    return terms.every(term => term.startsWith('-')
      ? !(item.url + ' ' + item.filename).toLowerCase().includes(term.slice(1).toLowerCase())
      : (item.url + ' ' + item.filename).toLowerCase().includes(term.toLowerCase()))
  })
  const order = Array.isArray(query.orderBy) ? query.orderBy[0] : query.orderBy
  if (typeof order === 'string' && order.replace('-', '') in (results[0] || {})) {
    const key = order.replace('-', '')
    results.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (order.startsWith('-') ? -1 : 1))
  }
  const limit = typeof query.limit === 'number' ? query.limit : 1000
  if (limit > 0) {
    results = results.slice(0, limit)
  }
  return results
}

function eraseExtensionDownloads (query) {
  const ids = searchExtensionDownloads(Object.assign({}, query, { limit: 0 })).map(item => item.id)
  ids.forEach(function (id) {
    extensionDownloads.delete(id)
    sendExtensionAPIEvent({ permission: 'downloads' }, 'downloads.onErased', id)
  })
  return ids
}

function registerExtensionDownloadAPIs (handle) {
  extensionSession.on('will-download', trackExtensionSessionDownload)

  handle('downloads.download', function ({ extension, sender }, options) {
    requireExtensionPermission(extension, 'downloads')
    options = options || {}
    const url = String(options.url || '')
    if (!/^(https?|data|blob):/i.test(url) && !url.startsWith('chrome-extension://' + extension.id + '/')) {
      throw new Error('Invalid URL')
    }
    if (options.filename !== undefined) {
      // checked now, as Chrome does; the folder is made when the download starts
      const parts = String(options.filename).replace(/\\/g, '/').split('/')
      if (!options.filename || parts.includes('..') || path.isAbsolute(options.filename) || /^[a-zA-Z]:/.test(options.filename)) {
        throw new Error('Invalid filename')
      }
    }
    const headers = {}
    ;(options.headers || []).forEach(header => {
      if (header && typeof header.name === 'string' && typeof header.value === 'string') {
        headers[header.name] = header.value
      }
    })
    return new Promise(function (resolve, reject) {
      const pending = { url, extension, filename: options.filename, saveAs: options.saveAs === true, conflictAction: options.conflictAction, resolve, reject }
      pending.timer = setTimeout(function () {
        const index = pendingExtensionDownloads.indexOf(pending)
        if (index >= 0) {
          pendingExtensionDownloads.splice(index, 1)
          reject(new Error('Download failed'))
        }
      }, 60 * 1000)
      pendingExtensionDownloads.push(pending)
      // a page's blob: address only resolves in that page; a worker's downloads start from the session
      if (sender && typeof sender.downloadURL === 'function' && !sender.isDestroyed()) {
        sender.downloadURL(url, { headers })
      } else {
        extensionSession.downloadURL(url, { headers })
      }
    })
  })
  handle('downloads.search', function ({ extension }, query) {
    requireExtensionPermission(extension, 'downloads')
    return searchExtensionDownloads(query)
  })
  handle('downloads.erase', function ({ extension }, query) {
    requireExtensionPermission(extension, 'downloads')
    return eraseExtensionDownloads(query)
  })
  for (const action of ['pause', 'resume', 'cancel']) {
    handle('downloads.' + action, function ({ extension }, id) {
      requireExtensionPermission(extension, 'downloads')
      const item = getExtensionDownload(id).item
      if (getChromeDownloadState(item) === 'in_progress' || (action === 'resume' && item.canResume())) {
        item[action]()
      }
    })
  }
  handle('downloads.removeFile', async function ({ extension }, id) {
    requireExtensionPermission(extension, 'downloads')
    const entry = getExtensionDownload(id)
    if (getChromeDownloadState(entry.item) !== 'complete') {
      throw new Error('Download must be complete')
    }
    await fs.promises.unlink(entry.item.getSavePath()).catch(() => {})
    entry.removed = true
    sendExtensionAPIEvent({ permission: 'downloads' }, 'downloads.onChanged', { id, exists: { previous: true, current: false } })
  })
  // "open" shows the file in its folder instead of running it
  for (const action of ['open', 'show']) {
    handle('downloads.' + action, function ({ extension }, id) {
      requireExtensionPermission(extension, 'downloads')
      shell.showItemInFolder(getExtensionDownload(id).item.getSavePath())
    })
  }
  handle('downloads.showDefaultFolder', function ({ extension }) {
    requireExtensionPermission(extension, 'downloads')
    shell.openPath(app.getPath('downloads'))
  })
  handle('downloads.getFileIcon', async function ({ extension }, id, options) {
    requireExtensionPermission(extension, 'downloads')
    const size = options && options.size === 16 ? 'small' : (options && options.size === 32 ? 'normal' : 'normal')
    return (await app.getFileIcon(getExtensionDownload(id).item.getSavePath(), { size })).toDataURL()
  })
  for (const name of ['acceptDanger', 'setUiOptions', 'setShelfEnabled']) {
    handle('downloads.' + name, function () {})
  }
}

/* Privacy settings: read and set like Chrome's (the last extension to set one controls it). Each extension's choices are
   kept in extensions.json (`privacy`), as Chrome keeps them, and apply while it's loaded. Min follows one so far:
   services.passwordSavingEnabled off (password managers set it) turns off Min's own offer to save passwords. */

const EXTENSION_PRIVACY_DEFAULTS = {
  'network.networkPredictionEnabled': true,
  'network.webRTCIPHandlingPolicy': 'default',
  'services.alternateErrorPagesEnabled': false,
  'services.autofillAddressEnabled': false,
  'services.autofillCreditCardEnabled': false,
  'services.autofillEnabled': false,
  'services.passwordSavingEnabled': true,
  'services.safeBrowsingEnabled': false,
  'services.safeBrowsingExtendedReportingEnabled': false,
  'services.searchSuggestEnabled': true,
  'services.spellingServiceEnabled': false,
  'services.translationServiceEnabled': false,
  'websites.adMeasurementEnabled': false,
  'websites.doNotTrackEnabled': false,
  'websites.fledgeEnabled': false,
  'websites.hyperlinkAuditingEnabled': true,
  'websites.protectedContentEnabled': true,
  'websites.referrersEnabled': true,
  'websites.relatedWebsiteSetsEnabled': false,
  'websites.thirdPartyCookiesAllowed': true,
  'websites.topicsEnabled': false
}
const extensionPrivacySettings = new Map() // name: {extensionId, value}

// what Min itself does with them: the UI reads extensionsPasswordSavingOff (js/passwordManager/passwordCapture.js)
function applyExtensionPrivacySettingsToMin () {
  const passwords = extensionPrivacySettings.get('services.passwordSavingEnabled')
  const off = !!passwords && passwords.value === false
  if (settings.get('extensionsPasswordSavingOff') !== off) {
    settings.set('extensionsPasswordSavingOff', off)
  }
}

function saveExtensionPrivacySetting (extensionId, name, value) {
  const entry = getExtensionRegistry()[extensionId]
  if (!entry) {
    return
  }
  entry.privacy = Object.assign({}, entry.privacy)
  if (value === undefined) {
    delete entry.privacy[name]
  } else {
    entry.privacy[name] = value
  }
  if (Object.keys(entry.privacy).length === 0) {
    delete entry.privacy
  }
  saveExtensionRegistry()
}

function getExtensionPrivacySetting (extension, name) {
  if (!(name in EXTENSION_PRIVACY_DEFAULTS)) {
    throw new Error('Unknown privacy setting: ' + name)
  }
  const set = extensionPrivacySettings.get(name)
  return {
    value: set ? set.value : EXTENSION_PRIVACY_DEFAULTS[name],
    levelOfControl: set ? (set.extensionId === extension.id ? 'controlled_by_this_extension' : 'controlled_by_other_extensions') : 'controllable_by_this_extension'
  }
}

function registerExtensionPrivacyAPIs (handle) {
  function notify (name) {
    extensionSession.extensions.getAllExtensions().filter(e => extensionHasPermission(e, 'privacy')).forEach(function (extension) {
      chromeExtensions.ctx.router.sendEvent(extension.id, 'privacy.onChange.' + name, getExtensionPrivacySetting(extension, name))
    })
  }
  handle('privacy.get', function ({ extension }, name) {
    requireExtensionPermission(extension, 'privacy')
    return getExtensionPrivacySetting(extension, name)
  })
  handle('privacy.set', function ({ extension }, name, details) {
    requireExtensionPermission(extension, 'privacy')
    getExtensionPrivacySetting(extension, name)
    const value = details && details.value
    if (typeof value !== typeof EXTENSION_PRIVACY_DEFAULTS[name]) {
      throw new Error('The value for ' + name + ' must be a ' + typeof EXTENSION_PRIVACY_DEFAULTS[name] + '.')
    }
    extensionPrivacySettings.set(name, { extensionId: extension.id, value })
    saveExtensionPrivacySetting(extension.id, name, value)
    notify(name)
    applyExtensionPrivacySettingsToMin()
  })
  handle('privacy.clear', function ({ extension }, name) {
    requireExtensionPermission(extension, 'privacy')
    getExtensionPrivacySetting(extension, name)
    const set = extensionPrivacySettings.get(name)
    if (set && set.extensionId === extension.id) {
      extensionPrivacySettings.delete(name)
      notify(name)
    }
    saveExtensionPrivacySetting(extension.id, name, undefined)
    applyExtensionPrivacySettingsToMin()
  })
  // an extension's saved choices apply again when it loads (at startup in install order, so the newest wins, as in Chrome)
  extensionSession.extensions.on('extension-loaded', function (event, extension) {
    const entry = getExtensionRegistry()[extension.id]
    const saved = (entry && entry.privacy) || {}
    for (const name of Object.keys(saved)) {
      if (name in EXTENSION_PRIVACY_DEFAULTS && typeof saved[name] === typeof EXTENSION_PRIVACY_DEFAULTS[name]) {
        extensionPrivacySettings.set(name, { extensionId: extension.id, value: saved[name] })
      }
    }
    applyExtensionPrivacySettingsToMin()
  })
  extensionSession.extensions.on('extension-unloaded', function (event, extension) {
    for (const [name, set] of extensionPrivacySettings) {
      if (set.extensionId === extension.id) {
        extensionPrivacySettings.delete(name)
      }
    }
    applyExtensionPrivacySettingsToMin()
  })
}

/* Sign-in windows (identity.launchWebAuthFlow). The sign-in page opens in a window of normal tabs' session (its cookies,
   Min's Google sign-in fix), and the flow ends when it goes to https://<extension id>.chromiumapp.org/. getAuthToken
   needs a Google account signed in to Chrome itself, so it fails as Chrome does when nobody is signed in. */

function registerExtensionIdentityAPIs (handle) {
  handle('identity.launchWebAuthFlow', function ({ extension }, details) {
    requireExtensionPermission(extension, 'identity')
    details = details || {}
    if (typeof details.url !== 'string' || !/^https?:\/\//i.test(details.url)) {
      throw new Error('Authorization page could not be loaded.')
    }
    const redirectBase = 'https://' + extension.id + '.chromiumapp.org/'
    const interactive = details.interactive === true
    const parent = windows.getCurrent()
    return new Promise(function (resolve, reject) {
      const win = new BrowserWindow({
        width: 500,
        height: 680,
        show: false,
        parent: interactive && parent && !parent.isDestroyed() ? parent : undefined,
        title: extension.name,
        autoHideMenuBar: true,
        webPreferences: { session: extensionSession, sandbox: true, contextIsolation: true, nodeIntegration: false }
      })
      let finished = false
      const finish = function (error, url) {
        if (finished) {
          return
        }
        finished = true
        clearTimeout(timer)
        if (!win.isDestroyed()) {
          win.destroy()
        }
        if (error) {
          reject(new Error(error))
        } else {
          resolve(url)
        }
      }
      const timer = setTimeout(() => finish(interactive ? 'The user did not approve access.' : 'User interaction required.'), interactive ? 15 * 60 * 1000 : (details.timeoutMsForNonInteractive || 60 * 1000))
      const check = function (navigation) {
        if (navigation && typeof navigation.url === 'string' && navigation.url.startsWith(redirectBase)) {
          if (typeof navigation.preventDefault === 'function') {
            navigation.preventDefault()
          }
          finish(null, navigation.url)
        }
      }
      win.webContents.on('will-redirect', check)
      win.webContents.on('will-navigate', check)
      win.webContents.on('did-start-navigation', check)
      // links that open a window stay in this one
      win.webContents.setWindowOpenHandler(function (open) {
        if (/^https?:/i.test(open.url)) {
          win.webContents.loadURL(open.url)
        }
        return { action: 'deny' }
      })
      win.on('closed', () => finish('The user did not approve access.'))
      win.webContents.on('did-finish-load', function () {
        if (interactive) {
          win.show()
        } else if (details.abortOnLoadForNonInteractive !== false) {
          finish('User interaction required.')
        }
      })
      win.webContents.on('did-fail-load', function (e, code, description, url, isMainFrame) {
        if (isMainFrame && code !== -3) {
          finish('Authorization page could not be loaded.')
        }
      })
      win.loadURL(details.url).catch(() => {})
    })
  })
  handle('identity.getAuthToken', function ({ extension }) {
    requireExtensionPermission(extension, 'identity')
    throw new Error('The user is not signed in.')
  })
  for (const name of ['removeCachedAuthToken', 'clearAllCachedAuthTokens']) {
    handle('identity.' + name, function () {})
  }
  handle('identity.getProfileUserInfo', () => ({ email: '', id: '' }))
  handle('identity.getAccounts', () => [])
}

/* Side panels: an extension's panel page in a view at the window's right edge, under a title bar the UI draws
   (js/extensions.js), with the tab narrowed beside it. One per window. viewManager.js reports the tab view's bounds
   (extensionsViewBoundsChanged) and hidden views (extensionsViewHidden); extensionsTabShown puts the panel back on top. */

const extensionSidePanels = new Map() // window: {extensionId, view, path}
const extensionSidePanelSettings = new Map() // extension id: {path, enabled, openPanelOnActionClick, tabs: {tab id: {path, enabled}}}

function getExtensionSidePanelSettings (extension) {
  if (!extensionSidePanelSettings.has(extension.id)) {
    const manifestPath = extension.manifest.side_panel && extension.manifest.side_panel.default_path
    extensionSidePanelSettings.set(extension.id, { path: manifestPath || '', enabled: true, openPanelOnActionClick: false, tabs: {} })
  }
  return extensionSidePanelSettings.get(extension.id)
}

function getExtensionSidePanelPath (extension, tabId) {
  const panelSettings = getExtensionSidePanelSettings(extension)
  const tab = tabId !== undefined ? panelSettings.tabs[tabId] : undefined
  const enabled = tab && tab.enabled !== undefined ? tab.enabled : panelSettings.enabled
  const panelPath = (tab && tab.path) || panelSettings.path
  return enabled && panelPath ? panelPath : null
}

function placeExtensionSidePanel (win, bounds) {
  const panel = extensionSidePanels.get(win)
  if (!panel || win.isDestroyed()) {
    return
  }
  if (!bounds) {
    const selected = viewMap[windows.getState(win).selectedView]
    bounds = selected ? selected.getBounds() : null
  }
  const content = win.getContentBounds()
  const x = bounds ? bounds.x + bounds.width : 0
  // not in full screen, where the tab covers the window
  const fits = !!bounds && x + EXTENSION_SIDE_PANEL_WIDTH <= content.width + 1 && bounds.height > EXTENSION_SIDE_PANEL_HEADER
  panel.view.setVisible(fits)
  if (fits) {
    panel.view.setBounds({ x, y: bounds.y + EXTENSION_SIDE_PANEL_HEADER, width: EXTENSION_SIDE_PANEL_WIDTH, height: bounds.height - EXTENSION_SIDE_PANEL_HEADER })
  }
}

function openExtensionSidePanel (extension, win) {
  if (!win || win.isDestroyed()) {
    throw new Error('There is no window to open the side panel in.')
  }
  const contents = getShownExtensionTab(win)
  const panelPath = getExtensionSidePanelPath(extension, contents ? contents.id : undefined)
  if (!panelPath) {
    throw new Error('No active side panel for this tab.')
  }
  const current = extensionSidePanels.get(win)
  if (current && current.extensionId === extension.id && current.path === panelPath) {
    return
  }
  closeExtensionSidePanel(win)
  const view = new WebContentsView({ webPreferences: { session: extensionSession, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  view.setBackgroundColor('#ffffff')
  extensionSidePanels.set(win, { extensionId: extension.id, view, path: panelPath })
  view.webContents.setWindowOpenHandler(function (details) {
    openTabForExtension({ url: details.url, active: true }).catch(() => {})
    return { action: 'deny' }
  })
  view.webContents.loadURL('chrome-extension://' + extension.id + '/' + panelPath.replace(/^\//, ''))
  win.getContentView().addChildView(view)
  view.setVisible(false)
  if (!win.minSidePanelCleanup) {
    win.minSidePanelCleanup = true
    win.once('closed', () => closeExtensionSidePanel(win))
  }
  // the UI makes room (and reports the new bounds, which places the panel)
  sendIPCToWindow(win, 'extensions-side-panel', { extensionId: extension.id, title: extension.name, width: EXTENSION_SIDE_PANEL_WIDTH, header: EXTENSION_SIDE_PANEL_HEADER })
  sendExtensionAPIEvent(extension.id, 'sidePanel.onOpened', { path: panelPath, windowId: win.id })
}

function closeExtensionSidePanel (win) {
  const panel = extensionSidePanels.get(win)
  if (!panel) {
    return
  }
  extensionSidePanels.delete(win)
  if (!win.isDestroyed()) {
    win.getContentView().removeChildView(panel.view)
    sendIPCToWindow(win, 'extensions-side-panel', { extensionId: null })
  }
  if (!panel.view.webContents.isDestroyed()) {
    panel.view.webContents.close()
  }
  sendExtensionAPIEvent(panel.extensionId, 'sidePanel.onClosed', { path: panel.path, windowId: win.isDestroyed() ? -1 : win.id })
}

// the toolbar button opens (or closes) the panel instead of the popup, when the extension asked for that
function toggleExtensionSidePanelFromAction (id, win) {
  const extension = chromeExtensions && extensionSession.extensions.getExtension(id)
  if (!extension || !extensionHasPermission(extension, 'sidePanel') || !getExtensionSidePanelSettings(extension).openPanelOnActionClick) {
    return false
  }
  const current = extensionSidePanels.get(win)
  if (current && current.extensionId === id) {
    closeExtensionSidePanel(win)
  } else {
    try {
      openExtensionSidePanel(extension, win)
    } catch (e) {
      return false
    }
  }
  return true
}

function getExtensionSidePanelContents () {
  return Array.from(extensionSidePanels.values()).map(panel => panel.view.webContents)
}

function extensionsViewBoundsChanged (id, bounds) {
  if (extensionSidePanels.size === 0) {
    return
  }
  windows.getAll().forEach(function (win) {
    if (windows.getState(win).selectedView === id) {
      placeExtensionSidePanel(win, bounds)
    }
  })
}

function extensionsViewHidden (win) {
  const panel = extensionSidePanels.get(win)
  if (panel) {
    win.getContentView().removeChildView(panel.view)
  }
}

function extensionsSidePanelShown (win) {
  const panel = extensionSidePanels.get(win)
  if (panel) {
    win.getContentView().addChildView(panel.view)
    placeExtensionSidePanel(win)
  }
}

function registerExtensionSidePanelAPIs (handle) {
  handle('sidePanel.setOptions', function ({ extension }, options) {
    requireExtensionPermission(extension, 'sidePanel')
    options = options || {}
    const panelSettings = getExtensionSidePanelSettings(extension)
    const target = typeof options.tabId === 'number' ? (panelSettings.tabs[options.tabId] = panelSettings.tabs[options.tabId] || {}) : panelSettings
    if (typeof options.path === 'string') {
      target.path = options.path
    }
    if (typeof options.enabled === 'boolean') {
      target.enabled = options.enabled
    }
    // a panel that's now off (or another page) for the shown tab
    for (const [win, panel] of extensionSidePanels) {
      if (panel.extensionId === extension.id) {
        const contents = getShownExtensionTab(win)
        const now = getExtensionSidePanelPath(extension, contents ? contents.id : undefined)
        if (!now) {
          closeExtensionSidePanel(win)
        } else if (now !== panel.path) {
          openExtensionSidePanel(extension, win)
        }
      }
    }
  })
  handle('sidePanel.getOptions', function ({ extension }, options) {
    requireExtensionPermission(extension, 'sidePanel')
    const panelSettings = getExtensionSidePanelSettings(extension)
    const tabId = options && typeof options.tabId === 'number' ? options.tabId : undefined
    const tab = tabId !== undefined ? panelSettings.tabs[tabId] || {} : {}
    return Object.assign({ enabled: tab.enabled !== undefined ? tab.enabled : panelSettings.enabled, path: tab.path || panelSettings.path || undefined }, tabId !== undefined ? { tabId } : {})
  })
  handle('sidePanel.setPanelBehavior', function ({ extension }, behavior) {
    requireExtensionPermission(extension, 'sidePanel')
    if (behavior && typeof behavior.openPanelOnActionClick === 'boolean') {
      getExtensionSidePanelSettings(extension).openPanelOnActionClick = behavior.openPanelOnActionClick
    }
  })
  handle('sidePanel.getPanelBehavior', function ({ extension }) {
    requireExtensionPermission(extension, 'sidePanel')
    return { openPanelOnActionClick: getExtensionSidePanelSettings(extension).openPanelOnActionClick }
  })
  function windowFor (options) {
    options = options || {}
    if (typeof options.tabId === 'number') {
      return getExtensionTabWindow(getExtensionAPITab(options.tabId))
    }
    return getExtensionAPIWindow(options.windowId)
  }
  handle('sidePanel.open', function ({ extension }, options) {
    requireExtensionPermission(extension, 'sidePanel')
    openExtensionSidePanel(extension, windowFor(options))
  })
  handle('sidePanel.close', function ({ extension }, options) {
    requireExtensionPermission(extension, 'sidePanel')
    const win = windowFor(options)
    const panel = extensionSidePanels.get(win)
    if (panel && panel.extensionId === extension.id) {
      closeExtensionSidePanel(win)
    }
  })

  extensionSession.extensions.on('extension-unloaded', function (event, extension) {
    extensionSidePanelSettings.delete(extension.id)
    for (const [win, panel] of extensionSidePanels) {
      if (panel.extensionId === extension.id) {
        closeExtensionSidePanel(win)
      }
    }
  })
}

ipc.on('extensions-side-panel-close', function (event) {
  const win = windows.windowFromContents(event.sender)?.win
  if (win) {
    closeExtensionSidePanel(win)
  }
})

/* Speech (tts), spoken by the UI's speechSynthesis (js/extensions.js), with the system's voices */

let extensionSpeechWindow = null
const extensionSpeaking = new Set() // request ids being spoken
const pendingExtensionVoiceRequests = new Map() // request id: resolve

function getExtensionSpeechWindow () {
  if (!extensionSpeechWindow || extensionSpeechWindow.isDestroyed()) {
    extensionSpeechWindow = windows.getCurrent()
  }
  return extensionSpeechWindow
}

function registerExtensionSpeechAPIs (handle) {
  handle('tts.speak', function ({ extension }, utterance, options, requestId) {
    requireExtensionPermission(extension, 'tts')
    options = options || {}
    const win = getExtensionSpeechWindow()
    if (!win) {
      throw new Error('There is no window to speak from.')
    }
    sendIPCToWindow(win, 'extensions-tts', {
      action: 'speak',
      requestId: String(requestId),
      extensionId: extension.id,
      text: String(utterance).slice(0, 32768),
      options: { lang: options.lang, voiceName: options.voiceName, rate: options.rate, pitch: options.pitch, volume: options.volume, enqueue: options.enqueue === true }
    })
  })
  for (const action of ['stop', 'pause', 'resume']) {
    handle('tts.' + action, function ({ extension }) {
      requireExtensionPermission(extension, 'tts')
      const win = getExtensionSpeechWindow()
      if (win) {
        sendIPCToWindow(win, 'extensions-tts', { action })
      }
    })
  }
  handle('tts.isSpeaking', () => extensionSpeaking.size > 0)
  handle('tts.getVoices', function ({ extension }) {
    requireExtensionPermission(extension, 'tts')
    const win = getExtensionSpeechWindow()
    if (!win) {
      return []
    }
    const requestId = Math.random().toString(36).slice(2)
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        pendingExtensionVoiceRequests.delete(requestId)
        resolve([])
      }, 3000)
      pendingExtensionVoiceRequests.set(requestId, function (voices) {
        clearTimeout(timer)
        pendingExtensionVoiceRequests.delete(requestId)
        resolve(voices)
      })
      sendIPCToWindow(win, 'extensions-tts', { action: 'voices', requestId })
    })
  })
}

ipc.on('extensions-tts-voices', function (event, args) {
  const resolve = windows.windowFromContents(event.sender) && args && pendingExtensionVoiceRequests.get(args.requestId)
  if (resolve) {
    resolve(Array.isArray(args.voices) ? args.voices : [])
  }
})

// args: {requestId, extensionId, type, charIndex, errorMessage}
ipc.on('extensions-tts-event', function (event, args) {
  if (!windows.windowFromContents(event.sender) || !args || typeof args.extensionId !== 'string') {
    return
  }
  if (args.type === 'start') {
    extensionSpeaking.add(args.requestId)
  } else if (['end', 'interrupted', 'cancelled', 'error'].includes(args.type)) {
    extensionSpeaking.delete(args.requestId)
  }
  sendExtensionAPIEvent(args.extensionId, 'tts.onEvent', { requestId: args.requestId, type: args.type, charIndex: args.charIndex, errorMessage: args.errorMessage })
})
