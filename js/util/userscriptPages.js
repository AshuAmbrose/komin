/* For Min's pages that manage userscripts (pages/userscriptInstall and the list in pages/settings):
   requests to main/userscriptInstall.js, relayed by js/preload/userscripts.js, and helpers to describe scripts. */

var userscriptPages = {
  nextRequestId: 1,
  pendingRequests: {},
  // actions: see userscriptPageActions in main/userscriptInstall.js
  request: function (action, args) {
    return new Promise(function (resolve, reject) {
      var requestId = userscriptPages.nextRequestId++
      userscriptPages.pendingRequests[requestId] = { resolve, reject }
      window.postMessage({ message: 'userscripts', requestId, action, args }, window.location.origin)
    })
  },
  // called when scripts are installed, changed or removed
  onChange: function (callback) {
    window.addEventListener('message', function (e) {
      if (e.source === window && e.data && e.data.message === 'userscriptsChanged') {
        callback()
      }
    })
  },
  // "*://*.example.com/*" → "*.example.com"; other patterns are shown as written
  describeSite: function (pattern) {
    var parts = pattern.match(/^(\*|https?|http\*):\/\/([^/]+)(\/.*)?$/)
    if (!parts) {
      return pattern
    }
    return parts[2] + (parts[3] && parts[3] !== '/*' && parts[3] !== '/' ? parts[3] : '')
  },
  describeHost: function (url) {
    try {
      var parsed = new URL(url)
      return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname.split('/').pop()) : parsed.host
    } catch (e) {
      return url
    }
  },
  // the things a script can do, from its @grant APIs, as localized string ids
  describeGrants: function (grants) {
    var labels = {
      getValue: 'userscriptGrantStorage',
      setValue: 'userscriptGrantStorage',
      deleteValue: 'userscriptGrantStorage',
      listValues: 'userscriptGrantStorage',
      getValues: 'userscriptGrantStorage',
      setValues: 'userscriptGrantStorage',
      deleteValues: 'userscriptGrantStorage',
      addValueChangeListener: 'userscriptGrantStorage',
      removeValueChangeListener: 'userscriptGrantStorage',
      xmlhttpRequest: 'userscriptGrantRequests',
      download: 'userscriptGrantDownload',
      openInTab: 'userscriptGrantTabs',
      setClipboard: 'userscriptGrantClipboard',
      notification: 'userscriptGrantNotification',
      registerMenuCommand: 'userscriptGrantMenu',
      unregisterMenuCommand: 'userscriptGrantMenu',
      addStyle: 'userscriptGrantStyle',
      addElement: 'userscriptGrantStyle',
      getResourceText: 'userscriptGrantResources',
      getResourceURL: 'userscriptGrantResources'
    }
    var ids = []
    grants.forEach(function (grant) {
      if (labels[grant] && !ids.includes(labels[grant])) {
        ids.push(labels[grant])
      }
    })
    return ids
  }
}

window.addEventListener('message', function (e) {
  if (e.source !== window || !e.data || e.data.message !== 'userscriptsResult') {
    return
  }
  var pending = userscriptPages.pendingRequests[e.data.requestId]
  if (pending) {
    delete userscriptPages.pendingRequests[e.data.requestId]
    if (e.data.error) {
      pending.reject(new Error(e.data.error))
    } else {
      pending.resolve(e.data.result)
    }
  }
})
