/* Userscripts: loads <userData>/userscripts/*.js while the userscriptsEnabled setting is on.
   Each frame's preload (js/preload/userscripts.js) asks for the scripts that match it at document start and runs them at their @run-at time,
   with the Greasemonkey functions they @grant. main/userscriptAPI.js handles the functions that need the main process.
   Matching and metadata are in js/util/userscriptMatching.js; installing, @require/@resource downloads and updates in main/userscriptInstall.js.
   The UI (js/userscripts.js) gets a list without the code, for the !run bang, context-menu scripts and menu commands. */

const userscriptDir = path.join(userDataPath, 'userscripts')
// what isn't part of the script files: saved values, downloaded @require/@resource files, and scripts.json (on/off, install source, updates)
const userscriptDataDir = path.join(userDataPath, 'userscriptData')
const userscriptValueDir = path.join(userscriptDataDir, 'values')
const userscriptRegistryPath = path.join(userscriptDataDir, 'scripts.json')

const USERSCRIPT_VALUE_APIS = ['getValue', 'setValue', 'deleteValue', 'listValues', 'getValues', 'setValues', 'deleteValues', 'addValueChangeListener', 'removeValueChangeListener']

let loadedUserscripts = [] // every script file (see compileUserscript); only enabled ones with all their downloads run
let userscriptsEnabled = false
let userscriptDirWatcher = null
let userscriptReloadTimer = null
let userscriptRegistry = null // file name: {enabled, sourceURL, installedAt, updatedAt, hash, lastUpdateCheck, pendingUpdate, updateError}

function getUserscriptRegistry () {
  if (!userscriptRegistry) {
    try {
      userscriptRegistry = JSON.parse(fs.readFileSync(userscriptRegistryPath, 'utf-8'))
    } catch (e) {
      userscriptRegistry = {}
    }
  }
  return userscriptRegistry
}

function writeUserscriptFile (filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath + '.tmp', data)
  fs.renameSync(filePath + '.tmp', filePath)
}

function saveUserscriptRegistry () {
  try {
    writeUserscriptFile(userscriptRegistryPath, JSON.stringify(getUserscriptRegistry()))
  } catch (e) {
    console.warn('failed to save userscript settings', e)
  }
}

function userscriptIsRunnable (script) {
  return script.enabled && script.missing.length === 0
}

// runs in the page before every script with metadata
const USERSCRIPT_PROLOGUE = 'unsafeWindow = window;'

// runs in the page before scripts that use GM_xmlhttpRequest, for what only the page's world can do: turn responses into documents, and send FormData
const USERSCRIPT_XHR_PROLOGUE = `GM_xmlhttpRequest = (function (sendRequest) {
  function withDocument (response) {
    if (response && response.documentElement) {
      response.responseXML = response.documentElement.ownerDocument
      if (response.responseType === 'document') {
        response.response = response.responseXML
      }
    }
    if (response) {
      delete response.documentElement
    }
    return response
  }
  return function (details) {
    details = details || {}
    var request = {}
    Object.keys(details).forEach(function (key) {
      var value = details[key]
      request[key] = typeof value === 'function' && key.indexOf('on') === 0 ? function (response) { return value.call(details, withDocument(response)) } : value
    })
    if (request.data instanceof FormData || request.data instanceof URLSearchParams) {
      var body = new Response(request.data)
      request.headers = Object.assign({ 'Content-Type': body.headers.get('Content-Type') }, request.headers)
      request.data = body.blob()
    }
    return sendRequest(request)
  }
})(GM_xmlhttpRequest);
GM.xmlHttpRequest = GM.xmlhttpRequest = function (details) {
  details = details || {}
  var request
  var promise = new Promise(function (resolve, reject) {
    function settle (callback, handlerName) {
      return function (response) {
        if (typeof details[handlerName] === 'function') {
          details[handlerName](response)
        }
        callback(response)
      }
    }
    request = GM_xmlhttpRequest(Object.assign({}, details, {
      onload: settle(resolve, 'onload'),
      onerror: settle(reject, 'onerror'),
      ontimeout: settle(reject, 'ontimeout'),
      onabort: settle(reject, 'onabort')
    }))
  })
  promise.abort = function () { request.abort() }
  return promise
};`

