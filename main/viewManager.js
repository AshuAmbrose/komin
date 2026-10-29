var viewMap = {} // id: view
var viewStateMap = {} // id: view state
var tabLastActivity = {} // id: timestamp

var temporaryPopupViews = {} // id: view

// rate limit on "open in app" requests
var globalLaunchRequests = 0

function getDefaultViewWebPreferences () {
  return (
    {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      scrollBounce: true,
      safeDialogs: true,
      safeDialogsMessage: 'Prevent this page from creating additional dialogs',
      preload: __dirname + '/dist/preload.js',
      contextIsolation: true,
      sandbox: true,
      enableRemoteModule: false,
      allowPopups: false,
      // partition: partition || 'persist:webcontent',
      enableWebSQL: false,
      backgroundThrottling: true,
      autoplayPolicy: (settings.get('enableAutoplay') ? 'no-user-gesture-required' : 'user-gesture-required'),
      // match Chrome's default for anti-fingerprinting purposes (Electron defaults to 0)
      minimumFontSize: 6,
      javascript: !(settings.get('filtering')?.contentTypes?.includes('script'))
    }
  )
}

function createView (existingViewId, id, webPreferences, boundsString, events) {
  if (viewStateMap[id]) {
    console.warn("Creating duplicate view")
  }

  const viewPrefs = Object.assign({}, getDefaultViewWebPreferences(), webPreferences)

  viewStateMap[id] = {
    loadedInitialURL: false,
    hasJS: viewPrefs.javascript // need this later to see if we should swap the view for a JS-enabled one
  }

  let view
  if (existingViewId) {
    view = temporaryPopupViews[existingViewId]
    delete temporaryPopupViews[existingViewId]

    // the initial URL has already been loaded, so set the background color
    view.setBackgroundColor('#fff')
    viewStateMap[id].loadedInitialURL = true
  } else {
    view = new WebContentsView({ webPreferences: viewPrefs })
  }

  events.forEach(function (event) {
    view.webContents.on(event, function (e) {
      var args = Array.prototype.slice.call(arguments).slice(1)

      if ((event === 'did-start-navigation' || event === 'will-redirect') && args[2] === false) {
        return
      }
      if (event === 'did-navigate-in-page' && args[1] === false) {
        return
      }

      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      if (!eventTarget) {
        //this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
        return
      }

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: event,
        args: args
      })
    })
  })

  view.webContents.on('select-bluetooth-device', function (event, deviceList, callback) {
    event.preventDefault()
    callback('')
  })

  view.webContents.setWindowOpenHandler(function (details) {
    if (details.url && !filterPopups(details.url)) {
      return {
        action: 'deny'
      }
    }

    /*
      Opening a popup with window.open() generally requires features to be set
      So if there are no features, the event is most likely from clicking on a link, which should open a new tab.
      Clicking a link can still have a "new-window" or "foreground-tab" disposition depending on which keys are pressed
      when it is clicked.
      (https://github.com/minbrowser/min/issues/1835)
    */
    if (details.url && details.url !== 'about:blank' && !details.features) {
      const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

      getWindowWebContents(eventTarget).send('view-event', {
        tabId: id,
        event: 'new-tab',
        args: [details.url, !(details.disposition === 'background-tab')]
      })
      return {
        action: 'deny'
      }
    }

    return {
      action: 'allow',
      createWindow: function (options) {
        const view = new WebContentsView({ webPreferences: getDefaultViewWebPreferences(), webContents: options.webContents })

        var popupId = Math.random().toString()
        temporaryPopupViews[popupId] = view

        const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

        getWindowWebContents(eventTarget).send('view-event', {
          tabId: id,
          event: 'did-create-popup',
          args: [popupId, details.url]
        })

        return view.webContents
      }
    }
  })

  view.webContents.on('ipc-message', function (e, channel, data) {
    var senderURL
    try {
      senderURL = e.senderFrame.url
    } catch (err) {
      // https://github.com/minbrowser/min/issues/2052
      console.warn('dropping message because senderFrame is destroyed', channel, data, err)
      return
    }

    const eventTarget = getWindowFromViewContents(view.webContents) || windows.getCurrent()

    if (!eventTarget) {
      //this can happen during shutdown - windows can be destroyed before the corresponding views, and the view can emit an event during that time
      return
    }

    getWindowWebContents(eventTarget).send('view-ipc', {
      id: id,
      name: channel,
      data: data,
      frameId: e.frameId,
      frameURL: senderURL
    })
  })

  // Open a login prompt when site asks for http authentication
  view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') { // Only for basic auth
      return
    }
    event.preventDefault()
    var title = l('loginPromptTitle').replace('%h', authInfo.host)
    createPrompt({
      text: title,
      values: [{ placeholder: l('username'), id: 'username', type: 'text' },
        { placeholder: l('password'), id: 'password', type: 'password' }],
      ok: l('dialogConfirmButton'),
      cancel: l('dialogSkipButton'),
      width: 400,
      height: 200
    }, function (result) {
      // resend request with auth credentials
      callback(result.username, result.password)
    })
  })

  // show an "open in app" prompt for external protocols

  function handleExternalProtocol (e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
    var knownProtocols = ['http', 'https', 'file', 'min', 'about', 'data', 'javascript', 'chrome'] // TODO anything else?
    if (!knownProtocols.includes(url.split(':')[0])) {
      var externalApp = app.getApplicationNameForProtocol(url)
      if (externalApp) {
        var sanitizedName = externalApp.replace(/[^a-zA-Z0-9.]/g, '')
        if (globalLaunchRequests < 2) {
          globalLaunchRequests++
          setTimeout(function () {
            globalLaunchRequests--
          }, 20000)
          var result = electron.dialog.showMessageBoxSync({
            type: 'question',
            buttons: ['OK', 'Cancel'],
            message: l('openExternalApp').replace('%s', sanitizedName).replace(/\\/g, ''),
            detail: url.length > 160 ? url.substring(0, 160) + '...' : url
          })

          if (result === 0) {
            electron.shell.openExternal(url)
          }
        }
      }
    }
  }

  view.webContents.on('did-start-navigation', handleExternalProtocol)
  /*
  It's possible for an HTTP request to redirect to an external app link
  (primary use case for this is OAuth from desktop app > browser > back to app)
  and did-start-navigation isn't (always?) emitted for redirects, so we need this handler as well
  */
  view.webContents.on('will-redirect', handleExternalProtocol)

  /*
  the JS setting can only be set when the view is created, so swap the view on navigation if the setting value changed
  This can occur if the user manually changed the setting, or if we are navigating between an internal page (always gets JS)
  and an external one
  */
  view.webContents.on('did-start-navigation', function (event) {
    if (event.isMainFrame && !event.isSameDocument) {
      const hasJS = viewStateMap[id].hasJS
      const shouldHaveJS = (!(settings.get('filtering')?.contentTypes?.includes('script'))) || event.url.startsWith('min://')
      if (hasJS !== shouldHaveJS) {
        setTimeout(function () {
          view.webContents.stop()
          const currentWindow = getWindowFromViewContents(view.webContents)
          destroyView(id)
          const newView = createView(existingViewId, id, Object.assign({}, webPreferences, { javascript: shouldHaveJS }), boundsString, events)
          loadURLInView(id, event.url, currentWindow)

          if (currentWindow) {
            setView(id, getWindowWebContents(currentWindow))
            focusView(id)
          }
        }, 0)
      }
    }
  })

  view.setBounds(JSON.parse(boundsString))

  viewMap[id] = view
  tabLastActivity[id] = Date.now()

  return view
}

