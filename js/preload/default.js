/* imports common modules */
/* global ghosteryContent, MutationObserver */

var electron = require('electron')
var ipc = electron.ipcRenderer

// Ad blocking (main/filtering.js): the scriptlets run now, before the page's own scripts, as in uBlock Origin. Several only
// work if they're there first (YouTube's ad data in ytInitialPlayerResponse). Main inserts the hiding CSS itself.
if (window === window.top && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  var minCosmetics = ipc.sendSync('cosmetic-filters-start', window.location.href)
  if (minCosmetics && minCosmetics.scriptlets) {
    electron.webFrame.executeJavaScript(minCosmetics.scriptlets)
  }
  if (minCosmetics && minCosmetics.dom) {
    reportCosmeticFeatures(minCosmetics.whileLoading === true)
  }
}

/* Generic hiding rules (main/filtering.js, cosmetic-filters-dom): the engine keeps rules such as ##.ad-slot in lookups by
   class, id and link, so the page tells main which ones it has. Ghostery's own page watcher does that (DOMMonitor, from
   @ghostery/adblocker-content, which scripts/buildPreload.js puts before this file): first what's there, then only what's
   new as the page changes. A shown page is watched once it's parsed, as Ghostery and uBO Lite do; with the setting
   hideAdSpacesWhileLoading (whileLoading), while it's still arriving, from its root element on, so the rules come with
   the first parts drawn (on big pages an empty ad box shows until the page is parsed otherwise; it costs about 3–5 MB a
   tab). Nothing while the page is hidden: the watching stops, and one scan catches up when it's shown again; a page
   loaded hidden gets one scan once it's parsed. This runs in the preload's isolated world, so a page's patches to the
   DOM's built-ins don't change what it sees. */
function reportCosmeticFeatures (whileLoading) {
  var monitor = new ghosteryContent.DOMMonitor(function (update) {
    if (update.type === 'features') {
      ipc.send('cosmetic-filters-dom', window.location.href, { classes: update.classes, ids: update.ids, hrefs: update.hrefs })
    }
  })
  var watching = false

  function canWatch () {
    return !document.hidden && (whileLoading ? document.documentElement !== null : document.readyState !== 'loading')
  }

  function watch () {
    if (watching || !canWatch()) {
      return
    }
    watching = true
    // what's there so far (the watcher remembers what it sent: only what's new goes), then every change
    monitor.queryAll(window)
    monitor.start(window)
  }

  // while it arrives: from the root element on (the preload runs before the document has one); otherwise from
  // DOMContentLoaded (parsed, below)
  if (whileLoading && document.documentElement) {
    watch()
  } else if (whileLoading) {
    var waitForRoot = new MutationObserver(function () {
      if (document.documentElement) {
        waitForRoot.disconnect()
        watch()
      }
    })
    waitForRoot.observe(document, { childList: true })
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      watch()
    } else if (watching) {
      watching = false
      monitor.stop()
    }
  })

  function parsed () {
    if (document.hidden) {
      monitor.queryAll(window)
    } else {
      watch()
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', parsed, { once: true })
  } else {
    parsed()
  }
}

/* Used by tab hibernation (main/viewManager.js) to protect unsaved input.
   Only fields the user changed count (trusted events), so pre-filled search boxes and untouched checkboxes don't keep a tab alive.
   The result is marked with a data-min-unsaved-input attribute on <html>, which the hibernation check reads. */
var userChangedFields = new Set()

function fieldHasUnsavedChange (field) {
  if (!field.isConnected) {
    return false
  }
  if (field.type === 'checkbox' || field.type === 'radio') {
    return field.checked !== field.defaultChecked
  }
  if (field.isContentEditable) {
    return field.textContent.trim() !== ''
  }
  return typeof field.value === 'string' && field.value.trim() !== '' && field.value !== field.defaultValue
}