/*
Prepares what the preload needs to run a script:
- legacy scripts: code, run as it is.
- scripts with metadata: code is the body of a function whose parameters (params) are GM_info, GM, unsafeWindow and the granted GM_* functions.
  The preload creates the function and runs it in the page with contextBridge.executeInMainWorld, so the functions never appear on window.
  @require files go before the script, in the same scope, as in Tampermonkey.
*/
function prepareUserscriptCode (script, registryEntry) {
  const sourceURL = '\n//# sourceURL=' + encodeURI('userscript:///' + script.id)
  if (script.legacy) {
    script.code = script.content + sourceURL
    return
  }

  const parts = [USERSCRIPT_PROLOGUE]
  if (script.grants.includes('xmlhttpRequest')) {
    parts.push(USERSCRIPT_XHR_PROLOGUE)
  }
  script.requires.forEach(function (url) {
    parts.push(readUserscriptDependency(url).data.toString('utf-8'))
  })
  parts.push(script.content)

  script.code = parts.join('\n;\n') + sourceURL
  script.params = ['GM_info', 'GM', 'unsafeWindow'].concat(script.grants.map(api => 'GM_' + api))
  script.info = {
    script: {
      name: script.name,
      namespace: script.namespace,
      version: script.version,
      description: script.description,
      author: script.author,
      homepage: script.homepage,
      icon: script.icon,
      matches: script.rules.match || [],
      includes: script.rules.include || [],
      excludes: script.rules.exclude || [],
      excludeMatches: script.rules.excludeMatch || [],
      grant: script.grants.map(api => 'GM_' + api),
      connects: script.connects,
      requires: script.requires,
      resources: script.resources,
      runAt: script.runAt,
      'run-at': script.runAt,
      noframes: script.noframes,
      uuid: script.id,
      options: {}
    },
    scriptMetaStr: getUserscriptMetadataBlock(script.content),
    scriptHandler: 'Min',
    version: app.getVersion(),
    scriptWillUpdate: !!(registryEntry && registryEntry.sourceURL),
    injectInto: 'page',
    isIncognito: false
  }
}

function getUserscriptList () {
  return loadedUserscripts.filter(userscriptIsRunnable).map(script => ({ id: script.id, name: script.name, runAt: script.runAt, rules: script.rules }))
}

function sendUserscriptListToWindows () {
  const list = getUserscriptList()
  windows.getAll().forEach(function (win) {
    if (!win.isDestroyed()) {
      sendIPCToWindow(win, 'userscripts-changed', list)
    }
  })
}

// compiles every script in the folder; synchronous, so that at startup the scripts are ready before the first page loads
function readUserscriptFolder () {
  const locale = app.getLocale()
  const registry = getUserscriptRegistry()
  const scripts = []

  try {
    fs.readdirSync(userscriptDir).filter(file => file.endsWith('.js')).sort().forEach(function (file) {
      try {
        const script = compileUserscript(file, fs.readFileSync(path.join(userscriptDir, file), 'utf-8'), locale)
        if (!script) {
          return
        }
        script.enabled = !(registry[file] && registry[file].enabled === false)
        script.missing = getMissingUserscriptDependencies(script)
        if (script.missing.length === 0) {
          prepareUserscriptCode(script, registry[file])
        }
        scripts.push(script)
      } catch (e) {
        console.warn('failed to load userscript ' + file, e)
      }
    })
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('failed to load userscripts', e)
    }
  }

  return scripts
}

// the installed scripts, also while userscripts are off
function getKnownUserscripts () {
  return userscriptsEnabled ? loadedUserscripts : readUserscriptFolder()
}