function destroyView (id) {
  if (!viewMap[id]) {
    return
  }

  windows.getAll().forEach(function (window) {
    if (windows.getState(window).selectedView === id) {
      window.getContentView().removeChildView(viewMap[id])
      windows.getState(window).selectedView = null
    }
  })
  viewMap[id].webContents.destroy()

  delete viewMap[id]
  delete viewStateMap[id]
  delete tabLastActivity[id]
}

function destroyAllViews () {
  for (const id in viewMap) {
    destroyView(id)
  }
}

function setView (id, senderContents) {
  const win = windows.windowFromContents(senderContents).win

  // changing views can cause flickering, so we only want to call it if the view is actually changing
  // see https://github.com/minbrowser/min/issues/1966
  const previousId = windows.getState(win).selectedView
  if (previousId !== id) {
    if (previousId) {
      tabLastActivity[previousId] = Date.now()
    }
    tabLastActivity[id] = Date.now()

    //remove all prior views
    win.getContentView().children.slice(1).forEach(child => win.getContentView().removeChildView(child))
    if (viewStateMap[id].loadedInitialURL) {
      win.getContentView().addChildView(viewMap[id])
    } else {
      win.getContentView().removeChildView(viewMap[id])
    }
    windows.getState(win).selectedView = id
    restoreTabMemoryPriority(viewMap[id].webContents)

    if (typeof scheduleInactiveTabTrim === 'function') {
      scheduleInactiveTabTrim()
    }
  }
}

