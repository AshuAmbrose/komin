/* Runs in extensions' pages and background workers (registered by main/extensions.js once an extension is enabled),
   after electron-chrome-extensions' own preload (js/preload/extensionSupportEarly.js runs before it). It also starts in
   every web page's frames and service workers in that session, so it returns straight away outside chrome-extension://
   pages. It:
   - makes `browser` the same object as `chrome`: Chromium also offers the extension APIs under that name, as a separate
     object without the library's additions (tabs, windows, commands…), and extensions that prefer it, like uBlock Origin
     Lite, broke;
   - in background workers, sends chrome.runtime.onInstalled and onStartup, which Electron never sends: listeners are kept
     here and called when main/extensions.js says the extension was installed, updated, or Min started. If Electron ever
     sends them itself, these copies stay quiet;
   - adds the APIs main/extensionAPIs.js provides (screenshots, a page's language, tabs.discard, downloads, privacy,
     identity, side panels, browsing data, search, speech), and action.setIcon with imageData. They call main through
     the library's router ("crx-msg"), as its own APIs do. */

;(function () {
  const isWorker = process.type === 'service-worker'
  // a worker's preload runs in a realm of its own, without location; its URL is checked in the worker itself below
  if (!isWorker && !location.href.startsWith('chrome-extension://')) {
    return
  }
  const { contextBridge, ipcRenderer } = require('electron')

  // passed into the extension's world
  const bridge = {
    invoke: (extensionId, name, args) => ipcRenderer.invoke('crx-msg', extensionId, name, ...args),
    listen: function (extensionId, name, listener) {
      ipcRenderer.send('crx-add-listener', extensionId, name)
      ipcRenderer.on('crx-' + name, (event, ...args) => listener(...args))
    },
    // asks main which lifecycle event to send, if any (and tells it the worker's process, for low-resource mode)
    lifecycle: isWorker ? () => ipcRenderer.invoke('min-extension-lifecycle', process.pid) : null
  }

  // runs in the extension's own world
  function extendExtensionAPIs (bridge) {
    const chrome = globalThis.chrome
    if (!globalThis.location.href.startsWith('chrome-extension://') || !chrome || !chrome.runtime) {
      return
    }

    if (globalThis.browser && globalThis.browser !== chrome) {
      // Electron 45.2 has storage.sync (a second local area, nothing is synced), which content scripts get. The library
      // still points sync at local here, so pages and content scripts would see different settings: the real one, from
      // Chromium's own `browser`
      const nativeStorage = globalThis.browser.storage
      if (nativeStorage && nativeStorage.sync && chrome.storage && chrome.storage.sync === chrome.storage.local) {
        chrome.storage.sync = nativeStorage.sync
      }
      globalThis.browser = chrome
    }

    const extensionId = chrome.runtime.id
    // offscreen documents only have runtime messaging, as in Chrome
    const manifest = typeof chrome.runtime.getManifest === 'function' ? chrome.runtime.getManifest() : null
    const permissions = new Set(((manifest && manifest.permissions) || []).filter(p => typeof p === 'string'))

    /* Lifecycle events (background workers) */

    // keeps the listeners added to a runtime event, and notices if Electron fires the event itself
    function watch (event) {
      const watched = { listeners: new Set(), nativeFired: false }
      if (!event) {
        return watched
      }
      const addListener = event.addListener.bind(event)
      const removeListener = event.removeListener.bind(event)
      addListener(function () {
        watched.nativeFired = true
      })
      event.addListener = function (listener) {
        watched.listeners.add(listener)
        addListener(listener)
      }
      event.removeListener = function (listener) {
        watched.listeners.delete(listener)
        removeListener(listener)
      }
      return watched
    }

    if (bridge.lifecycle) {
      const installed = watch(chrome.runtime.onInstalled)
      const startup = watch(chrome.runtime.onStartup)

      bridge.lifecycle().then(function (event) {
        if (!event) {
          return
        }
        // after the background script's first run, which is when it adds its listeners
        setTimeout(function () {
          const watched = event.type === 'startup' ? startup : installed
          if (watched.nativeFired) {
            return
          }
          const args = event.type === 'startup' ? [] : [{ reason: event.reason, previousVersion: event.previousVersion }]
          watched.listeners.forEach(function (listener) {
            try {
              listener.apply(null, args)
            } catch (e) {
              console.error(e)
            }
          })
        }, 0)
      }, function () {})
    }

    if (!manifest) {
      return
    }

    /* Calling main/extensionAPIs.js */

    function errorMessage (error) {
      return String((error && error.message) || error).replace(/^Error invoking remote method 'crx-msg': (Error: )?/, '')
    }

    // Chrome's API style: a promise, or a callback as the last argument with runtime.lastError set while it runs
    function settle (promise, callback) {
      if (!callback) {
        return promise.catch(function (error) {
          throw new Error(errorMessage(error))
        })
      }
      promise.then(function (result) {
        callback(result)
      }, function (error) {
        chrome.runtime.lastError = { message: errorMessage(error) }
        try {
          callback()
        } finally {
          chrome.runtime.lastError = undefined
        }
      })
    }

    function call (name, args, callback) {
      return settle(bridge.invoke(extensionId, name, args), callback)
    }

    // a function taking Chrome's arguments, with an optional callback last
    function api (name) {
      return function (...args) {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null
        return call(name, args, callback)
      }
    }

    function event (name) {
      const listeners = new Set()
      let listening = false
      return {
        addListener: function (listener) {
          listeners.add(listener)
          if (!listening) {
            listening = true
            bridge.listen(extensionId, name, function (...args) {
              listeners.forEach(function (listener) {
                try {
                  listener(...args)
                } catch (e) {
                  console.error(e)
                }
              })
            })
          }
        },
        removeListener: function (listener) {
          listeners.delete(listener)
        },
        hasListener: listener => listeners.has(listener),
        hasListeners: () => listeners.size > 0
      }
    }

    function define (name, value) {
      Object.defineProperty(chrome, name, { value, writable: true, enumerable: true, configurable: true })
    }

    /* The APIs */

    if (chrome.tabs) {
      chrome.tabs.captureVisibleTab = api('tabs.captureVisibleTab')
      chrome.tabs.detectLanguage = api('tabs.detectLanguage')
      chrome.tabs.discard = api('tabs.discard')
    }

    // the library's downloads are stubs
    if (permissions.has('downloads')) {
      const downloads = {}
      ;['download', 'search', 'pause', 'resume', 'cancel', 'erase', 'removeFile', 'open', 'show', 'getFileIcon', 'acceptDanger', 'setUiOptions'].forEach(function (name) {
        downloads[name] = api('downloads.' + name)
      })
      // these return nothing in Chrome
      ;['showDefaultFolder', 'setShelfEnabled'].forEach(function (name) {
        downloads[name] = function (...args) {
          call('downloads.' + name, args, null).catch(() => {})
        }
      })
      ;['onCreated', 'onChanged', 'onErased', 'onDeterminingFilename'].forEach(function (name) {
        downloads[name] = event('downloads.' + name)
      })
      define('downloads', Object.assign({}, chrome.downloads, downloads))
    }

    // the library's settings never answer
    if (permissions.has('privacy')) {
      const privacy = {}
      const names = ['network.networkPredictionEnabled', 'network.webRTCIPHandlingPolicy', 'services.alternateErrorPagesEnabled',
        'services.autofillAddressEnabled', 'services.autofillCreditCardEnabled', 'services.autofillEnabled', 'services.passwordSavingEnabled',
        'services.safeBrowsingEnabled', 'services.safeBrowsingExtendedReportingEnabled', 'services.searchSuggestEnabled',
        'services.spellingServiceEnabled', 'services.translationServiceEnabled', 'websites.adMeasurementEnabled', 'websites.doNotTrackEnabled',
        'websites.fledgeEnabled', 'websites.hyperlinkAuditingEnabled', 'websites.protectedContentEnabled', 'websites.referrersEnabled',
        'websites.relatedWebsiteSetsEnabled', 'websites.thirdPartyCookiesAllowed', 'websites.topicsEnabled']
      names.forEach(function (name) {
        const [group, key] = name.split('.')
        privacy[group] = privacy[group] || {}
        privacy[group][key] = {
          get: (details, callback) => call('privacy.get', [name], typeof details === 'function' ? details : callback),
          set: (details, callback) => call('privacy.set', [name, details], callback),
          clear: (details, callback) => call('privacy.clear', [name], typeof details === 'function' ? details : callback),
          onChange: event('privacy.onChange.' + name)
        }
      })
      define('privacy', privacy)
    }

    if (permissions.has('identity')) {
      define('identity', {
        getRedirectURL: path => 'https://' + extensionId + '.chromiumapp.org/' + String(path || '').replace(/^\//, ''),
        launchWebAuthFlow: api('identity.launchWebAuthFlow'),
        getAuthToken: api('identity.getAuthToken'),
        removeCachedAuthToken: api('identity.removeCachedAuthToken'),
        clearAllCachedAuthTokens: api('identity.clearAllCachedAuthTokens'),
        getProfileUserInfo: api('identity.getProfileUserInfo'),
        getAccounts: api('identity.getAccounts'),
        onSignInChanged: event('identity.onSignInChanged')
      })
    }

    if (permissions.has('sidePanel')) {
      const sidePanel = { onOpened: event('sidePanel.onOpened'), onClosed: event('sidePanel.onClosed') }
      ;['setOptions', 'getOptions', 'setPanelBehavior', 'getPanelBehavior', 'open', 'close'].forEach(function (name) {
        sidePanel[name] = api('sidePanel.' + name)
      })
      define('sidePanel', sidePanel)
    }

    if (permissions.has('browsingData')) {
      const remove = api('browsingData.remove')
      const browsingData = { remove, settings: api('browsingData.settings') }
      const types = {
        removeAppcache: 'appcache',
        removeCache: 'cache',
        removeCacheStorage: 'cacheStorage',
        removeCookies: 'cookies',
        removeDownloads: 'downloads',
        removeFileSystems: 'fileSystems',
        removeFormData: 'formData',
        removeHistory: 'history',
        removeIndexedDB: 'indexedDB',
        removeLocalStorage: 'localStorage',
        removePasswords: 'passwords',
        removePluginData: 'pluginData',
        removeServiceWorkers: 'serviceWorkers',
        removeWebSQL: 'webSQL'
      }
      Object.keys(types).forEach(function (method) {
        browsingData[method] = (options, callback) => remove(options, { [types[method]]: true }, ...(callback ? [callback] : []))
      })
      define('browsingData', browsingData)
    }

    if (permissions.has('search')) {
      define('search', { query: api('search.query') })
    }

    // speech: options.onEvent stays here, and gets the events main sends for its request
    if (permissions.has('tts')) {
      const speechCallbacks = new Map()
      const speechEvents = event('tts.onEvent')
      let listeningForSpeech = false
      define('tts', {
        speak: function (utterance, options, callback) {
          if (typeof options === 'function') {
            callback = options
            options = {}
          }
          options = Object.assign({}, options)
          const requestId = Math.random().toString(36).slice(2)
          if (typeof options.onEvent === 'function') {
            speechCallbacks.set(requestId, options.onEvent)
            if (!listeningForSpeech) {
              listeningForSpeech = true
              speechEvents.addListener(function (speech) {
                const onEvent = speechCallbacks.get(speech.requestId)
                if (!onEvent) {
                  return
                }
                if (['end', 'interrupted', 'cancelled', 'error'].includes(speech.type)) {
                  speechCallbacks.delete(speech.requestId)
                }
                onEvent({ type: speech.type, charIndex: speech.charIndex, errorMessage: speech.errorMessage })
              })
            }
          }
          delete options.onEvent
          return call('tts.speak', [String(utterance), options, requestId], callback)
        },
        stop: api('tts.stop'),
        pause: api('tts.pause'),
        resume: api('tts.resume'),
        isSpeaking: api('tts.isSpeaking'),
        getVoices: api('tts.getVoices'),
        onVoicesChanged: event('tts.onVoicesChanged')
      })
    }

    const action = chrome.action || chrome.browserAction
    // events newer Chrome sends and Min doesn't: when the user pins or unpins the button (Min's toolbar doesn't), and
    // when Chrome finds the extension slowing the browser down
    if (action && !action.onUserSettingsChanged) {
      action.onUserSettingsChanged = event('action.onUserSettingsChanged')
    }
    if (!chrome.runtime.onPerformanceWarning) {
      chrome.runtime.onPerformanceWarning = event('runtime.onPerformanceWarning')
    }

    // the library drops a Manifest V3 icon given as pixels; it's sent as PNG data here
    if (manifest.manifest_version === 3 && action && typeof action.setIcon === 'function' && typeof OffscreenCanvas === 'function') {
      const setIcon = action.setIcon
      const toDataURL = async function (imageData) {
        const canvas = new OffscreenCanvas(imageData.width, imageData.height)
        canvas.getContext('2d').putImageData(imageData, 0, 0)
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        }
        return 'data:image/png;base64,' + btoa(binary)
      }
      action.setIcon = function (details, callback) {
        if (!details || !details.imageData) {
          return setIcon(details, callback)
        }
        const single = details.imageData.data && details.imageData.width
        const sizes = single ? { [details.imageData.width]: details.imageData } : details.imageData
        const sent = Promise.all(Object.keys(sizes).map(async size => [size, await toDataURL(sizes[size])])).then(function (entries) {
          const icon = Object.assign({}, details, { imageData: Object.fromEntries(entries) })
          delete icon.path
          return bridge.invoke(extensionId, 'browserAction.setIcon', [icon])
        })
        return settle(sent, callback)
      }
    }
  }

  if (process.contextIsolated && contextBridge.executeInMainWorld) {
    contextBridge.executeInMainWorld({ func: extendExtensionAPIs, args: [bridge] })
  } else {
    extendExtensionAPIs(bridge)
  }
})()
