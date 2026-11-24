// A bare Electron app: the baseline web-platform-tests compares Min with (test/e2e/wpt.js). The same Electron and Chromium
// as Min, none of Min's code: one window with Electron's default settings for web pages (sandboxed, context isolation),
// which the test runner drives over the DevTools protocol. Pop-ups open as plain windows.
const { app, BrowserWindow } = require('electron')

app.whenReady().then(function () {
  const win = new BrowserWindow({ width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true } })
  win.loadURL(process.argv.find(arg => /^https?:\/\//.test(arg)) || 'about:blank')
})

// a test may close the window (window.close()): the app stays, and the runner starts it again
app.on('window-all-closed', function () {})
