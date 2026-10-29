/* Runs the user's scripts in this frame at their @run-at time, with the Greasemonkey functions they @grant. main/userscripts.js decides which ones match.
   The request is synchronous so that document-start scripts run before the page's own scripts.
   Scripts run in the page, like Violentmonkey's default mode, but their Greasemonkey functions live here, in the preload's isolated world:
   each script becomes a function whose parameters are GM_info, GM, unsafeWindow and its GM_* functions, run in the page with
   contextBridge.executeInMainWorld, so the functions are never on window. Functions that need the main process are in main/userscriptAPI.js.
   Also: notices local .user.js files to show the install page, and relays the install page's and Settings' messages to main/userscriptInstall.js. */

const userscriptStates = {} // script id: {script, values, valueListeners, menuCommands, resources, resourceURLs}
const userscriptCallbacks = {} // request, download or notification id: {details, ...}
let userscriptIdCounter = 0

function newUserscriptId () {
  userscriptIdCounter++
  return Math.random().toString(36).slice(2) + userscriptIdCounter
}

function callUserscriptCallback (callback, thisArg, args) {
  if (typeof callback === 'function') {
    try {
      callback.apply(thisArg, args)
    } catch (e) {
      console.error(e)
    }
  }
}

/* GM_getValue and friends. Values are kept as JSON strings, so every read returns a fresh copy. */

function parseUserscriptValue (json, defaultValue) {
  if (typeof json !== 'string') {
    return defaultValue
  }
  try {
    return JSON.parse(json)
  } catch (e) {
    return defaultValue
  }
}

// changes: {key: JSON string, or null to delete}
function changeUserscriptValues (state, changes, remote) {
  Object.keys(changes).forEach(function (key) {
    const oldJSON = state.values[key]
    const newJSON = typeof changes[key] === 'string' ? changes[key] : undefined
    if (newJSON === undefined) {
      delete state.values[key]
    } else {
      state.values[key] = newJSON
    }
    if (oldJSON === newJSON) {
      return
    }
    Object.values(state.valueListeners).forEach(function (listener) {
      if (listener.key === key) {
        setTimeout(function () {
          callUserscriptCallback(listener.callback, null, [key, parseUserscriptValue(oldJSON), parseUserscriptValue(newJSON), remote])
        }, 0)
      }
    })
  })
}

function setUserscriptValues (state, values) {
  const changes = {}
  Object.keys(values).forEach(function (key) {
    const json = values[key] === undefined ? undefined : JSON.stringify(values[key])
    changes[key] = typeof json === 'string' ? json : null
  })
  changeUserscriptValues(state, changes, false)
  ipc.send('userscripts-set-values', { scriptId: state.script.id, changes })
}

/* GM_addStyle and GM_addElement. The page's CSP can block <style> elements, but not insertCSS. */

function getUserscriptElementParent () {
  return document.head || document.body || document.documentElement
}

function addUserscriptStyle (css) {
  const style = document.createElement('style')
  style.textContent = css
  const parent = getUserscriptElementParent()
  if (parent) {
    parent.appendChild(style)
  }
  if (!style.sheet) {
    electron.webFrame.insertCSS(css)
  }
  return style
}

function addUserscriptElement (parent, tag, attributes) {
  if (typeof parent === 'string') {
    attributes = tag
    tag = parent
    parent = null
  }
  const element = document.createElement(tag)
  let text = null
  Object.keys(attributes || {}).forEach(function (name) {
    if (name === 'textContent' || name === 'innerText') {
      text = String(attributes[name])
    } else {
      element.setAttribute(name, attributes[name])
    }
  })
  const isScript = element.tagName === 'SCRIPT'
  if (text !== null && !isScript) {
    element.textContent = text
  }
  (parent || getUserscriptElementParent()).appendChild(element)
  // inline scripts and styles the page's CSP would block
  if (isScript && text !== null) {
    electron.webFrame.executeJavaScript(text, false).catch(e => console.error(e))
  }
  if (element.tagName === 'STYLE' && text !== null && !element.sheet) {
    electron.webFrame.insertCSS(text)
  }
  return element
}

/* GM_xmlhttpRequest: sent by main/userscriptAPI.js. The page-side part (documents, FormData, GM.xmlHttpRequest) is USERSCRIPT_XHR_PROLOGUE in main/userscripts.js. */