function updateUnsavedInputMarker () {
  var hasUnsaved = false
  userChangedFields.forEach(function (field) {
    if (fieldHasUnsavedChange(field)) {
      hasUnsaved = true
    } else if (!field.isConnected) {
      userChangedFields.delete(field)
    }
  })
  if (hasUnsaved) {
    document.documentElement.setAttribute('data-min-unsaved-input', '')
  } else {
    document.documentElement.removeAttribute('data-min-unsaved-input')
  }
}

function recordUserChange (e) {
  // composedPath()[0] is the real field, even inside a shadow root
  var field = e.isTrusted && e.composedPath()[0]
  if (field && (field.isContentEditable || field.tagName === 'INPUT' || field.tagName === 'TEXTAREA')) {
    userChangedFields.add(field)
    updateUnsavedInputMarker()
  }
}

document.addEventListener('input', recordUserChange, true)
document.addEventListener('change', recordUserChange, true)
// a submitted form's fields are no longer unsaved
document.addEventListener('submit', function (e) {
  var form = e.composedPath()[0]
  userChangedFields.forEach(function (field) {
    if (form.contains && form.contains(field)) {
      userChangedFields.delete(field)
    }
  })
  updateUnsavedInputMarker()
}, true)
document.addEventListener('visibilitychange', updateUnsavedInputMarker)

var propertiesToClone = ['deltaX', 'deltaY', 'metaKey', 'ctrlKey', 'defaultPrevented', 'clientX', 'clientY']

function cloneEvent (e) {
  var obj = {}

  for (var i = 0; i < propertiesToClone.length; i++) {
    obj[propertiesToClone[i]] = e[propertiesToClone[i]]
  }
  return JSON.stringify(obj)
}

// workaround for Electron bug
setTimeout(function () {
  /* Used for swipe gestures and Ctrl/Cmd+wheel zoom */
  var lastHorizontalWheelTime = 0

  window.addEventListener('wheel', function (e) {
    if (e.deltaX !== 0) {
      lastHorizontalWheelTime = Date.now()
    }
    if (e.deltaX !== 0 || e.ctrlKey || e.metaKey || (Date.now() - lastHorizontalWheelTime < 1000)) {
      ipc.send('wheel-event', cloneEvent(e))
    }
  }, { passive: true })

  var scrollTimeout = null

  window.addEventListener('scroll', function () {
    clearTimeout(scrollTimeout)
    scrollTimeout = setTimeout(function () {
      ipc.send('scroll-position-change', Math.round(window.scrollY))
    }, 200)
  }, { passive: true })
}, 0)

/* Used for picture in picture item in context menu */
ipc.on('getContextMenuData', function (event, data) {
  // check for video element to show picture-in-picture menu
  var hasVideo = Array.from(document.elementsFromPoint(data.x, data.y)).some(el => el.tagName === 'VIDEO')
  ipc.send('contextMenuData', { hasVideo })
})

ipc.on('enterPictureInPicture', function (event, data) {
  var videos = Array.from(document.elementsFromPoint(data.x, data.y)).filter(el => el.tagName === 'VIDEO')
  if (videos[0]) {
    videos[0].requestPictureInPicture()
  }
})

window.addEventListener('message', function (e) {
  if (!e.origin.startsWith('min://')) {
    return
  }

  if (e.data?.message === 'showCredentialList') {
    ipc.send('showCredentialList')
  }

  if (e.data?.message === 'showUserscriptDirectory') {
    ipc.send('showUserscriptDirectory')
  }

  if (e.data?.message === 'downloadFile') {
    ipc.send('downloadFile', e.data.url)
  }

  // reader view's page, fetched by main when the page can't fetch it itself (reader/reader.js)
  if (e.data?.message === 'internalPageFetch' && e.source === window) {
    const reply = data => window.postMessage(Object.assign({ message: 'internalPageFetchResult', requestId: e.data.requestId }, data), window.location.origin)
    ipc.invoke('internal-page-fetch', e.data.url).then(result => reply({ result }), error => reply({ error: String(error.message) }))
  }
})