function setBounds (id, bounds) {
  if (viewMap[id]) {
    viewMap[id].setBounds(bounds)
  }
}

function focusView (id) {
  // empty views can't be focused because they won't propogate keyboard events correctly, see https://github.com/minbrowser/min/issues/616
  // also, make sure the view exists, since it might not if the app is shutting down
  if (viewMap[id] && (viewMap[id].webContents.getURL() !== '' || viewMap[id].webContents.isLoading())) {
    viewMap[id].webContents.focus()
    return true
  } else if (getWindowFromViewContents(viewMap[id]?.webContents)) {
    getWindowWebContents(getWindowFromViewContents(viewMap[id]?.webContents)).focus()
    return true
  }
}

function hideCurrentView (senderContents) {
  const win = windows.windowFromContents(senderContents).win
  const currentId = windows.getState(win).selectedView
  if (currentId) {
    win.getContentView().removeChildView(viewMap[currentId])
    windows.getState(win).selectedView = null
    if (win.isFocused()) {
      getWindowWebContents(win).focus()
    }
  }
}

function getView (id) {
  return viewMap[id]
}

function getTabIDFromWebContents (contents) {
  for (var id in viewMap) {
    if (viewMap[id].webContents === contents) {
      return id
    }
  }
}

function getWindowFromViewContents (webContents) {
  const viewId = Object.keys(viewMap).find(id => viewMap[id].webContents === webContents)
  return windows.getAll().find(win => windows.getState(win).selectedView === viewId)
}

ipc.on('createView', function (e, args) {
  createView(args.existingViewId, args.id, args.webPreferences, args.boundsString, args.events)
})

ipc.on('destroyView', function (e, id) {
  destroyView(id)
})

ipc.on('destroyAllViews', function () {
  destroyAllViews()
})

ipc.on('setView', function (e, args) {
  setView(args.id, e.sender)
  setBounds(args.id, args.bounds)
  const targetWin = windows.windowFromContents(e.sender)?.win
  if (args.focus && targetWin && targetWin.isFocused()) {
    const couldFocus = focusView(args.id)
    if (!couldFocus) {
      e.sender.focus()
    }
  }
})

ipc.on('setBounds', function (e, args) {
  setBounds(args.id, args.bounds)
})

ipc.on('focusView', function (e, id) {
  focusView(id)
})

ipc.on('hideCurrentView', function (e) {
  hideCurrentView(e.sender)
})

function loadURLInView (id, url, win) {
  // wait until the first URL is loaded to set the background color so that new tabs can use a custom background
  if (!viewStateMap[id].loadedInitialURL) {
    // Give the site a chance to display something before setting the background, in case it has its own dark theme
    viewMap[id].webContents.once('dom-ready', function() {
      viewMap[id].setBackgroundColor('#fff')
    })
    // If the view has no URL, it won't be attached yet
    if (win && id === windows.getState(win).selectedView) {
      win.getContentView().addChildView(viewMap[id])
    }
  }
  viewMap[id].webContents.loadURL(url)
  viewStateMap[id].loadedInitialURL = true
}

ipc.on('loadURLInView', function (e, args) {
  const win = windows.windowFromContents(e.sender)?.win
  loadURLInView(args.id, args.url, win)
})

ipc.on('callViewMethod', function (e, data) {
  var error, result
  try {
    var webContents = viewMap[data.id].webContents
    var methodOrProp = webContents[data.method]
    if (methodOrProp instanceof Function) {
      // call function
      result = methodOrProp.apply(webContents, data.args)
    } else {
      // set property
      if (data.args && data.args.length > 0) {
        webContents[data.method] = data.args[0]
      }
      // read property
      result = methodOrProp
    }
  } catch (e) {
    error = e
  }
  if (result instanceof Promise) {
    result.then(function (result) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error: null, result })
      }
    })
    result.catch(function (error) {
      if (data.callId) {
        e.sender.send('async-call-result', { callId: data.callId, error, result: null })
      }
    })
  } else if (data.callId) {
    e.sender.send('async-call-result', { callId: data.callId, error, result })
  }
})

