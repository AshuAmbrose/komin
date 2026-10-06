var scriptsToRun = []

/* a collection of various hacks to unbreak sites, mainly due to missing window.open() support */

/* all sites - re-implements window.close, since the built-in function doesn't work correctly */

window.addEventListener('message', function (e) {
  if (e.data === 'close-window') {
    ipc.send('close-window')
  }
})

if (process.isMainFrame) {
  // window.close() isn't implemented in electron by default
  // only enable for main frame, so that calling window.close() from an iframe doesn't close the entire tab
  scriptsToRun.push(`
  window.close = function () {
    postMessage('close-window', '*')
  }
`)
}

if ((window.location.hostname === 'google.com' || window.location.hostname.endsWith('.google.com')) && window.location.hostname !== 'hangouts.google.com' && window.location.hostname !== 'drive.google.com' && window.location.hostname !== 'accounts.google.com') {
  /* define window.chrome
     this is necessary because some websites (such as the Google Drive file viewer, see issue #378) check for a
     Chrome user agent, and then do things like if(chrome.<module>) {}
     so we need to create a chrome object to prevent errors
     (https://github.com/electron/electron/issues/16587)

     However, if window.chrome exists, hangouts will attempt to connect to an extension and break
     (https://github.com/minbrowser/min/issues/1051)
     so don't enable it there

     As of 2/7/22, this also breaks drive, so disable it there also
     */

  scriptsToRun.push(`
    window.chrome = {
      runtime: {
        connect: () => {
          return {
            onMessage: {
              addListener: () => {console.warn('chrome.runtime is not implemented')},
              removeListener: () => {console.warn('chrome.runtime is not implemented')},
            },
            postMessage: () => {console.warn('chrome.runtime is not implemented')},
            disconnect: () => {console.warn('chrome.runtime is not implemented')},
          }
        }
      }
    }
  `)
}

/* accounts.google.com - ensure consistent Firefox identity by hiding Chromium userAgentData */
if (window.location.hostname === 'accounts.google.com') {
  scriptsToRun.push(`
    try {
      if (window.chrome) {
        delete window.chrome
      }
      if (navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => undefined,
          configurable: true
        })
      }
    } catch (e) {}
  `)
}

/* drive.google.com - fixes clicking on files to open them */

if (window.location.hostname === 'drive.google.com') {
  scriptsToRun.push(`
    var realWindowOpen = window.open

    window.open = function (url) {
      if (url) {
        return realWindowOpen(url)
      }
      return {
        document: new Proxy({}, {
          get: function () {
            return function () {
              return document.createElement('div')
            }
          },
          set: function () {
            console.warn('unpatched set', arguments)}
        }
        ),
        location: {
          replace: function (location) {
            realWindowOpen(location)
          }
        }
      }
    }
  `)
}

/* news.google.com - fixes clicking on news articles */

if (window.location.hostname === 'news.google.com') {
  scriptsToRun.push(`
    window.open = null
  `)
}

/* calendar.google.com - fixes clicking on URLs in event descriptions */
if (window.location.hostname === 'calendar.google.com') {
  scriptsToRun.push(`
    window.open = null
  `)
}

/* meet.google.com - fix permission prompt for microphone and camera not appearing */
if (window.location.hostname === 'meet.google.com') {
  scriptsToRun.push(`
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  `)
}

/* Track active WebSockets dynamically to protect real-time messaging tabs */
scriptsToRun.push(`
  try {
    let activeSockets = 0;
    const OriginalWS = window.WebSocket;
    if (OriginalWS) {
      window.WebSocket = function(...args) {
        const ws = new OriginalWS(...args);
        activeSockets++;
        const onEnd = () => {
          activeSockets = Math.max(0, activeSockets - 1);
          window.__minActiveSockets = activeSockets;
          ws.removeEventListener('close', onEnd);
          ws.removeEventListener('error', onEnd);
        };
        ws.addEventListener('close', onEnd);
        ws.addEventListener('error', onEnd);
        window.__minActiveSockets = activeSockets;
        return ws;
      };
      window.WebSocket.prototype = OriginalWS.prototype;
      Object.setPrototypeOf(window.WebSocket, OriginalWS);
      window.__minActiveSockets = 0;
    }
  } catch (e) {}
`)

/* youtube.com - fix stuck video title when returning to homepage */
scriptsToRun.push(`
  (function () {
    if (!window.location.hostname || !window.location.hostname.includes('youtube.com')) {
      return;
    }
    function fixYouTubeTitle () {
      try {
        const path = window.location.pathname;
        if (path === '/' || path === '') {
          const countMatch = document.title.match(/^\\(\\d+\\)\\s*/);
          const prefix = countMatch ? countMatch[0] : '';
          const target = prefix + 'YouTube';
          if (document.title !== target) {
            document.title = target;
          }
        }
      } catch (e) {}
    }

    function scheduleFix () {
      fixYouTubeTitle();
      setTimeout(fixYouTubeTitle, 100);
      setTimeout(fixYouTubeTitle, 500);
    }

    window.addEventListener('yt-navigate-finish', scheduleFix, true);
    document.addEventListener('yt-navigate-finish', scheduleFix, true);
    window.addEventListener('yt-page-data-updated', scheduleFix, true);
    window.addEventListener('popstate', scheduleFix, true);

    const originalPushState = history.pushState;
    if (originalPushState) {
      history.pushState = function (...args) {
        const ret = originalPushState.apply(this, args);
        scheduleFix();
        return ret;
      };
    }

    const originalReplaceState = history.replaceState;
    if (originalReplaceState) {
      history.replaceState = function (...args) {
        const ret = originalReplaceState.apply(this, args);
        scheduleFix();
        return ret;
      };
    }

    function setupObserver () {
      const titleEl = document.querySelector('title');
      if (titleEl) {
        new MutationObserver(function () {
          const path = window.location.pathname;
          if (path === '/' || path === '') {
            fixYouTubeTitle();
          }
        }).observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      scheduleFix();
      setupObserver();
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        scheduleFix();
        setupObserver();
      });
    }
  })();
`)

if (scriptsToRun.length > 0) {
  setTimeout(function () {
    electron.webFrame.executeJavaScript(scriptsToRun.join(';'))
  }, 0)
}