function loadUserscripts () {
  loadedUserscripts = readUserscriptFolder()
  sendUserscriptListToWindows()
  notifyUserscriptPages()
  downloadMissingUserscriptDependencies()
}

function stopUserscriptWatcher () {
  clearTimeout(userscriptReloadTimer)
  if (userscriptDirWatcher) {
    userscriptDirWatcher.close()
    userscriptDirWatcher = null
  }
}

function startUserscriptWatcher () {
  stopUserscriptWatcher()
  try {
    // editors often save in several steps, so wait for changes to settle
    userscriptDirWatcher = fs.watch(userscriptDir, function (eventType, filename) {
      if (filename && !filename.endsWith('.js')) {
        return
      }
      clearTimeout(userscriptReloadTimer)
      userscriptReloadTimer = setTimeout(function () {
        if (userscriptsEnabled) {
          loadUserscripts()
        }
      }, 300)
    })
    userscriptDirWatcher.on('error', stopUserscriptWatcher)
  } catch (e) {
    console.warn('failed to watch the userscripts directory', e)
  }
}

app.whenReady().then(function () {
  settings.listen('userscriptsEnabled', function (value) {
    const enabled = value === true
    if (enabled === userscriptsEnabled) {
      return
    }
    userscriptsEnabled = enabled

    if (enabled) {
      try {
        fs.mkdirSync(userscriptDir, { recursive: true })
      } catch (e) {}
      startUserscriptWatcher()
      loadUserscripts()
      scheduleUserscriptUpdateCheck(USERSCRIPT_FIRST_UPDATE_CHECK_DELAY)
    } else {
      stopUserscriptWatcher()
      stopUserscriptUpdateChecks()
      loadedUserscripts = []
      sendUserscriptListToWindows()
      notifyUserscriptPages()
    }
  })
})

/* Frames running scripts that have Greasemonkey functions, so replies and value changes can reach them,
   and so a request for a script's function is only accepted from a frame that runs it.
   Frames are identified as "processId:routingId". */

const userscriptFrames = new Map() // script id: Set of frame keys

function getUserscriptFrameKey (frame) {
  return frame.processId + ':' + frame.routingId
}

function getUserscriptFrame (key) {
  const ids = key.split(':').map(Number)
  try {
    const frame = electron.webFrameMain.fromId(ids[0], ids[1])
    if (frame && !frame.detached) {
      return frame
    }
  } catch (e) {}
  return null
}

function sendToUserscriptFrame (frame, channel, data) {
  try {
    if (frame && !frame.detached) {
      frame.send(channel, data)
      return true
    }
  } catch (e) {}
  return false
}

function registerUserscriptFrame (scriptId, frame) {
  if (!userscriptFrames.has(scriptId)) {
    userscriptFrames.set(scriptId, new Set())
  }
  const frames = userscriptFrames.get(scriptId)
  if (frames.size > 50) {
    frames.forEach(function (key) {
      if (!getUserscriptFrame(key)) {
        frames.delete(key)
      }
    })
  }
  frames.add(getUserscriptFrameKey(frame))
}

// called when a frame loads a new document
function forgetUserscriptFrame (frame) {
  const key = getUserscriptFrameKey(frame)
  userscriptFrames.forEach(frames => frames.delete(key))
  userscriptMenuCommands.delete(key)
}

function forEachUserscriptFrame (scriptId, fn) {
  const frames = userscriptFrames.get(scriptId)
  if (!frames) {
    return
  }
  frames.forEach(function (key) {
    const frame = getUserscriptFrame(key)
    if (frame) {
      fn(frame, key)
    } else {
      frames.delete(key)
    }
  })
}

// the script a page's request is for, if the sending frame runs it and it grants api; otherwise null
function getUserscriptForRequest (event, scriptId, api) {
  const script = loadedUserscripts.find(script => script.id === scriptId)
  if (!script || !userscriptIsRunnable(script) || !event.senderFrame) {
    return null
  }
  const frames = userscriptFrames.get(scriptId)
  if (!frames || !frames.has(getUserscriptFrameKey(event.senderFrame))) {
    return null
  }
  if (api && !script.grants.includes(api)) {
    return null
  }
  return script
}

