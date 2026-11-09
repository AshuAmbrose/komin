/* Runs in extensions' pages and background workers just before electron-chrome-extensions' own preload (registered by
   main/extensions.js; js/preload/extensionSupport.js runs just after it). It also starts in every web page's frames and
   service workers in that session, so it does nothing outside chrome-extension:// pages. It:
   - skips the library's last step, freezing `chrome`, which real Chrome doesn't: SponsorBlock adds to it and stopped at
     start, and extensionSupport.js adds Min's APIs to it too;
   - stops the camera, microphone and device list in extensions' offscreen documents.
     Electron makes those itself, not as its own web contents, and asking for media there crashes the whole browser
     (Electron 45; Awesome Screenshot did). They're the extension pages without context isolation; there, those calls
     fail as if the user had said no. */

;(function () {
  if (process.type !== 'service-worker' && !location.href.startsWith('chrome-extension://')) {
    // a blank frame inside such a page has its own copy of the media functions
    let parent = ''
    try {
      parent = !process.contextIsolated && window.top !== window ? window.top.location.href : ''
    } catch (e) {}
    if (!parent.startsWith('chrome-extension://')) {
      return
    }
  }
  const { contextBridge } = require('electron')

  // runs in the extension's own world (a worker's preload has no location, so the URL is checked there)
  function skipChromeFreeze () {
    if (!globalThis.location.href.startsWith('chrome-extension://')) {
      return
    }
    const freeze = Object.freeze
    Object.freeze = function (object) {
      if (object !== undefined && object === globalThis.chrome) {
        Object.freeze = freeze
        return object
      }
      return freeze(object)
    }
  }

  function refuseMedia () {
    const refused = () => new DOMException('Extensions\' hidden pages can\'t use the camera, microphone or screen in Min.', 'NotAllowedError')
    MediaDevices.prototype.getUserMedia = () => Promise.reject(refused())
    MediaDevices.prototype.getDisplayMedia = () => Promise.reject(refused())
    MediaDevices.prototype.enumerateDevices = () => Promise.resolve([])
    navigator.getUserMedia = navigator.webkitGetUserMedia = function (constraints, success, failure) {
      if (typeof failure === 'function') {
        setTimeout(() => failure(refused()), 0)
      }
    }
  }

  if (process.type === 'service-worker' || process.contextIsolated) {
    if (contextBridge.executeInMainWorld) {
      contextBridge.executeInMainWorld({ func: skipChromeFreeze })
    }
  } else {
    // without context isolation, this already runs in the page's world
    refuseMedia()
    if (location.href.startsWith('chrome-extension://')) {
      skipChromeFreeze()
    }
  }
})()
