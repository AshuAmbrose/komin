/* What an extension may know and do without the permission for it (AGENTS.md section 10.9). electron-chrome-extensions
   gives every extension every API it has and answers whatever it's asked: an extension that asked for nothing at install
   could read every tab's address and every site's cookies. Chrome ties these to permissions, which the user sees when
   installing, so Min checks them where the library's answers and events pass through (its router):
   - a tab's address, title and icon (the tabs and windows APIs, tab events): only with the "tabs" permission, access to
     that site (host permissions), on the extension's own pages, or with "activeTab" once the user has used the extension
     on that tab (its button, its menu item or its shortcut), until the tab goes to another site;
   - cookies: the "cookies" permission, and access to the cookie's site;
   - webNavigation, notifications, contextMenus: their permissions;
   - tabs.insertCSS: access to the tab's site;
   - who is asking: the library takes the extension's id from the message itself, and its bridge to main stays within
     reach of every extension's code, so one extension could name another (one with more permissions). Min checks that a
     message comes from a page or the worker of the extension it names;
   - optional permissions (chrome.permissions): only what the manifest declares can be asked for; what the user allowed
     is kept in extensions.json (`granted`) and given back when the extension loads, as Chrome keeps it; permissions.remove
     takes it away again (the library forgot grants at every restart, let any site be asked for, and removed nothing).
   js/preload/extensionSupport.js also takes those APIs away from extensions that never declared the permission, as in
   Chrome, so their own "is this API here?" checks answer as they do there.
   This reaches into the library's internals (missingExtensionPermissionInternals). If a newer version lacks one, none
   of it runs: extensions then get what the library alone gives, and Min says so in its log. */

const EXTENSION_API_PERMISSIONS = { cookies: 'cookies', webNavigation: 'webNavigation', notifications: 'notifications', contextMenus: 'contextMenus' }
const EXTENSION_TAB_PRIVATE_FIELDS = ['url', 'pendingUrl', 'title', 'favIconUrl']
// events whose arguments include a tab; the last three mean the user just used the extension on that tab
const EXTENSION_EVENTS_WITH_TABS = new Set(['tabs.onCreated', 'tabs.onUpdated', 'browserAction.onClicked', 'contextMenus.onClicked', 'commands.onCommand'])
const EXTENSION_INVOCATION_EVENTS = new Set(['browserAction.onClicked', 'contextMenus.onClicked', 'commands.onCommand'])
const extensionActiveTabGrants = new Map() // extension id: Map(extension tab id: the origin of the page it was used on)
const extensionHostMatchers = new Map() // extension id: {patterns, matchers}
let extensionPermissionChecksOn = false

// the parts of electron-chrome-extensions (4.10) this file uses, by name: those missing or of another kind
function missingExtensionPermissionInternals () {
  const ctx = chromeExtensions && chromeExtensions.ctx
  const router = ctx && ctx.router
  const api = chromeExtensions && chromeExtensions.api
  const needed = {
    'ctx.router.handlers': router && router.handlers instanceof Map,
    'ctx.router.listeners': router && router.listeners instanceof Map,
    'ctx.router.sendEvent': router && typeof router.sendEvent === 'function',
    'ctx.router.onExtensionMessage': router && typeof router.onExtensionMessage === 'function',
    'ctx.store.getTabById': ctx && ctx.store && typeof ctx.store.getTabById === 'function',
    'api.permissions.permissionMap': api && api.permissions && api.permissions.permissionMap instanceof Map,
    'api.tabs.getTabDetails': api && api.tabs && typeof api.tabs.getTabDetails === 'function'
  }
  return Object.keys(needed).filter(name => !needed[name])
}

// what the extension has now: its manifest's permissions and sites, plus optional ones the user granted since
function getExtensionGrants (extension) {
  const granted = chromeExtensions.api.permissions.permissionMap.get(extension.id)
  return {
    permissions: (granted && granted.permissions) || extension.manifest.permissions || [],
    origins: (granted && granted.origins) || extension.manifest.host_permissions || []
  }
}

function extensionHasGrantedPermission (extension, permission) {
  return getExtensionGrants(extension).permissions.includes(permission)
}

// whether the extension has access to a site (its host permissions, as Chrome match patterns), or the page is its own
function extensionCanAccessURL (extension, href) {
  let url
  try {
    url = new URL(href)
  } catch (e) {
    return false
  }
  if (url.protocol === 'chrome-extension:') {
    return url.hostname === extension.id
  }
  const patterns = getExtensionGrants(extension).origins.join('\n')
  let cached = extensionHostMatchers.get(extension.id)
  if (!cached || cached.patterns !== patterns) {
    cached = { patterns, matchers: patterns.split('\n').map(compileUserscriptMatchPattern).filter(Boolean) }
    extensionHostMatchers.set(extension.id, cached)
  }
  return cached.matchers.some(matches => matches(url))
}

