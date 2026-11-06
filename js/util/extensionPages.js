/* For the extension list in pages/settings: requests to main/extensions.js, relayed by js/preload/userscripts.js. */

var extensionPages = {
  nextRequestId: 1,
  pendingRequests: {},
  // actions: see extensionPageActions in main/extensions.js
  request: function (action, args) {
    return new Promise(function (resolve, reject) {
      var requestId = extensionPages.nextRequestId++
      extensionPages.pendingRequests[requestId] = { resolve, reject }
      window.postMessage({ message: 'extensions', requestId, action, args }, window.location.origin)
    })
  },
  // called when extensions are installed, changed or removed
  onChange: function (callback) {
    window.addEventListener('message', function (e) {
      if (e.source === window && e.data && e.data.message === 'extensionsChanged') {
        callback()
      }
    })
  }
}

window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data || e.data.message !== 'extensionsResult') {
    return
  }
  var pending = extensionPages.pendingRequests[e.data.requestId]
  if (pending) {
    delete extensionPages.pendingRequests[e.data.requestId]
    if (e.data.error) {
      pending.reject(new Error(e.data.error))
    } else {
      pending.resolve(e.data.result)
    }
  }
})
