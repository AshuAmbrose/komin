var pendingPermissions = []
var grantedPermissions = []
var sessionPermissions = []
var activeMediaByContents = new Map()
var nextPermissionId = 1

function updateActiveMediaPermissions (contents, kind, isActive) {
  if (!contents || contents.isDestroyed()) {
    return
  }

  let record = activeMediaByContents.get(contents)
  if (!record) {
    if (!isActive) {
      return
    }
    let tabId = getTabIDFromWebContents(contents)
    let origin = ''
    try {
      origin = new URL(contents.getURL()).hostname
    } catch (e) {}
    record = {
      tabId: tabId,
      origin: origin,
      audio: 0,
      video: 0,
      screen: 0
    }
    activeMediaByContents.set(contents, record)
  }

  if (isActive) {
    record[kind] = (record[kind] || 0) + 1
    // a tab that starts using the camera, microphone or screen gets normal memory priority back straight away
    if (typeof restoreTabMemoryPriority === 'function') {
      restoreTabMemoryPriority(contents)
    }
  } else {
    record[kind] = Math.max(0, (record[kind] || 0) - 1)
  }

  const currentTabId = getTabIDFromWebContents(contents)
  if (currentTabId) {
    record.tabId = currentTabId
  }
  if (!record.origin) {
    try {
      record.origin = new URL(contents.getURL()).hostname
    } catch (e) {}
  }

  // Rebuild grantedPermissions for this contents to only reflect currently active media capture
  grantedPermissions = grantedPermissions.filter(p => p.contents !== contents)

  if (record.audio > 0) {
    grantedPermissions.push({
      permissionId: nextPermissionId++,
      tabId: record.tabId,
      contents: contents,
      origin: record.origin,
      permission: 'media',
      details: { mediaTypes: ['audio'] },
      granted: true
    })
  }

  if (record.video > 0) {
    grantedPermissions.push({
      permissionId: nextPermissionId++,
      tabId: record.tabId,
      contents: contents,
      origin: record.origin,
      permission: 'media',
      details: { mediaTypes: ['video'] },
      granted: true
    })
  }

  if (record.screen > 0) {
    grantedPermissions.push({
      permissionId: nextPermissionId++,
      tabId: record.tabId,
      contents: contents,
      origin: record.origin,
      permission: 'display-capture',
      details: {},
      granted: true
    })
  }

  if (record.audio === 0 && record.video === 0 && record.screen === 0) {
    activeMediaByContents.delete(contents)
  }

  sendPermissionsToRenderers()
}

ipc.on('media-access-status', function (e, data) {
  if (data && typeof data.kind === 'string' && typeof data.active === 'boolean') {
    updateActiveMediaPermissions(e.sender, data.kind, data.active)
  }
})

function getPersistentPermissions () {
  return settings.get('sitePermissions') || {}
}

function setPersistentPermission (origin, permission, state) {
  var sitePermissions = Object.assign({}, settings.get('sitePermissions') || {})
  if (!sitePermissions[origin]) {
    sitePermissions[origin] = {}
  }
  sitePermissions[origin][permission] = state
  settings.set('sitePermissions', sitePermissions)
}

/*
All permission requests are given to the renderer on each change,
it will figure out what updates to make
*/
function sendPermissionsToRenderers () {
  // send all requests to all windows - the tab bar in each will figure out what to display
  windows.getAll().forEach(function (win) {
    sendIPCToWindow(win, 'updatePermissions', pendingPermissions.concat(grantedPermissions).map(p => {
      // remove properties that can't be serialized over IPC
      return {
        permissionId: p.permissionId,
        tabId: p.tabId,
        origin: p.origin,
        permission: p.permission,
        details: p.details,
        granted: p.granted
      }
    }))
  })
}

function removePermissionsForContents (contents) {
  // Reject any pending callbacks for this contents so they don't hang
  pendingPermissions.filter(perm => perm.contents === contents).forEach(perm => {
    if (typeof perm.callback === 'function') {
      try { perm.callback(false) } catch (err) {}
    }
    if (typeof perm.displayMediaCallback === 'function') {
      try { perm.displayMediaCallback({ video: null }) } catch (err) {}
    }
  })

  pendingPermissions = pendingPermissions.filter(perm => perm.contents !== contents)
  grantedPermissions = grantedPermissions.filter(perm => perm.contents !== contents)
  activeMediaByContents.delete(contents)

  sendPermissionsToRenderers()
}