const USERSCRIPT_DOCUMENT_TYPES = ['text/html', 'text/xml', 'application/xml', 'application/xhtml+xml', 'image/svg+xml']

async function serializeUserscriptRequestBody (data) {
  data = await data
  if (data === undefined || data === null) {
    return null
  }
  if (typeof data === 'string') {
    return data
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer())
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  return typeof data === 'object' ? JSON.stringify(data) : String(data)
}

function dispatchUserscriptRequestEvent (request, type, extra) {
  callUserscriptCallback(request.details['on' + type], request.details, [Object.assign({}, request.response, extra)])
}

function finishUserscriptRequest (request, type, extra) {
  delete userscriptCallbacks[request.id]
  Object.assign(request.response, { readyState: 4 }, extra)
  dispatchUserscriptRequestEvent(request, 'readystatechange')
  dispatchUserscriptRequestEvent(request, type)
  dispatchUserscriptRequestEvent(request, 'loadend')
}

function decodeUserscriptResponse (request, data) {
  const body = data.body
  const mimeType = request.details.overrideMimeType || data.contentType || ''
  const result = { status: data.status, statusText: data.statusText, responseHeaders: data.responseHeaders, finalUrl: data.finalUrl, loaded: data.loaded, total: data.total, lengthComputable: true }

  if (request.responseType === 'arraybuffer') {
    result.response = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    return result
  }
  if (request.responseType === 'blob') {
    result.response = new Blob([body], { type: mimeType })
    return result
  }

  const charset = (mimeType.match(/charset=\s*"?([^;"\s]+)/i) || [])[1]
  try {
    result.responseText = new TextDecoder(charset || 'utf-8').decode(body)
  } catch (e) {
    result.responseText = new TextDecoder().decode(body)
  }
  result.response = result.responseText
  if (request.responseType === 'json') {
    try {
      result.response = JSON.parse(result.responseText)
    } catch (e) {
      result.response = undefined
    }
  }

  const isXML = /[+/]xml\b/i.test(mimeType)
  if (request.responseType === 'document' || isXML) {
    // Documents can't be passed to the page, but their elements can; the page-side prologue turns this back into responseXML
    const baseType = mimeType.split(';')[0].trim().toLowerCase()
    const type = USERSCRIPT_DOCUMENT_TYPES.includes(baseType) ? baseType : (isXML ? 'text/xml' : 'text/html')
    try {
      result.documentElement = new DOMParser().parseFromString(result.responseText, type).documentElement
    } catch (e) {}
  }
  return result
}

function startUserscriptRequest (state, details) {
  details = details || {}
  const request = {
    id: newUserscriptId(),
    details,
    responseType: String(details.responseType || '').toLowerCase(),
    sent: false
  }
  request.response = { readyState: 1, status: 0, statusText: '', responseHeaders: '', finalUrl: '', responseType: request.responseType, context: details.context }

  let url
  try {
    url = new URL(details.url, window.location.href).href
  } catch (e) {
    setTimeout(() => finishUserscriptRequest(request, 'error', { error: 'Invalid URL' }), 0)
    return { abort: function () {} }
  }

  userscriptCallbacks[request.id] = request
  // after returning, so the script has the request object before its callbacks run
  setTimeout(function () {
    dispatchUserscriptRequestEvent(request, 'loadstart')
    dispatchUserscriptRequestEvent(request, 'readystatechange')
  }, 0)

  serializeUserscriptRequestBody(details.data).then(function (data) {
    if (!userscriptCallbacks[request.id]) {
      return
    }
    request.sent = true
    ipc.send('userscripts-xhr', {
      requestId: request.id,
      scriptId: state.script.id,
      details: {
        url,
        method: details.method,
        headers: Object.assign({}, details.headers),
        data,
        timeout: Number(details.timeout) || 0,
        anonymous: !!details.anonymous,
        nocache: !!details.nocache,
        redirect: details.redirect,
        user: details.user,
        password: details.password
      }
    })
  }, function (e) {
    finishUserscriptRequest(request, 'error', { error: String(e) })
  })

  return {
    abort: function () {
      if (!userscriptCallbacks[request.id]) {
        return
      }
      if (request.sent) {
        ipc.send('userscripts-xhr-abort', request.id)
      } else {
        finishUserscriptRequest(request, 'abort')
      }
    }
  }
}