ipc.handle('getNavigationHistory', function (e, id) {
  if (!viewMap[id]?.webContents) {
    return null
  }
  const entries = []
  const activeIndex = viewMap[id].webContents.navigationHistory.getActiveIndex()
  const size = viewMap[id].webContents.navigationHistory.length()

  for (let i = 0; i < size; i++) {
    entries.push(viewMap[id].webContents.navigationHistory.getEntryAtIndex(i))
  }

  return {
    activeIndex,
    entries
  }
})

ipc.on('getCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
    return
  }

  view.webContents.capturePage().then(function (img) {
    var size = img.getSize()
    if (size.width === 0 && size.height === 0) {
      return
    }
    img = img.resize({ width: data.width, height: data.height })
    e.sender.send('captureData', { id: data.id, url: img.toDataURL() })
  })
})

ipc.on('saveViewCapture', function (e, data) {
  var view = viewMap[data.id]
  if (!view) {
    // view could have been destroyed
  }

  view.webContents.capturePage().then(function (image) {
    view.webContents.downloadURL(image.toDataURL())
  })
})

global.getView = getView

/* In-Use Memory Optimization & Smart Two-Tier Hibernation */

const INACTIVE_TAB_TRIM_DELAY = 30000 // 30s debounce after becoming inactive
const HIBERNATION_IDLE_TIME = 15 * 60 * 1000 // 15 minutes before disposable tab deep sleep
let inactiveTabTrimTimeout = null
let inactiveTabTrimInterval = null
let hibernationCheckInterval = null
// renderer processes given low memory priority while their tabs are in the background (Windows only)
const lowMemoryPriorityPids = new Set()

// OS process ids of every frame in a page, including cross-site iframes (ads, embeds) that run in their own processes
function getFramePids (contents) {
  try {
    return contents.mainFrame.framesInSubtree.map(frame => frame.osProcessId)
  } catch (e) {
    return [contents.getOSProcessId()]
  }
}

// splits tab processes into inactive ones (to trim and give low memory priority) and protected ones (left alone)
function getTabProcessGroups () {
  const activeViewIds = new Set()
  windows.getAll().forEach(function (win) {
    const selected = windows.getState(win)?.selectedView
    if (selected) {
      activeViewIds.add(selected)
    }
  })

  const now = Date.now()
  const inactivePids = new Set()
  // a process can be shared between tabs, so one that also serves a protected tab (or the browser UI) is never trimmed
  const protectedPids = new Set()

  windows.getAll().forEach(function (win) {
    protectedPids.add(getWindowWebContents(win).getOSProcessId())
  })

  for (const tabId in viewMap) {
    const view = viewMap[tabId]
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      continue
    }
    const pids = getFramePids(view.webContents)
    const lastActive = tabLastActivity[tabId] || 0
    if (
      // 1. Foreground active tab is strictly protected
      activeViewIds.has(tabId) ||
      // 2. Protect tabs playing audio, active media, or capturing screen/voice
      (typeof isTabActiveWithMedia === 'function' && isTabActiveWithMedia(view.webContents)) ||
      // 3. Tab must be inactive for at least INACTIVE_TAB_TRIM_DELAY
      now - lastActive < INACTIVE_TAB_TRIM_DELAY
    ) {
      pids.forEach(pid => protectedPids.add(pid))
    } else {
      pids.forEach(pid => inactivePids.add(pid))
    }
  }

  return {
    inactivePids: [...inactivePids].filter(pid => pid && !protectedPids.has(pid)),
    protectedPids: [...protectedPids]
  }
}

// gives processes that were lowered while their tab was in the background normal memory priority again
function restoreMemoryPriority (pids) {
  const lowered = pids.filter(pid => lowMemoryPriorityPids.has(pid))
  if (lowered.length === 0) {
    return
  }
  lowered.forEach(pid => lowMemoryPriorityPids.delete(pid))

  const trimmerPath = path.join(__dirname, 'ext/windows/trimMemory.exe')
  if (fs.existsSync(trimmerPath)) {
    execFile(trimmerPath, ['--no-trim', '--memory-priority', 'normal'].concat(lowered.map(String)), { windowsHide: true }, function () {})
  }
}

// called when a tab is selected, or starts playing media or capturing
function restoreTabMemoryPriority (contents) {
  if (contents && !contents.isDestroyed()) {
    restoreMemoryPriority(getFramePids(contents))
  }
}