/*
Was permission already granted for this origin?
*/
function isPermissionGrantedForOrigin (requestOrigin, requestPermission, requestDetails, ses) {
  // Check persistent settings if this is a persistent session (or the session is unknown)
  if (!ses || ses.isPersistent()) {
    var sitePermissions = getPersistentPermissions()
    var originPermissions = sitePermissions[requestOrigin]
    if (originPermissions) {
      if (requestPermission === 'notifications' && originPermissions.notifications === 'allow') {
        return true
      }

      if (requestPermission === 'pointerLock' && originPermissions.pointerLock === 'allow') {
        return true
      }

      if (requestPermission === 'media') {
        if (requestDetails.mediaType) {
          if (originPermissions['media:' + requestDetails.mediaType] === 'allow') {
            return true
          }
        } else if (requestDetails.mediaTypes && requestDetails.mediaTypes.length > 0) {
          if (requestDetails.mediaTypes.every(type => originPermissions['media:' + type] === 'allow')) {
            return true
          }
        } else if (originPermissions['media:audio'] === 'allow' || originPermissions['media:video'] === 'allow') {
          return true
        }
      }
    }
  }

  // Also check session-scoped permissions (for ephemeral private tabs or session grants)
  // these only apply to the session they were granted in, so private tabs and normal tabs don't share them
  for (var i = 0; i < sessionPermissions.length; i++) {
    if (ses && ses === sessionPermissions[i].session && requestOrigin === sessionPermissions[i].origin) {
      if (requestPermission === 'notifications' && sessionPermissions[i].permission === 'notifications') {
        return true
      }

      if (requestPermission === 'pointerLock' && sessionPermissions[i].permission === 'pointerLock') {
        return true
      }

      if (requestPermission === 'media' && sessionPermissions[i].permission === 'media') {
        // type 1: single media type
        if (requestDetails.mediaType && sessionPermissions[i].details.mediaTypes && sessionPermissions[i].details.mediaTypes.includes(requestDetails.mediaType)) {
          return true
        }
        // type 2: multiple media types
        if (requestDetails.mediaTypes && sessionPermissions[i].details.mediaTypes && requestDetails.mediaTypes.every(type => sessionPermissions[i].details.mediaTypes.includes(type))) {
          return true
        }
        // type 3: general media permission
        if (!requestDetails.mediaType && !requestDetails.mediaTypes && sessionPermissions[i].permission === 'media') {
          return true
        }
      }

      if (requestPermission === 'display-capture' && sessionPermissions[i].permission === 'display-capture') {
        return true
      }
    }
  }
  return false
}

/*
Was permission explicitly blocked for this origin?
*/
function isPermissionBlockedForOrigin (requestOrigin, requestPermission, requestDetails) {
  var sitePermissions = getPersistentPermissions()
  var originPermissions = sitePermissions[requestOrigin]
  if (!originPermissions) {
    return false
  }

  if (requestPermission === 'notifications' && originPermissions.notifications === 'block') {
    return true
  }

  if (requestPermission === 'pointerLock' && originPermissions.pointerLock === 'block') {
    return true
  }

  if (requestPermission === 'media') {
    if (requestDetails.mediaType && originPermissions['media:' + requestDetails.mediaType] === 'block') {
      return true
    }
    if (requestDetails.mediaTypes && requestDetails.mediaTypes.some(type => originPermissions['media:' + type] === 'block')) {
      return true
    }
  }

  return false
}

/*
Is there already a pending request of the given type for this origin?
*/
function hasPendingRequestForOrigin (requestOrigin, permission, details) {
  for (var i = 0; i < pendingPermissions.length; i++) {
    if (requestOrigin === pendingPermissions[i].origin && permission === pendingPermissions[i].permission) {
      return true
    }
  }
  return false
}

