/* imports common modules */

var electron = require('electron')
var ipc = electron.ipcRenderer

if (window === window.top && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  ipc.send('inject-cosmetic-filters', window.location.href)
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
})
