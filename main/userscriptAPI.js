/* The Greasemonkey functions that need the main process: GM_xmlhttpRequest, GM_download, GM_openInTab, GM_setClipboard, GM_notification
   and GM_getResourceText/URL. js/preload/userscripts.js has the rest.
   Each request must come from a frame that runs the script and the script must @grant the function (getUserscriptForRequest).
   GM_xmlhttpRequest and GM_download can also only reach the page's own host and the domains in the script's @connect. */

const USERSCRIPT_MAX_RESPONSE_SIZE = 64 * 1024 * 1024
const activeUserscriptRequests = new Map() // frame key + request id: abort function

function getUserscriptPageHostname (frame) {
  try {
    return new URL(frame.url).hostname
  } catch (e) {
    return ''
  }
}

function getUserscriptConnectError (script, url, frame) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only http and https URLs are supported'
  }
  if (!userscriptCanConnect(script.connects, url.hostname, getUserscriptPageHostname(frame))) {
    return 'Refused to connect to ' + url.hostname + ': the script needs "// @connect ' + url.hostname + '"'
  }
  return null
}

ipc.on('userscripts-xhr', function (event, args) {
  const frame = event.senderFrame
  const requestKey = getUserscriptFrameKey(frame) + '/' + args.requestId
  const reply = (type, data) => sendToUserscriptFrame(frame, 'userscripts-xhr-event', { requestId: args.requestId, type, data })

  const script = getUserscriptForRequest(event, args.scriptId, 'xmlhttpRequest')
  const details = args.details || {}
  let url
  try {
    url = new URL(details.url)
  } catch (e) {
    reply('error', { error: 'Invalid URL' })
    return
  }
  const error = script ? getUserscriptConnectError(script, url, frame) : 'GM_xmlhttpRequest is not granted'
  if (error) {
    console.warn('userscript request blocked: ' + error)
    reply('error', { error, finalUrl: url.href })
    return
  }

  const method = String(details.method || 'GET').toUpperCase()
  const options = {
    method,
    url: url.href,
    session: event.sender.session,
    credentials: details.anonymous ? 'omit' : 'include',
    redirect: 'manual'
  }
  if (details.nocache) {
    options.cache = 'no-store'
  }

  let request
  try {
    request = net.request(options)
  } catch (e) {
    reply('error', { error: e.message, finalUrl: url.href })
    return
  }

  const state = { done: false, finalUrl: url.href, timer: null }
  function finish () {
    state.done = true
    clearTimeout(state.timer)
    activeUserscriptRequests.delete(requestKey)
  }
  function stop (type, data) {
    if (!state.done) {
      finish()
      request.abort()
      reply(type, Object.assign({ finalUrl: state.finalUrl }, data))
    }
  }
  activeUserscriptRequests.set(requestKey, () => stop('abort', {}))

  Object.keys(details.headers || {}).forEach(function (name) {
    try {
      request.setHeader(name, String(details.headers[name]))
    } catch (e) {
      console.warn('userscript request: header not allowed: ' + name)
    }
  })

  if (details.user || details.password) {
    request.on('login', function (authInfo, callback) {
      callback(String(details.user || ''), String(details.password || ''))
    })
  }

  request.on('redirect', function (statusCode, redirectMethod, redirectURL) {
    if (details.redirect === 'error' || !/^https?:/i.test(redirectURL)) {
      stop('error', { error: 'Redirect not allowed' })
      return
    }
    state.finalUrl = redirectURL
    request.followRedirect()
  })

  request.on('response', function (response) {
    const headerLines = []
    Object.keys(response.headers).forEach(function (name) {
      [].concat(response.headers[name]).forEach(value => headerLines.push(name + ': ' + value))
    })
    const contentType = [].concat(response.headers['content-type'] || '')[0]
    const total = parseInt([].concat(response.headers['content-length'] || '')[0], 10) || 0
    const responseInfo = {
      status: response.statusCode,
      statusText: response.statusMessage,
      responseHeaders: headerLines.join('\r\n'),
      finalUrl: state.finalUrl,
      contentType,
      total
    }
    reply('headers', responseInfo)

    const chunks = []
    let loaded = 0
    let lastProgress = 0
    response.on('data', function (chunk) {
      if (state.done) {
        return
      }
      chunks.push(chunk)
      loaded += chunk.length
      if (loaded > USERSCRIPT_MAX_RESPONSE_SIZE) {
        stop('error', { error: 'Response too large' })
        return
      }
      if (Date.now() - lastProgress > 100) {
        lastProgress = Date.now()
        if (!reply('progress', { loaded, total })) {
          stop('abort', {})
        }
      }
    })
    response.on('end', function () {
      if (!state.done) {
        finish()
        reply('load', Object.assign({ body: Buffer.concat(chunks), loaded, total: total || loaded }, responseInfo))
      }
    })
    response.on('error', function (e) {
      stop('error', { error: e.message })
    })
  })

  request.on('error', function (e) {
    if (!state.done) {
      finish()
      reply('error', { error: e.message, finalUrl: state.finalUrl })
    }
  })

  if (details.timeout > 0) {
    state.timer = setTimeout(() => stop('timeout', {}), details.timeout)
  }

  if (details.data !== undefined && details.data !== null && method !== 'GET' && method !== 'HEAD') {
    request.write(typeof details.data === 'string' ? details.data : Buffer.from(details.data))
  }
  request.end()
})