function pagePermissionRequestHandler (webContents, permission, callback, details) {
  if (permission === 'fullscreen') {
    callback(true)
    return
  }

  if (permission === 'clipboard-sanitized-write') {
    callback(true)
    return
  }

  // Allow display-capture permission check so Electron can invoke setDisplayMediaRequestHandler for source selection
  if (permission === 'display-capture') {
    callback(true)
    return
  }

  if (!details.requestingUrl) {
    callback(false)
    return
  }

  let requestOrigin
  try {
    requestOrigin = new URL(details.requestingUrl).hostname
  } catch (e) {
    // invalid URL
    console.warn(e, details.requestingUrl)
    callback(false)
    return
  }

  // If permission was explicitly blocked by the user, reject immediately
  if (isPermissionBlockedForOrigin(requestOrigin, permission, details)) {
    callback(false)
    return
  }

  if (permission === 'display-capture') {
    callback(true)
    return
  }

  /*
  Supported permissions: media, notifications, pointerLock
  */
  if (['media', 'notifications', 'pointerLock'].includes(permission)) {
    if (isPermissionGrantedForOrigin(requestOrigin, permission, details, webContents && webContents.session)) {
      callback(true)
    } else if (permission === 'notifications' && hasPendingRequestForOrigin(requestOrigin, permission, details)) {
      callback(false)
    } else {
      pendingPermissions.push({
        permissionId: nextPermissionId,
        tabId: getTabIDFromWebContents(webContents),
        contents: webContents,
        origin: requestOrigin,
        permission: permission,
        details: details,
        callback: callback
      })

      sendPermissionsToRenderers()
      nextPermissionId++
    }

    /*
    Once this view is navigated away or destroyed, clean up any pending requests
    */
    if (!webContents._hasPermissionCleanupListener) {
      webContents._hasPermissionCleanupListener = true
      webContents.on('did-start-navigation', function (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
        if (isMainFrame && !isInPlace) {
          removePermissionsForContents(webContents)
        }
      })
    }
    webContents.once('destroyed', function () {
      if (windows.getAll().length > 0) {
        removePermissionsForContents(webContents)
      }
    })
  } else {
    callback(false)
  }
}

function pagePermissionCheckHandler (webContents, permission, requestingOrigin, details) {
  if (details && details.embeddingOrigin && requestingOrigin && requestingOrigin !== details.embeddingOrigin) {
    return false
  }

  if (permission === 'clipboard-sanitized-write' || permission === 'display-capture') {
    return true
  }

  let requestHostname
  if (requestingOrigin) {
    try {
      requestHostname = new URL(requestingOrigin).hostname
    } catch (e) {
      console.warn(e, requestingOrigin)
    }
  }
  if (!requestHostname && details && details.securityOrigin) {
    try {
      requestHostname = new URL(details.securityOrigin).hostname
    } catch (e) {}
  }

  if (!requestHostname) {
    return false
  }

  if (isPermissionBlockedForOrigin(requestHostname, permission, details || {})) {
    return false
  }

  return isPermissionGrantedForOrigin(requestHostname, permission, details || {}, webContents && webContents.session)
}

function displayMediaRequestHandler (request, callback) {
  let requestOrigin = 'Site'
  if (request.securityOrigin) {
    try {
      requestOrigin = new URL(request.securityOrigin).hostname
    } catch (e) {
      requestOrigin = request.securityOrigin
    }
  }

  let contents = null
  if (request.frame && typeof webContents.fromFrame === 'function') {
    contents = webContents.fromFrame(request.frame)
  }
  let tabId = contents ? getTabIDFromWebContents(contents) : null

  // Fallback: If frame couldn't be resolved directly, find active tab in focused window
  if (!tabId) {
    const focusedWin = windows.getCurrent() || windows.getAll()[0]
    if (focusedWin) {
      const winState = windows.getState(focusedWin)
      if (winState && winState.selectedView) {
        tabId = winState.selectedView
        if (!contents && viewMap[tabId]) {
          contents = viewMap[tabId].webContents
        }
      }
    }
  }

  electron.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
    if (!sources || sources.length === 0) {
      callback({ video: null })
      return
    }

    const permissionId = nextPermissionId++

    const serializedSources = sources.map(s => ({
      id: s.id,
      name: s.name
    }))

    pendingPermissions.push({
      permissionId: permissionId,
      tabId: tabId,
      contents: contents,
      origin: requestOrigin,
      permission: 'display-capture',
      details: {
        sources: serializedSources,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested
      },
      displayMediaCallback: callback,
      availableSources: sources,
      audioRequested: request.audioRequested
    })

    sendPermissionsToRenderers()
  }).catch(err => {
    console.error('Error fetching display capture sources:', err)
    callback({ video: null })
  })
}

app.once('ready', function () {
  session.defaultSession.setPermissionRequestHandler(pagePermissionRequestHandler)
  session.defaultSession.setPermissionCheckHandler(pagePermissionCheckHandler)
  session.defaultSession.setDisplayMediaRequestHandler(displayMediaRequestHandler)
})