function trimInactiveTabsNow () {
  if (process.platform !== 'win32') {
    return
  }
  const { inactivePids, protectedPids } = getTabProcessGroups()

  // forget processes that have exited, and restore any lowered process whose tab is protected again
  const livePids = new Set(app.getAppMetrics().map(m => m.pid))
  lowMemoryPriorityPids.forEach(pid => { if (!livePids.has(pid)) lowMemoryPriorityPids.delete(pid) })
  restoreMemoryPriority(protectedPids)

  // Pause if file downloads are active
  if (typeof hasActiveDownloads === 'function' && hasActiveDownloads()) {
    return
  }
  if (inactivePids.length === 0) {
    return
  }

  const trimmerPath = path.join(__dirname, 'ext/windows/trimMemory.exe')
  if (fs.existsSync(trimmerPath)) {
    // Empty working set exclusively for inactive tabs' renderer processes, including their cross-site frames.
    // Low memory priority makes Windows reuse their memory first when another program needs it
    execFile(trimmerPath, ['--memory-priority', 'low'].concat(inactivePids.map(String)), { windowsHide: true }, function () {})
    inactivePids.forEach(pid => lowMemoryPriorityPids.add(pid))
  }
}

function scheduleInactiveTabTrim () {
  clearTimeout(inactiveTabTrimTimeout)
  inactiveTabTrimTimeout = setTimeout(trimInactiveTabsNow, INACTIVE_TAB_TRIM_DELAY)
}

async function isTabImmuneFromHibernation (id, view) {
  try {
    if (!view || !view.webContents || view.webContents.isDestroyed()) {
      return true
    }

    // 1. Foreground selected tab in any window is immune
    for (const win of windows.getAll()) {
      if (windows.getState(win)?.selectedView === id) {
        return true
      }
    }

    // 2. Tab used within threshold is immune
    const lastActive = tabLastActivity[id] || 0
    if (Date.now() - lastActive < HIBERNATION_IDLE_TIME) {
      return true
    }

    // 3. Audio / video / screen capture is immune
    if (typeof isTabActiveWithMedia === 'function' && isTabActiveWithMedia(view.webContents)) {
      return true
    }

    // 4. In-flight downloads protect all tabs
    if (typeof hasActiveDownloads === 'function' && hasActiveDownloads()) {
      return true
    }

    // 5. Origin with granted notification permission is immune
    const pageUrl = view.webContents.getURL()
    if (pageUrl && pageUrl.startsWith('http')) {
      try {
        const origin = new URL(pageUrl).hostname
        if (origin && typeof isPermissionGrantedForOrigin === 'function') {
          if (isPermissionGrantedForOrigin(origin, 'notifications', {}, view.webContents.session)) {
            return true
          }
        }
      } catch (e) {}
    }

    // 6. In-page behavioral checks: unsaved form inputs, active WebSockets, beforeunload, playing media
    const hasActiveWork = await view.webContents.executeJavaScript(`
      (function() {
        try {
          if (window.__minActiveSockets && window.__minActiveSockets > 0) {
            return true;
          }
          // set by js/preload/default.js while a field the user typed in or ticked is unsaved
          if (document.documentElement.hasAttribute('data-min-unsaved-input')) {
            return true;
          }
          if (window.onbeforeunload) {
            return true;
          }
          const media = document.querySelectorAll('audio, video');
          for (let i = 0; i < media.length; i++) {
            if (!media[i].paused && !media[i].ended) {
              return true;
            }
          }
        } catch (e) {}
        return false;
      })()
    `).catch(() => false)

    if (hasActiveWork) {
      return true
    }

    return false
  } catch (e) {
    return true // Safe fallback on error: do not hibernate
  }
}

async function checkSmartHibernation () {
  if (typeof viewMap === 'undefined') {
    return
  }
  if (typeof hasActiveDownloads === 'function' && hasActiveDownloads()) {
    return
  }

  for (const id in viewMap) {
    const view = viewMap[id]
    const immune = await isTabImmuneFromHibernation(id, view)
    if (!immune) {
      windows.getAll().forEach(function (win) {
        sendIPCToWindow(win, 'hibernateTab', id)
      })
    }
  }
}

// Start recurring intervals for in-use optimization and smart hibernation
if (process.platform === 'win32') {
  if (!inactiveTabTrimInterval) {
    inactiveTabTrimInterval = setInterval(trimInactiveTabsNow, 60000)
  }
  if (!hibernationCheckInterval) {
    hibernationCheckInterval = setInterval(checkSmartHibernation, 300000)
  }
}