/* GM_getValue and friends: values are saved per script in userscriptData/values/<file name>.json as {key: JSON string}.
   They're sent to the page with the script, so reads are synchronous; writes come back here, are saved a second later,
   and are passed on to the script's other frames (GM_addValueChangeListener). */

const userscriptValues = new Map() // script id: {key: JSON string}
const userscriptValueSaveTimers = new Map()

function getUserscriptValuePath (id) {
  return path.join(userscriptValueDir, encodeURIComponent(id) + '.json')
}

function getUserscriptValues (id) {
  if (!userscriptValues.has(id)) {
    let values = {}
    try {
      values = JSON.parse(fs.readFileSync(getUserscriptValuePath(id), 'utf-8'))
    } catch (e) {}
    userscriptValues.set(id, values)
  }
  return userscriptValues.get(id)
}

function saveUserscriptValues (id) {
  clearTimeout(userscriptValueSaveTimers.get(id))
  userscriptValueSaveTimers.delete(id)
  try {
    writeUserscriptFile(getUserscriptValuePath(id), JSON.stringify(getUserscriptValues(id)))
  } catch (e) {
    console.warn('failed to save userscript values', e)
  }
}

function deleteUserscriptValues (id) {
  clearTimeout(userscriptValueSaveTimers.get(id))
  userscriptValueSaveTimers.delete(id)
  userscriptValues.delete(id)
  fs.rm(getUserscriptValuePath(id), { force: true }, function () {})
}

app.on('will-quit', function () {
  Array.from(userscriptValueSaveTimers.keys()).forEach(saveUserscriptValues)
})

ipc.on('userscripts-set-values', function (event, args) {
  const script = getUserscriptForRequest(event, args && args.scriptId)
  if (!script || !script.grants.some(api => USERSCRIPT_VALUE_APIS.includes(api)) || !args.changes) {
    return
  }
  const values = getUserscriptValues(script.id)
  Object.keys(args.changes).forEach(function (key) {
    if (typeof args.changes[key] === 'string') {
      values[key] = args.changes[key]
    } else {
      delete values[key]
    }
  })
  if (!userscriptValueSaveTimers.has(script.id)) {
    userscriptValueSaveTimers.set(script.id, setTimeout(() => saveUserscriptValues(script.id), 1000))
  }

  const senderKey = getUserscriptFrameKey(event.senderFrame)
  forEachUserscriptFrame(script.id, function (frame, key) {
    if (key !== senderKey) {
      sendToUserscriptFrame(frame, 'userscripts-values-changed', { scriptId: script.id, changes: args.changes })
    }
  })
})

function getUserscriptPayload (script, isPrivate) {
  if (script.legacy) {
    return { id: script.id, name: script.name, runAt: script.runAt, legacy: true, code: script.code }
  }
  const payload = {
    id: script.id,
    name: script.name,
    runAt: script.runAt,
    code: script.code,
    params: script.params,
    grants: script.grants,
    info: Object.assign({}, script.info, { isIncognito: isPrivate })
  }
  if (script.grants.some(api => USERSCRIPT_VALUE_APIS.includes(api))) {
    payload.values = getUserscriptValues(script.id)
  }
  return payload
}

function getUserscriptsForFrame (event) {
  const frame = event.senderFrame
  if (!frame) {
    return null
  }
  forgetUserscriptFrame(frame)
  if (loadedUserscripts.length === 0) {
    return null
  }
  const isPrivate = !event.sender.session.isPersistent()
  if (isPrivate && settings.get('userscriptsInPrivateTabs') !== true) {
    return null
  }
  // the frame's URL as the main process knows it, rather than one the renderer reports
  const url = frame.url
  const isTopFrame = !frame.parent
  const scripts = loadedUserscripts.filter(function (script) {
    return userscriptIsRunnable(script) && script.runAt !== 'context-menu' && (isTopFrame || !script.noframes) && userscriptMatchesURL(script.matcher, url)
  })
  if (scripts.length === 0) {
    return null
  }
  return scripts.map(function (script) {
    if (!script.legacy) {
      registerUserscriptFrame(script.id, frame)
    }
    return getUserscriptPayload(script, isPrivate)
  })
}