ipc.on('userscripts-xhr-abort', function (event, requestId) {
  const abort = event.senderFrame && activeUserscriptRequests.get(getUserscriptFrameKey(event.senderFrame) + '/' + requestId)
  if (abort) {
    abort()
  }
})

/* GM_download: a normal download, with the name the script suggests as the default in the save dialog */

const pendingUserscriptDownloads = [] // {url, name, reply, expires}

ipc.on('userscripts-download', function (event, args) {
  const frame = event.senderFrame
  const reply = (type, data) => sendToUserscriptFrame(frame, 'userscripts-download-event', Object.assign({ downloadId: args.downloadId, type }, data))

  const script = getUserscriptForRequest(event, args.scriptId, 'download')
  let url
  try {
    url = new URL(args.url)
  } catch (e) {
    reply('error', { error: 'Invalid URL' })
    return
  }
  let error = script ? null : 'GM_download is not granted'
  if (!error && url.protocol !== 'data:' && url.protocol !== 'blob:') {
    error = getUserscriptConnectError(script, url, frame)
  }
  if (error) {
    reply('error', { error })
    return
  }

  pendingUserscriptDownloads.push({ url: url.href, name: args.name, reply, expires: Date.now() + 60 * 1000 })
  event.sender.downloadURL(url.href, args.headers ? { headers: args.headers } : undefined)
})

function handleUserscriptDownload (event, item) {
  const now = Date.now()
  for (let i = pendingUserscriptDownloads.length - 1; i >= 0; i--) {
    if (pendingUserscriptDownloads[i].expires < now) {
      pendingUserscriptDownloads.splice(i, 1)
    }
  }
  const index = pendingUserscriptDownloads.findIndex(download => download.url === item.getURL())
  if (index === -1) {
    return
  }
  const download = pendingUserscriptDownloads.splice(index, 1)[0]
  if (download.name) {
    const name = path.basename(String(download.name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')) // eslint-disable-line no-control-regex
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) })
  }
  item.once('done', function (e, state) {
    download.reply(state === 'completed' ? 'load' : 'error', state === 'completed' ? {} : { error: state })
  })
}

app.once('ready', function () {
  session.defaultSession.on('will-download', handleUserscriptDownload)
})

app.on('session-created', function (ses) {
  ses.on('will-download', handleUserscriptDownload)
})

/* GM_openInTab: the UI (js/userscripts.js) opens the tab and replies with its id, so the script can close it again */

const pendingUserscriptTabs = new Map() // request id: function (tabId)
const userscriptOpenedTabs = new Map() // tab id: {frameKey, win}