ipc.on('userscripts-xhr-event', function (e, message) {
  const request = userscriptCallbacks[message.requestId]
  if (!request) {
    return
  }
  const data = message.data || {}
  if (message.type === 'headers') {
    Object.assign(request.response, { readyState: 2, status: data.status, statusText: data.statusText, responseHeaders: data.responseHeaders, finalUrl: data.finalUrl })
    dispatchUserscriptRequestEvent(request, 'readystatechange')
  } else if (message.type === 'progress') {
    if (request.response.readyState < 3) {
      request.response.readyState = 3
      dispatchUserscriptRequestEvent(request, 'readystatechange')
    }
    dispatchUserscriptRequestEvent(request, 'progress', { loaded: data.loaded, total: data.total, lengthComputable: data.total > 0 })
  } else if (message.type === 'load') {
    finishUserscriptRequest(request, 'load', decodeUserscriptResponse(request, data))
  } else {
    finishUserscriptRequest(request, message.type, { error: data.error, finalUrl: data.finalUrl || request.response.finalUrl })
  }
})

/* GM_download, GM_openInTab, GM_notification, GM_getResourceText/URL */

function startUserscriptDownload (state, details, name) {
  if (typeof details === 'string') {
    details = { url: details, name }
  }
  details = details || {}
  const downloadId = newUserscriptId()
  let url
  try {
    url = new URL(details.url, window.location.href).href
  } catch (e) {
    setTimeout(() => callUserscriptCallback(details.onerror, details, [{ error: 'not_permitted', details: 'Invalid URL' }]), 0)
    return { abort: function () {} }
  }
  userscriptCallbacks[downloadId] = { details }
  ipc.send('userscripts-download', { scriptId: state.script.id, downloadId, url, name: details.name, headers: details.headers && Object.assign({}, details.headers) })
  return { abort: function () {} }
}

ipc.on('userscripts-download-event', function (e, message) {
  const download = userscriptCallbacks[message.downloadId]
  if (!download) {
    return
  }
  delete userscriptCallbacks[message.downloadId]
  if (message.type === 'load') {
    callUserscriptCallback(download.details.onload, download.details, [{}])
  } else {
    callUserscriptCallback(download.details.onerror, download.details, [{ error: 'failed', details: message.error }])
  }
})

// options: {active, incognito}, or true to open in the background. The returned object can close the tab again.
function openUserscriptTab (state, url, options) {
  if (typeof options === 'boolean') {
    options = { active: !options }
  }
  options = options || {}
  try {
    url = new URL(url, window.location.href).href
  } catch (e) {
    return { closed: true, close: function () {} }
  }
  const tabId = ipc.invoke('userscripts-open-tab', { scriptId: state.script.id, url, active: !!options.active, incognito: !!options.incognito })
  return {
    closed: false,
    close: function () {
      tabId.then(function (id) {
        if (id) {
          ipc.send('userscripts-close-tab', id)
        }
      })
    }
  }
}

function showUserscriptNotification (state, details, title, image, onclick) {
  if (typeof details !== 'object' || details === null) {
    details = { text: details, title, image, onclick }
  }
  const notificationId = newUserscriptId()
  userscriptCallbacks[notificationId] = { details }
  ipc.send('userscripts-notification', {
    scriptId: state.script.id,
    notificationId,
    title: details.title,
    text: details.text,
    image: typeof details.image === 'string' ? details.image : '',
    silent: !!details.silent,
    timeout: Number(details.timeout) || 0
  })
}

ipc.on('userscripts-notification-event', function (e, message) {
  const notification = userscriptCallbacks[message.notificationId]
  if (!notification) {
    return
  }
  if (message.type === 'click') {
    callUserscriptCallback(notification.details.onclick, notification.details, [])
  } else {
    delete userscriptCallbacks[message.notificationId]
    callUserscriptCallback(notification.details.ondone, notification.details, [])
  }
})

function getUserscriptResource (state, name) {
  if (!(name in state.resources)) {
    state.resources[name] = ipc.sendSync('userscripts-resource', { scriptId: state.script.id, name })
  }
  return state.resources[name]
}