// "activeTab": the user used the extension on this tab, which gives it the page until the tab goes to another site
function grantExtensionActiveTab (extension, tab) {
  if (!extensionPermissionChecksOn || !tab || typeof tab.id !== 'number' || !extensionHasGrantedPermission(extension, 'activeTab')) {
    return
  }
  let origin
  try {
    origin = new URL(tab.url).origin
  } catch (e) {
    return
  }
  if (!extensionActiveTabGrants.has(extension.id)) {
    extensionActiveTabGrants.set(extension.id, new Map())
  }
  extensionActiveTabGrants.get(extension.id).set(tab.id, origin)
}

// access to the page in a tab: to its site, or through activeTab. tab: the library's tab details
function extensionCanAccessTabSite (extension, tab) {
  if (!tab || typeof tab.url !== 'string' || tab.url === '') {
    return false
  }
  if (extensionCanAccessURL(extension, tab.url)) {
    return true
  }
  const grants = extensionActiveTabGrants.get(extension.id)
  if (grants && grants.has(tab.id)) {
    let origin = null
    try {
      origin = new URL(tab.url).origin
    } catch (e) {}
    if (grants.get(tab.id) === origin) {
      return true
    }
    grants.delete(tab.id)
  }
  return false
}

function extensionCanSeeTab (extension, tab) {
  return extensionHasGrantedPermission(extension, 'tabs') || extensionCanAccessTabSite(extension, tab)
}

function looksLikeExtensionTab (value) {
  return !!value && typeof value === 'object' && typeof value.id === 'number' && 'windowId' in value && 'index' in value && 'active' in value
}

function withoutPrivateTabFields (object) {
  const copy = Object.assign({}, object)
  EXTENSION_TAB_PRIVATE_FIELDS.forEach(function (field) {
    delete copy[field]
  })
  return copy
}

// a tab's details (or a list of them, or a window's details with its tabs) as this extension may see them: copies
// without the address, title and icon where it may not (the library's own objects are shared, so never changed)
function tabsForExtension (extension, value) {
  if (Array.isArray(value)) {
    return value.map(item => tabsForExtension(extension, item))
  }
  if (looksLikeExtensionTab(value)) {
    return extensionCanSeeTab(extension, value) ? value : withoutPrivateTabFields(value)
  }
  if (value && typeof value === 'object' && Array.isArray(value.tabs)) {
    return Object.assign({}, value, { tabs: tabsForExtension(extension, value.tabs) })
  }
  return value
}

// a cookie as the library describes it ({domain, path, secure…}): Chrome asks for access to the cookie's site
function extensionCanAccessCookie (extension, cookie) {
  if (!cookie || typeof cookie.domain !== 'string') {
    return false
  }
  return extensionCanAccessURL(extension, (cookie.secure ? 'https://' : 'http://') + cookie.domain.replace(/^\./, '') + (cookie.path || '/'))
}

// Whether a message comes from the extension it names: one of its pages (a frame at chrome-extension://<id>/) or its
// background worker. event: the IPC event
function extensionMessageSenderIs (event, extensionId) {
  if (typeof extensionId !== 'string' || extensionId === '') {
    return false
  }
  try {
    if (event.type === 'service-worker') {
      return event.serviceWorker.scope.startsWith('chrome-extension://' + extensionId + '/')
    }
    const url = new URL(event.senderFrame.url)
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId
  } catch (e) {
    return false
  }
}

/* Optional permissions */