// sent synchronously by js/preload/userscripts.js at document start, so it must always reply
ipc.on('userscripts-get', function (event) {
  let result = null
  try {
    result = getUserscriptsForFrame(event)
  } catch (e) {
    console.warn('failed to match userscripts', e)
  }
  event.returnValue = result
})

ipc.handle('userscripts-list', function (event) {
  if (!windows.windowFromContents(event.sender)) {
    return []
  }
  return getUserscriptList()
})

// runs a script on demand (the !run bang and the page context menu), in the tab's main frame
ipc.handle('userscripts-run', function (event, args) {
  if (!windows.windowFromContents(event.sender) || !args) {
    return
  }
  const view = viewMap[args.tabId]
  const script = loadedUserscripts.find(script => script.id === args.scriptId)
  if (!view || view.webContents.isDestroyed() || !script || !userscriptIsRunnable(script)) {
    return
  }
  const frame = view.webContents.mainFrame
  if (!userscriptCanRunOnURL(frame.url)) {
    return
  }
  if (!script.legacy) {
    registerUserscriptFrame(script.id, frame)
  }
  sendToUserscriptFrame(frame, 'userscripts-run-script', getUserscriptPayload(script, !view.webContents.session.isPersistent()))
})

/* GM_registerMenuCommand: the commands are shown in the page's context menu (js/webviewMenu.js). */

const userscriptMenuCommands = new Map() // frame key: {webContentsId, commands: [{scriptId, scriptName, id, caption}]}

ipc.on('userscripts-menu-command-add', function (event, args) {
  const script = getUserscriptForRequest(event, args && args.scriptId, 'registerMenuCommand')
  if (!script) {
    return
  }
  const key = getUserscriptFrameKey(event.senderFrame)
  const entry = userscriptMenuCommands.get(key) || { webContentsId: event.sender.id, commands: [] }
  entry.commands = entry.commands.filter(command => !(command.scriptId === script.id && command.id === String(args.id)))
  entry.commands.push({ scriptId: script.id, scriptName: script.name, id: String(args.id), caption: String(args.caption).slice(0, 200) })
  userscriptMenuCommands.set(key, entry)
})

ipc.on('userscripts-menu-command-remove', function (event, args) {
  const entry = event.senderFrame && userscriptMenuCommands.get(getUserscriptFrameKey(event.senderFrame))
  if (entry && args) {
    entry.commands = entry.commands.filter(command => !(command.scriptId === args.scriptId && command.id === String(args.id)))
  }
})

ipc.handle('userscripts-menu-commands', function (event, tabId) {
  const view = viewMap[tabId]
  if (!windows.windowFromContents(event.sender) || !view || view.webContents.isDestroyed()) {
    return []
  }
  const list = []
  userscriptMenuCommands.forEach(function (entry, key) {
    if (entry.webContentsId !== view.webContents.id) {
      return
    }
    if (!getUserscriptFrame(key)) {
      userscriptMenuCommands.delete(key)
      return
    }
    entry.commands.forEach(command => list.push(Object.assign({ frameKey: key }, command)))
  })
  return list
})

ipc.handle('userscripts-menu-command-run', function (event, args) {
  const view = args && viewMap[args.tabId]
  const entry = args && userscriptMenuCommands.get(args.frameKey)
  if (!windows.windowFromContents(event.sender) || !view || !entry || entry.webContentsId !== view.webContents.id) {
    return
  }
  sendToUserscriptFrame(getUserscriptFrame(args.frameKey), 'userscripts-menu-command', { scriptId: args.scriptId, id: args.id })
})