function getUserscriptResourceURL (state, name, asBlob) {
  const resource = getUserscriptResource(state, name)
  if (!resource) {
    return null
  }
  const type = resource.contentType.split(';')[0].trim() || 'application/octet-stream'
  if (asBlob) {
    if (!state.resourceURLs[name]) {
      state.resourceURLs[name] = URL.createObjectURL(new Blob([resource.data], { type }))
    }
    return state.resourceURLs[name]
  }
  let binary = ''
  for (let i = 0; i < resource.data.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, resource.data.subarray(i, i + 0x8000))
  }
  return 'data:' + type + ';base64,' + btoa(binary)
}

/* Running scripts */

function createUserscriptAPI (state) {
  const scriptId = state.script.id
  return {
    getValue: (key, defaultValue) => parseUserscriptValue(state.values[key], defaultValue),
    setValue: (key, value) => setUserscriptValues(state, { [key]: value }),
    deleteValue: key => setUserscriptValues(state, { [key]: undefined }),
    listValues: () => Object.keys(state.values),
    getValues: function (keys) {
      const result = {}
      if (Array.isArray(keys)) {
        keys.filter(key => key in state.values).forEach(key => { result[key] = parseUserscriptValue(state.values[key]) })
      } else {
        Object.keys(keys || {}).forEach(key => { result[key] = parseUserscriptValue(state.values[key], keys[key]) })
      }
      return result
    },
    setValues: values => setUserscriptValues(state, values || {}),
    deleteValues: keys => setUserscriptValues(state, Object.fromEntries((keys || []).map(key => [key, undefined]))),
    addValueChangeListener: function (key, callback) {
      const listenerId = newUserscriptId()
      state.valueListeners[listenerId] = { key, callback }
      return listenerId
    },
    removeValueChangeListener: function (listenerId) {
      delete state.valueListeners[listenerId]
    },
    addStyle: css => addUserscriptStyle(String(css)),
    addElement: addUserscriptElement,
    xmlhttpRequest: details => startUserscriptRequest(state, details),
    download: (details, name) => startUserscriptDownload(state, details, name),
    openInTab: (url, options) => openUserscriptTab(state, url, options),
    setClipboard: function (data, info) {
      const type = typeof info === 'string' ? info : (info && (info.type || info.mimetype))
      ipc.send('userscripts-set-clipboard', { scriptId, data: String(data), type: type || 'text' })
    },
    notification: (details, title, image, onclick) => showUserscriptNotification(state, details, title, image, onclick),
    registerMenuCommand: function (caption, callback, options) {
      const commandId = String((options && typeof options === 'object' && options.id) || newUserscriptId())
      state.menuCommands[commandId] = callback
      ipc.send('userscripts-menu-command-add', { scriptId, id: commandId, caption: String(caption) })
      return commandId
    },
    unregisterMenuCommand: function (commandId) {
      delete state.menuCommands[commandId]
      ipc.send('userscripts-menu-command-remove', { scriptId, id: String(commandId) })
    },
    getResourceText: function (name) {
      const resource = getUserscriptResource(state, name)
      return resource ? new TextDecoder().decode(resource.data) : null
    },
    getResourceURL: (name, isBlobURL) => getUserscriptResourceURL(state, name, isBlobURL !== false),
    log: (...args) => console.log('[' + state.script.name + ']', ...args)
  }
}

// Greasemonkey 4 names (GM.*) that differ from the GM_* ones; the GM.* functions return promises
const USERSCRIPT_GM4_NAMES = {
  xmlhttpRequest: ['xmlHttpRequest', 'xmlhttpRequest'],
  getResourceURL: ['getResourceUrl', 'getResourceURL']
}

function getUserscriptArgs (state) {
  const api = createUserscriptAPI(state)
  const GM = { info: state.script.info }
  const args = { GM_info: state.script.info, GM, unsafeWindow: null }
  state.script.grants.forEach(function (name) {
    args['GM_' + name] = api[name]
    ;(USERSCRIPT_GM4_NAMES[name] || [name]).forEach(function (gm4Name) {
      GM[gm4Name] = function () {
        try {
          return Promise.resolve(api[name].apply(null, arguments))
        } catch (e) {
          return Promise.reject(e)
        }
      }
    })
  })
  return state.script.params.map(param => args[param])
}