function extensionPermissionList (value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

// whether the extension already has everything in a request ({permissions, origins})
function extensionHasGrants (extension, request) {
  const granted = getExtensionGrants(extension)
  return request.permissions.every(permission => granted.permissions.includes(permission)) &&
    request.origins.every(origin => granted.origins.some(have => extensionHostPatternCovers(have, origin)))
}

// what the user allowed beyond the manifest's own permissions, kept in extensions.json
function saveExtensionGrants (extension) {
  const entry = getExtensionRegistry()[extension.id]
  if (!entry) {
    return
  }
  const granted = getExtensionGrants(extension)
  const manifest = extension.manifest
  const extra = {
    permissions: granted.permissions.filter(permission => !(manifest.permissions || []).includes(permission)),
    origins: granted.origins.filter(origin => !(manifest.host_permissions || []).includes(origin))
  }
  if (extra.permissions.length > 0 || extra.origins.length > 0) {
    entry.granted = extra
  } else {
    delete entry.granted
  }
  saveExtensionRegistry()
}

// as the extension loads (after the library has set its permissions from the manifest): what the user allowed earlier,
// as far as the manifest still declares it as optional (an update may have dropped it)
function restoreExtensionGrants (extension) {
  const entry = getExtensionRegistry()[extension.id]
  const granted = chromeExtensions.api.permissions.permissionMap.get(extension.id)
  if (!entry || !entry.granted || !granted) {
    return
  }
  const manifest = extension.manifest
  const permissions = extensionPermissionList(entry.granted.permissions).filter(permission => extensionPermissionList(manifest.optional_permissions).includes(permission))
  const origins = extensionPermissionList(entry.granted.origins).filter(origin => extensionPermissionList(manifest.optional_host_permissions).some(declared => extensionHostPatternCovers(declared, origin)))
  // new lists: the library's are the manifest's own
  granted.permissions = granted.permissions.concat(permissions.filter(permission => !granted.permissions.includes(permission)))
  granted.origins = granted.origins.concat(origins.filter(origin => !granted.origins.includes(origin)))
}

// chrome.permissions.request and remove
async function answerExtensionPermissionsCall (name, handler, event, args) {
  const extension = event.extension
  const manifest = extension.manifest
  const request = { permissions: extensionPermissionList(args[0] && args[0].permissions), origins: extensionPermissionList(args[0] && args[0].origins) }
  if (name === 'permissions.request') {
    const declared = {
      permissions: extensionPermissionList(manifest.permissions).concat(extensionPermissionList(manifest.optional_permissions)),
      origins: extensionPermissionList(manifest.host_permissions).concat(extensionPermissionList(manifest.optional_host_permissions))
    }
    if (!request.permissions.every(permission => declared.permissions.includes(permission)) ||
      !request.origins.every(origin => declared.origins.some(have => extensionHostPatternCovers(have, origin)))) {
      throw new Error('Only permissions specified in the manifest may be requested.')
    }
    if (extensionHasGrants(extension, request)) {
      return true
    }
    // the library asks the user (requestExtensionPermissions in extensions.js) and adds what was allowed
    const allowed = await handler.callback(event, request)
    if (allowed === true) {
      saveExtensionGrants(extension)
      chromeExtensions.ctx.router.sendEvent(extension.id, 'permissions.onAdded', request)
    }
    return allowed
  }
  // permissions.remove
  if (request.permissions.some(permission => extensionPermissionList(manifest.permissions).includes(permission)) ||
    request.origins.some(origin => extensionPermissionList(manifest.host_permissions).includes(origin))) {
    throw new Error('You cannot remove required permissions.')
  }
  const granted = chromeExtensions.api.permissions.permissionMap.get(extension.id)
  if (!granted) {
    return false
  }
  const before = granted.permissions.length + granted.origins.length
  granted.permissions = granted.permissions.filter(permission => !request.permissions.includes(permission))
  granted.origins = granted.origins.filter(origin => !request.origins.includes(origin))
  if (granted.permissions.length + granted.origins.length !== before) {
    saveExtensionGrants(extension)
    chromeExtensions.ctx.router.sendEvent(extension.id, 'permissions.onRemoved', request)
  }
  return true
}

// one call to an API of the library, answered as Chrome would for this extension
async function answerExtensionAPICall (name, handler, event, args) {
  const extension = event && event.extension
  if (!extension) {
    return handler.callback(event, ...args)
  }
  if (name === 'permissions.request' || name === 'permissions.remove') {
    return answerExtensionPermissionsCall(name, handler, event, args)
  }
  const namespace = name.split('.')[0]
  const needs = EXTENSION_API_PERMISSIONS[namespace]
  if (needs && !extensionHasGrantedPermission(extension, needs)) {
    throw new Error('\'' + name + '\' is only available to extensions with the "' + needs + '" permission.')
  }
  if (name === 'cookies.get' || name === 'cookies.set' || name === 'cookies.remove') {
    const url = args[0] && args[0].url
    if (!extensionCanAccessURL(extension, url)) {
      throw new Error('No host permissions for cookies at url: "' + url + '".')
    }
  }
  if (name === 'tabs.insertCSS') {
    const contents = chromeExtensions.ctx.store.getTabById(args[0])
    if (contents && !extensionCanAccessTabSite(extension, chromeExtensions.api.tabs.getTabDetails(contents))) {
      throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')
    }
  }
  let result = await handler.callback(event, ...args)
  if (name === 'cookies.getAll' && Array.isArray(result)) {
    return result.filter(cookie => extensionCanAccessCookie(extension, cookie))
  }
  if (namespace !== 'tabs' && namespace !== 'windows') {
    return result
  }
  // a query by address or title can't find tabs the extension may not see
  if (name === 'tabs.query' && Array.isArray(result) && args[0] && (args[0].url !== undefined || args[0].title !== undefined)) {
    result = result.filter(tab => extensionCanSeeTab(extension, tab))
  }
  return tabsForExtension(extension, result)
}

// one event, sent to each listening extension as Chrome would send it (or not at all)
function sendExtensionEventChecked (send, listeners, target, name, args) {
  const namespace = name.split('.')[0]
  const needs = EXTENSION_API_PERMISSIONS[namespace]
  if (name === 'tabs.onRemoved') {
    extensionActiveTabGrants.forEach(grants => grants.delete(args[0]))
  }
  if (!needs && namespace !== 'windows' && !EXTENSION_EVENTS_WITH_TABS.has(name)) {
    return send(target, name, ...args)
  }
  const ids = new Set((listeners.get(name) || []).map(listener => listener.extensionId))
  for (const id of ids) {
    const extension = (!target || target === id) && extensionSession.extensions.getExtension(id)
    if (!extension || (needs && !extensionHasGrantedPermission(extension, needs))) {
      continue
    }
    if (name === 'cookies.onChanged' && !extensionCanAccessCookie(extension, args[0] && args[0].cookie)) {
      continue
    }
    if (EXTENSION_INVOCATION_EVENTS.has(name)) {
      grantExtensionActiveTab(extension, args.find(looksLikeExtensionTab))
    }
    const own = args.map(arg => tabsForExtension(extension, arg))
    if (name === 'tabs.onUpdated' && own[2] !== args[2]) {
      // (tab id, what changed, the tab): nothing to tell if only its address, title or icon changed
      own[1] = withoutPrivateTabFields(args[1])
      if (Object.keys(own[1]).length === 0) {
        continue
      }
    }
    send(id, name, ...own)
  }
}

// after every API handler is registered (the library's and main/extensionAPIs.js's)
function startExtensionPermissionChecks () {
  const missing = missingExtensionPermissionInternals()
  if (missing.length > 0) {
    console.warn('extensions: Min isn\'t checking extensions\' permissions for tabs\' addresses and cookies: electron-chrome-extensions has changed (missing ' + missing.join(', ') + ')')
    return
  }
  extensionPermissionChecksOn = true
  const router = chromeExtensions.ctx.router
  // every message names its extension: only that extension's pages and worker may (a message naming none is the
  // library's channel for a browser's own toolbar page, which Min doesn't have)
  const onMessage = router.onExtensionMessage.bind(router)
  router.onExtensionMessage = async function (event, extensionId, handlerName, ...args) {
    if (!extensionMessageSenderIs(event, extensionId)) {
      throw new Error('\'' + handlerName + '\' wasn\'t sent by the extension it names.')
    }
    return onMessage(event, extensionId, handlerName, ...args)
  }
  // the same for a page signing up for an extension's events (the library listens on ipcMain itself)
  ;['crx-add-listener', 'crx-remove-listener'].forEach(function (channel) {
    ipc.listeners(channel).forEach(function (listener) {
      ipc.removeListener(channel, listener)
      ipc.on(channel, function (event, extensionId, ...rest) {
        if (extensionMessageSenderIs(event, extensionId)) {
          listener(event, extensionId, ...rest)
        }
      })
    })
  })
  for (const [name, handler] of router.handlers) {
    const namespace = name.split('.')[0]
    if (typeof handler.callback === 'function' && (EXTENSION_API_PERMISSIONS[namespace] || namespace === 'tabs' || namespace === 'windows' || name === 'permissions.request' || name === 'permissions.remove')) {
      router.handlers.set(name, Object.assign({}, handler, {
        callback: (event, ...args) => answerExtensionAPICall(name, handler, event, args)
      }))
    }
  }
  const send = router.sendEvent.bind(router)
  router.sendEvent = function (target, name, ...args) {
    return sendExtensionEventChecked(send, router.listeners, target, name, args)
  }
  // after the library's own listener, which sets the extension's permissions from its manifest
  extensionSession.extensions.on('extension-loaded', function (event, extension) {
    restoreExtensionGrants(extension)
  })
  extensionSession.extensions.on('extension-unloaded', function (event, extension) {
    extensionActiveTabGrants.delete(extension.id)
    extensionHostMatchers.delete(extension.id)
  })
}