app.on('session-created', function (session) {
  session.setPermissionRequestHandler(pagePermissionRequestHandler)
  session.setPermissionCheckHandler(pagePermissionCheckHandler)
  session.setDisplayMediaRequestHandler(displayMediaRequestHandler)
})

ipc.on('permissionGranted', function (e, permissionData) {
  const permissionId = (typeof permissionData === 'object' && permissionData !== null) ? permissionData.permissionId : permissionData
  const chosenSourceId = (typeof permissionData === 'object' && permissionData !== null) ? permissionData.sourceId : null
  const shouldPersist = (typeof permissionData === 'object' && permissionData !== null && permissionData.persist !== undefined) ? !!permissionData.persist : true

  for (var i = 0; i < pendingPermissions.length; i++) {
    if (permissionId && pendingPermissions[i].permissionId === permissionId) {
      var perm = pendingPermissions[i]

      if (perm.permission === 'display-capture') {
        if (perm.displayMediaCallback) {
          var chosenSource = perm.availableSources ? perm.availableSources.find(s => s.id === chosenSourceId) || perm.availableSources[0] : null
          if (chosenSource) {
            const streamConfig = { video: chosenSource }
            if (perm.audioRequested && process.platform === 'win32') {
              streamConfig.audio = 'loopback'
            }
            perm.displayMediaCallback(streamConfig)
          } else {
            perm.displayMediaCallback({ video: null })
          }
        }
      } else {
        if (perm.callback) {
          perm.callback(true)
        }

        // Persist permission if requested and session is persistent
        const isPersistent = shouldPersist && perm.contents && perm.contents.session ? perm.contents.session.isPersistent() : false
        if (isPersistent && perm.origin) {
          if (perm.permission === 'notifications') {
            setPersistentPermission(perm.origin, 'notifications', 'allow')
          } else if (perm.permission === 'pointerLock') {
            setPersistentPermission(perm.origin, 'pointerLock', 'allow')
          } else if (perm.permission === 'media') {
            var types = (perm.details && perm.details.mediaTypes) || (perm.details && perm.details.mediaType ? [perm.details.mediaType] : ['audio', 'video'])
            types.forEach(t => {
              setPersistentPermission(perm.origin, 'media:' + t, 'allow')
            })
          }
        }
      }

      sessionPermissions.push({
        session: perm.contents && !perm.contents.isDestroyed() ? perm.contents.session : null,
        origin: perm.origin,
        permission: perm.permission,
        details: perm.details
      })
      pendingPermissions.splice(i, 1)

      sendPermissionsToRenderers()
      break
    }
  }
})

ipc.on('permissionDenied', function (e, permissionData) {
  const permissionId = (typeof permissionData === 'object' && permissionData !== null) ? permissionData.permissionId : permissionData
  const shouldBlock = (typeof permissionData === 'object' && permissionData !== null) ? !!permissionData.block : false

  for (var i = 0; i < pendingPermissions.length; i++) {
    if (permissionId && pendingPermissions[i].permissionId === permissionId) {
      var perm = pendingPermissions[i]

      if (perm.permission === 'display-capture') {
        if (perm.displayMediaCallback) {
          perm.displayMediaCallback({ video: null })
        }
      } else {
        if (perm.callback) {
          perm.callback(false)
        }

        const isPersistent = perm.contents && perm.contents.session ? perm.contents.session.isPersistent() : true
        if (shouldBlock && isPersistent && perm.origin) {
          if (perm.permission === 'notifications') {
            setPersistentPermission(perm.origin, 'notifications', 'block')
          } else if (perm.permission === 'pointerLock') {
            setPersistentPermission(perm.origin, 'pointerLock', 'block')
          } else if (perm.permission === 'media') {
            var types = (perm.details && perm.details.mediaTypes) || (perm.details && perm.details.mediaType ? [perm.details.mediaType] : ['audio', 'video'])
            types.forEach(t => {
              setPersistentPermission(perm.origin, 'media:' + t, 'block')
            })
          }
        }
      }

      if (shouldBlock && perm.origin) {
        const permSession = perm.contents && !perm.contents.isDestroyed() ? perm.contents.session : null
        sessionPermissions = sessionPermissions.filter(p => p.session !== permSession || p.origin !== perm.origin || p.permission !== perm.permission)
      }

      pendingPermissions.splice(i, 1)
      sendPermissionsToRenderers()
      break
    }
  }
})
