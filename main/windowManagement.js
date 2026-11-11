const windows = {
  openWindows: [],
  hasEverCreatedWindow: false,
  nextId: 1,
  windowFromContents: function (webContents) {
    return windows.openWindows.find(w => getWindowWebContents(w.win).id === webContents.id)
  },
  addWindow: function (window) {
    windows.hasEverCreatedWindow = true

    windows.openWindows.push({
      id: windows.nextId.toString(),
      win: window,
      state: {}
    })

    window.on('focus', function () {
      windows.getState(window).lastFocused = Date.now()
    })

    window.on('close', function(e) {
      // the UI saves the session as its window closes (js/sessionRestore.js). Its page is never unloaded here, so its
      // beforeunload doesn't run: ask it first, then close (Quit closes every window this way too)
      const entry = windows.openWindows.find(w => w.win === window)
      const ui = getWindowWebContents(window)
      if (entry && !entry.sessionSaved && ui && !ui.isDestroyed()) {
        e.preventDefault()
        if (!entry.savingSession) {
          entry.savingSession = true
          entry.afterSessionSaved = function () {
            if (entry.sessionSaved) {
              return
            }
            entry.sessionSaved = true
            clearTimeout(entry.sessionSaveTimeout)
            if (windows.quitting) {
              app.quit()
            } else if (!window.isDestroyed()) {
              window.close()
            }
          }
          // a UI that doesn't answer can't keep the window open
          entry.sessionSaveTimeout = setTimeout(entry.afterSessionSaved, 2000)
          ui.send('save-session-before-close')
        }
        return
      }
      // detach WebContentsViews to ensure they aren't destroyed when the window is closed
      window.getContentView().children.slice(1).forEach(child => window.getContentView().removeChildView(child))
      windows.openWindows.find(w => w.win === window).closed = true
    })

    window.on('closed', function() {
      windows.removeWindow(window)

      // Quit on last window closed (ignoring secondary and hidden windows)
      if (windows.openWindows.length === 0 && process.platform !== 'darwin') {
        app.quit()
      }
    })
  
    windows.nextId++
  },
  quitting: false,
  removeWindow: function (window) {
    windows.openWindows.splice(windows.openWindows.findIndex(w => w.win === window), 1)

    //unload WebContentsViews when all windows are closed
    if (windows.openWindows.length === 0) {
      destroyAllViews()
    }
  },
  getCurrent: function () {
    const lastFocused = windows.openWindows.filter(w => !w.closed).sort((a, b) => b.state.lastFocused - a.state.lastFocused)[0]
    if (lastFocused) {
      return lastFocused.win
    } else {
      return null
    }
  },
  getAll: function () {
    return windows.openWindows.filter(w => !w.closed).map(w => w.win)
  },
  getState: function (window) {
    return windows.openWindows.find(w => w.win === window).state
  }
}
