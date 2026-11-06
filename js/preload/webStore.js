/* The Chrome Web Store's "Add to Chrome" button (main/extensions.js, AGENTS.md section 10.9). The store's page calls
   chrome.webstorePrivate and chrome.management, which only Chrome gives it. On https://chromewebstore.google.com this
   provides them in the page, asking main (extensions-webstore) for anything that installs, removes or reads extensions. */

if (window === window.top && window.location.origin === 'https://chromewebstore.google.com') {
  (function () {
    const bridge = {
      call: (action, args) => ipc.invoke('extensions-webstore', { action, args }),
      // main reports extensions installed, removed, turned on or off, so the page's button changes
      listen: function (callback) {
        ipc.on('extensions-webstore-event', (e, name, data) => callback(name, data))
      },
      chromeVersion: process.versions.chrome
    }

    // runs in the page's world
    function addWebStoreAPIs (bridge) {
      const listeners = { onInstalled: new Set(), onUninstalled: new Set(), onEnabled: new Set(), onDisabled: new Set() }
      bridge.listen(function (name, data) {
        (listeners[name] || []).forEach(function (listener) {
          try {
            listener(data)
          } catch (e) {
            console.error(e)
          }
        })
      })
      const event = name => ({
        addListener: listener => listeners[name].add(listener),
        removeListener: listener => listeners[name].delete(listener),
        hasListener: listener => listeners[name].has(listener)
      })

      // Chrome's API style: an optional callback last, and a promise; failures set lastError while the callback runs
      function setLastError (error) {
        if (window.chrome && window.chrome.runtime) {
          window.chrome.runtime.lastError = error
        }
        if (window.chrome && window.chrome.extension) {
          window.chrome.extension.lastError = error
        }
      }
      function answer (promise, callback) {
        return promise.then(function (response) {
          setLastError(response.error ? { message: response.error } : undefined)
          try {
            if (callback) {
              callback(response.result)
            }
          } finally {
            setLastError(undefined)
          }
          return response.result
        })
      }
      const fromMain = action => function (...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
        return answer(bridge.call(action, args), callback)
      }
      const constant = value => function (...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
        return answer(Promise.resolve({ result: value }), callback)
      }

      const webstorePrivate = {
        beginInstallWithManifest3: fromMain('beginInstall'),
        completeInstall: fromMain('completeInstall'),
        install: constant('unsupported_extension_type'),
        getExtensionStatus: fromMain('getExtensionStatus'),
        isInIncognitoMode: fromMain('isInIncognitoMode'),
        getFullChromeVersion: constant({ version_number: bridge.chromeVersion }),
        getBrowserLogin: constant({ login: '' }),
        getStoreLogin: constant(''),
        setStoreLogin: constant(true),
        getWebGLStatus: constant('webgl_allowed'),
        getIsLauncherEnabled: constant(false),
        enableAppLauncher: constant(false),
        isPendingCustodianApproval: constant(false),
        getReferrerChain: constant('EgIIAA=='),
        getMV2DeprecationStatus: constant('inactive')
      }
      const management = {
        getAll: fromMain('getAll'),
        get: fromMain('get'),
        setEnabled: fromMain('setEnabled'),
        uninstall: fromMain('uninstall'),
        onInstalled: event('onInstalled'),
        onUninstalled: event('onUninstalled'),
        onEnabled: event('onEnabled'),
        onDisabled: event('onDisabled')
      }
      // Chromium gives the store a chrome object with runtime and parts of management (siteUnbreak.js leaves it alone here)
      const chrome = window.chrome || (window.chrome = {})
      chrome.webstorePrivate = webstorePrivate
      chrome.management = Object.assign(chrome.management || {}, management)
      chrome.runtime = chrome.runtime || {}
      chrome.extension = chrome.extension || {}
    }

    electron.contextBridge.executeInMainWorld({ func: addWebStoreAPIs, args: [bridge] })
  })()
}