function runUserscript (script) {
  if (script.legacy) {
    electron.webFrame.executeJavaScript(script.code, false).catch(function (e) {
      console.warn('userscript ' + script.name + ' failed', e)
    })
    return
  }

  if (!userscriptStates[script.id]) {
    userscriptStates[script.id] = { values: {}, valueListeners: {}, menuCommands: {}, resources: {}, resourceURLs: {} }
  }
  const state = userscriptStates[script.id]
  state.script = script
  if (script.values) {
    state.values = Object.assign({}, script.values)
  }

  let scriptFunction
  try {
    scriptFunction = new Function(...script.params, script.code) // eslint-disable-line no-new-func
  } catch (e) {
    console.error('userscript ' + script.name + ' has an error', e)
    return
  }
  try {
    electron.contextBridge.executeInMainWorld({ func: scriptFunction, args: getUserscriptArgs(state) })
  } catch (e) {
    console.error('userscript ' + script.name + ' failed', e)
  }
}

function runUserscriptsInFrame (scripts) {
  function runAt (runAt) {
    scripts.filter(script => script.runAt === runAt).forEach(runUserscript)
  }

  runAt('document-start')

  let bodyScriptsRan = false
  function runBodyScripts () {
    if (!bodyScriptsRan) {
      bodyScriptsRan = true
      runAt('document-body')
    }
  }

  if (document.body) {
    runBodyScripts()
  } else if (scripts.some(script => script.runAt === 'document-body')) {
    const bodyObserver = new MutationObserver(function () {
      if (document.body) {
        bodyObserver.disconnect()
        runBodyScripts()
      }
    })
    bodyObserver.observe(document, { childList: true, subtree: true })
    document.addEventListener('DOMContentLoaded', function () {
      bodyObserver.disconnect()
      runBodyScripts()
    }, { once: true })
  }

  function runAfterDOMContentLoaded () {
    runAt('document-end')
    setTimeout(function () {
      runAt('document-idle')
    }, 0)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runAfterDOMContentLoaded, { once: true })
  } else {
    runAfterDOMContentLoaded()
  }
}

ipc.on('userscripts-values-changed', function (e, message) {
  const state = userscriptStates[message.scriptId]
  if (state) {
    changeUserscriptValues(state, message.changes, true)
  }
})

ipc.on('userscripts-menu-command', function (e, message) {
  const state = userscriptStates[message.scriptId]
  if (state) {
    callUserscriptCallback(state.menuCommands[message.id], null, [])
  }
})

// the !run bang and context-menu scripts
ipc.on('userscripts-run-script', function (e, script) {
  runUserscript(script)
})

if (window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'file:') {
  const matchingUserscripts = ipc.sendSync('userscripts-get')
  if (matchingUserscripts) {
    runUserscriptsInFrame(matchingUserscripts)
  }

  // a local .user.js file opened as a page: show the install page instead (main/userscriptInstall.js), unless the user came back to it.
  // Files from the web are noticed earlier, from their response headers (main/download.js).
  if (window === window.top && window.location.protocol === 'file:' && /\.user\.js$/i.test(window.location.pathname)) {
    document.addEventListener('DOMContentLoaded', function () {
      const navigation = performance.getEntriesByType('navigation')[0]
      if (document.contentType !== 'text/html' && !(navigation && navigation.type === 'back_forward')) {
        ipc.send('userscripts-install-prompt')
      }
    }, { once: true })
  }
}

// the install page and Settings: {message: 'userscripts', requestId, action, args} → {message: 'userscriptsResult', requestId, result | error}
if (window.location.protocol === 'min:') {
  window.addEventListener('message', function (e) {
    if (e.source !== window || !e.data || e.data.message !== 'userscripts') {
      return
    }
    const requestId = e.data.requestId
    ipc.invoke('userscripts-page', { action: e.data.action, args: e.data.args }).then(function (result) {
      window.postMessage({ message: 'userscriptsResult', requestId, result }, window.location.origin)
    }, function (error) {
      const message = String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      window.postMessage({ message: 'userscriptsResult', requestId, error: message }, window.location.origin)
    })
  })

  ipc.on('userscripts-page-changed', function () {
    window.postMessage({ message: 'userscriptsChanged' }, window.location.origin)
  })
}
