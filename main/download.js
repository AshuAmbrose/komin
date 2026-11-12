const currrentDownloadItems = {}

ipc.on('cancelDownload', function (e, path) {
  if (currrentDownloadItems[path]) {
    currrentDownloadItems[path].cancel()
  }
})

function isAttachment (header) {
  return /^\s*attache*?ment/i.test(header)
}

function downloadHandler (event, item, webContents) {
  // an extension's background worker starts downloads without a page
  let sourceWindow = webContents && windows.windowFromContents(webContents)?.win
  if (!sourceWindow) {
    sourceWindow = windows.getCurrent()
  }

  var savePathFilename

  // send info to download manager
  sendIPCToWindow(sourceWindow, 'download-info', {
    path: item.getSavePath(),
    name: item.getFilename(),
    status: 'progressing',
    size: { received: 0, total: item.getTotalBytes() }
  })

  item.on('updated', function (e, state) {
    if (!savePathFilename) {
      savePathFilename = path.basename(item.getSavePath())
    }

    if (item.getSavePath()) {
      currrentDownloadItems[item.getSavePath()] = item
    }

    sendIPCToWindow(sourceWindow, 'download-info', {
      path: item.getSavePath(),
      name: savePathFilename,
      status: state,
      size: { received: item.getReceivedBytes(), total: item.getTotalBytes() }
    })
  })

  item.once('done', function (e, state) {
    delete currrentDownloadItems[item.getSavePath()]
    sendIPCToWindow(sourceWindow, 'download-info', {
      path: item.getSavePath(),
      name: savePathFilename,
      status: state,
      size: { received: item.getTotalBytes(), total: item.getTotalBytes() }
    })
  })
  return true
}

// Whether the reader or PDF page may read requestURL: the address in its url parameter, or one that address was redirected
// to. The redirects seen in the last seconds are walked back from requestURL, each address once: following them blindly
// went round a redirect loop forever (a website could cause one, and then main stopped with an error; security review B7).
function isAccessAllowedFromContentPage (requestURL, contentPageURL) {
  const allowed = new URL(contentPageURL).searchParams.get('url')
  const seen = new Set([requestURL])
  const next = [requestURL]
  while (next.length > 0) {
    const url = next.shift()
    if (url === allowed) {
      return true
    }
    redirectCache.forEach(function (entry) {
      if (entry.to === url && !seen.has(entry.from)) {
        seen.add(entry.from)
        next.push(entry.from)
      }
    })
  }
  return false
}

let redirectCache = [] // {from to, expiry}

setInterval(function () {
  redirectCache = redirectCache.filter(entry => entry.expiry >= Date.now())
}, 10000)

function listenForDownloadHeaders (ses) {
  ses.webRequest.onBeforeRedirect(function (details) {
    redirectCache.push({ from: details.url, to: details.redirectURL, expiry: Date.now() + 5000 })
  })

  ses.webRequest.onHeadersReceived(function (details, callback) {
    if (details.resourceType === 'mainFrame' && details.responseHeaders) {
      let sourceWindow
      if (details.webContents) {
        sourceWindow = windows.windowFromContents(details.webContents)?.win
      }
      if (!sourceWindow) {
        sourceWindow = windows.getCurrent()
      }

      // workaround for https://github.com/electron/electron/issues/24334
      var typeHeader = details.responseHeaders[Object.keys(details.responseHeaders).filter(k => k.toLowerCase() === 'content-type')]
      var attachment = isAttachment(details.responseHeaders[Object.keys(details.responseHeaders).filter(k => k.toLowerCase() === 'content-disposition')])

      if (typeHeader instanceof Array && typeHeader.filter(t => t.includes('application/pdf')).length > 0 && !attachment) {
      // open in PDF viewer instead
        callback({ cancel: false })
        // the tab it's for: the UI used to find it by address, but a page's own navigation only changes the tab's
        // address once the new page arrives (js/webviews.js), which a PDF never does
        sendIPCToWindow(sourceWindow, 'openPDF', {
          url: details.url,
          tabId: (details.webContents && getTabIDFromWebContents(details.webContents)) || null
        })
        return
      }

      // a userscript: show the install page instead (main/userscriptInstall.js)
      if (details.statusCode >= 200 && details.statusCode < 300 && typeof promptUserscriptInstall === 'function' &&
        promptUserscriptInstall(details.webContents, details.url, typeHeader instanceof Array ? typeHeader : [])) {
        callback({ cancel: false })
        return
      }

      // whether this is a file being viewed in-browser or a page
      // Needed to save files correctly: https://github.com/minbrowser/min/issues/1717
      // It doesn't make much sense to have this here, but only one onHeadersReceived instance can be created per session
      const isFileView = typeHeader instanceof Array && !typeHeader.some(t => t.includes('text/html'))

      sendIPCToWindow(sourceWindow, 'set-file-view', {
        url: details.url,
        tabId: (details.webContents && getTabIDFromWebContents(details.webContents)) || null,
        isFileView
      })
    }

    /*
    SECURITY POLICY EXCEPTION:
    reader and PDF internal pages get cross-origin access to resources in their url query parameters, and the main UI gets access to everything
    */

    const webContentsURL = details.webContents?.getURL()

    if (details.webContents &&
      (
        (webContentsURL === 'min://app/index.html') ||
        (
          (webContentsURL.startsWith('min://app/pages/pdfViewer') || webContentsURL.startsWith('min://app/reader/')) &&
          isAccessAllowedFromContentPage(details.url, webContentsURL)
        )
      )
    ) {
      const filteredHeaders = Object.fromEntries(
        Object.entries(details.responseHeaders).filter(([key, val]) => key.toLowerCase() !== 'access-control-allow-origin' && key.toLowerCase() !== 'access-control-allow-credentials')
      )

      callback({
        responseHeaders: {
          ...filteredHeaders,
          'Access-Control-Allow-Origin': 'min://app',
          'Access-Control-Allow-Credentials': 'true'
        }
      })
      return
    }

    if (typeof applyFilteringCSPHeaders === 'function') {
      const cspHeaders = applyFilteringCSPHeaders(details, details.responseHeaders)
      if (cspHeaders) {
        callback({ cancel: false, responseHeaders: cspHeaders })
        return
      }
    }

    callback({ cancel: false })
  })
}

/*
The same exception for reader view when the response hook above isn't there (an extension filters normal tabs' requests,
main/extensions.js): the page asks main for the page in its url parameter (reader/reader.js, through js/preload/default.js).
*/
ipc.handle('internal-page-fetch', async function (event, url) {
  const frame = event.senderFrame
  let pageURL = null
  try {
    pageURL = frame && !frame.parent && new URL(frame.url)
  } catch (e) {}
  if (!pageURL || pageURL.protocol !== 'min:' || pageURL.host !== 'app' || !pageURL.pathname.startsWith('/reader/') || pageURL.searchParams.get('url') !== url || !/^https?:\/\//i.test(url)) {
    throw new Error('Not allowed')
  }
  const response = await event.sender.session.fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60 * 1000) })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    body: Buffer.from(await response.arrayBuffer())
  }
})

app.once('ready', function () {
  session.defaultSession.on('will-download', downloadHandler)
  listenForDownloadHeaders(session.defaultSession)
})

app.on('session-created', function (session) {
  session.on('will-download', downloadHandler)
  listenForDownloadHeaders(session)
})