ipc.handle('userscripts-open-tab', function (event, args) {
  const script = getUserscriptForRequest(event, args.scriptId, 'openInTab')
  let url
  try {
    url = new URL(args.url)
  } catch (e) {
    return null
  }
  const win = getWindowFromViewContents(event.sender) || windows.getCurrent()
  if (!script || !win || !['http:', 'https:', 'file:'].includes(url.protocol)) {
    return null
  }
  const frameKey = getUserscriptFrameKey(event.senderFrame)
  const requestId = Math.random().toString(36).slice(2)

  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      pendingUserscriptTabs.delete(requestId)
      resolve(null)
    }, 5000)
    pendingUserscriptTabs.set(requestId, function (tabId) {
      clearTimeout(timer)
      pendingUserscriptTabs.delete(requestId)
      if (tabId) {
        userscriptOpenedTabs.set(String(tabId), { frameKey, win })
      }
      resolve(tabId || null)
    })
    sendIPCToWindow(win, 'userscripts-open-tab', {
      requestId,
      openerTabId: getTabIDFromWebContents(event.sender),
      url: url.href,
      active: !!args.active,
      private: !!args.incognito || !event.sender.session.isPersistent()
    })
  })
})

ipc.on('userscripts-tab-opened', function (event, args) {
  const resolve = windows.windowFromContents(event.sender) && args && pendingUserscriptTabs.get(args.requestId)
  if (resolve) {
    resolve(args.tabId)
  }
})

ipc.on('userscripts-close-tab', function (event, tabId) {
  const tab = userscriptOpenedTabs.get(String(tabId))
  if (!tab || !event.senderFrame || tab.frameKey !== getUserscriptFrameKey(event.senderFrame)) {
    return
  }
  userscriptOpenedTabs.delete(String(tabId))
  if (!tab.win.isDestroyed()) {
    sendIPCToWindow(tab.win, 'userscripts-close-tab', tabId)
  }
})

/* GM_setClipboard */

ipc.on('userscripts-set-clipboard', function (event, args) {
  if (!getUserscriptForRequest(event, args && args.scriptId, 'setClipboard')) {
    return
  }
  const text = String(args.data)
  writeToClipboard(/html/i.test(args.type || '') ? { html: text, text } : { text }).catch(function (e) {
    console.warn('GM_setClipboard failed', e)
  })
})

/* GM_notification: a system notification; clicks and closing are reported back to the script */

function getUserscriptNotificationIcon (image) {
  if (typeof image !== 'string' || !image) {
    return Promise.resolve(undefined)
  }
  if (image.startsWith('data:')) {
    return Promise.resolve(electron.nativeImage.createFromDataURL(image))
  }
  if (!/^https?:/i.test(image)) {
    return Promise.resolve(undefined)
  }
  return net.fetch(image, { signal: AbortSignal.timeout(5000) })
    .then(response => response.arrayBuffer())
    .then(data => electron.nativeImage.createFromBuffer(Buffer.from(data)))
    .catch(() => undefined)
}

ipc.on('userscripts-notification', function (event, args) {
  const frame = event.senderFrame
  const reply = type => sendToUserscriptFrame(frame, 'userscripts-notification-event', { notificationId: args.notificationId, type })
  const script = getUserscriptForRequest(event, args.scriptId, 'notification')
  if (!script || !electron.Notification.isSupported()) {
    reply('done')
    return
  }
  getUserscriptNotificationIcon(args.image).then(function (icon) {
    const notification = new electron.Notification({
      title: String(args.title || script.name),
      body: String(args.text || ''),
      silent: !!args.silent,
      icon
    })
    let done = false
    const finish = function () {
      if (!done) {
        done = true
        reply('done')
      }
    }
    notification.on('click', () => reply('click'))
    notification.on('close', finish)
    notification.on('failed', finish)
    notification.show()
    if (args.timeout > 0) {
      // closing it here doesn't emit "close" on every platform
      setTimeout(function () {
        notification.close()
        finish()
      }, args.timeout)
    }
  })
})

/* GM_getResourceText / GM_getResourceURL: synchronous in Tampermonkey, so the preload asks synchronously, and only when a script uses a resource */

ipc.on('userscripts-resource', function (event, args) {
  let result = null
  try {
    const script = getUserscriptForRequest(event, args.scriptId)
    if (script && (script.grants.includes('getResourceText') || script.grants.includes('getResourceURL'))) {
      const resource = script.resources.find(resource => resource.name === args.name)
      const file = resource && readUserscriptDependency(resource.url)
      if (file) {
        result = { data: file.data, contentType: file.contentType }
      }
    }
  } catch (e) {
    console.warn('failed to read userscript resource', e)
  }
  event.returnValue = result
})
