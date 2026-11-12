// Session restore (AGENTS.md section 10.7): tabs opened just before quitting come back at the next start. Min saves the
// session every 30 s and once more as it quits; this checks the second, with the changes made well inside the 30 s:
// Quit in the menu, closing the last window, Quit while Min's window is in the background (where the UI's own save
// does nothing, pitfall 56), and Windows asking before it shuts down (no close event comes then).
const path = require('path')
const { execFileSync } = require('child_process')
const t = require('./harness')({ name: 'session-restore', minutes: 8 })
const { PAGE, sleep, check, finish, launch, quit, ui } = t
const page = name => PAGE + '?' + name
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const savedUrls = () => { try { return JSON.parse(require('fs').readFileSync(require('path').join(t.profileDir, 'sessionRestore.json'), 'utf8')).state.tasks.flatMap(task => task.tabs.map(tab => tab.url)) } catch (e) { return ['unreadable: ' + e.message] } }
const allUrls = u => u.evaluate('tasks.map(task => task.tabs.get().map(t => t.url)).flat()')

;(async () => {
  let main
  try {
    // 1: Quit (app.quit, as the menu's Quit and Ctrl+Q do), 5 s after opening a tab
    main = await launch(page('first'))
    let u = await ui()
    await sleep(1500)
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(page('quit'))} }); 1`)
    await sleep(5000)
    u.close()
    await quit(main)
    const afterQuit = savedUrls()
    check('Quit: the tab opened 5 s before is saved', afterQuit.includes(page('quit')), afterQuit)

    main = await launch(page('second'))
    u = await ui()
    await sleep(2500)
    const restored = await allUrls(u)
    check('Quit: it comes back at the next start', restored.includes(page('quit')), restored)

    // 2: closing the last window (its close button), 5 s after opening a tab
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(page('close'))} }); 1`)
    await sleep(5000)
    u.close()
    t.child().quitting = true // closing the last window ends Min: expected, not a crash (the harness's watchdog)
    await main.evaluate(`(() => { ${WIN}.close(); return 1 })()`).catch(() => {})
    await Promise.race([t.child().exited, sleep(20000)])
    main.close()
    const afterClose = savedUrls()
    check('closing the window: the tab opened 5 s before is saved', afterClose.includes(page('close')), afterClose)

    // 3: Quit while Min isn't the focused window (in the background, where this browser usually is: closed from the
    // taskbar, say), 3 s after it lost focus and 5 s after opening a tab
    main = await launch(page('third'))
    u = await ui()
    await sleep(1500)
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(page('background'))} }); 1`)
    await sleep(2000)
    await main.evaluate(`(() => { ${WIN}.blur(); return 1 })()`)
    await sleep(3000)
    const uiFocused = await u.evaluate("document.body.classList.contains('focused')")
    u.close()
    await quit(main)
    const afterBackgroundQuit = savedUrls()
    check('Quit while Min is in the background: the tab opened 5 s before is saved', afterBackgroundQuit.includes(page('background')), { uiThoughtItWasFocused: uiFocused, saved: afterBackgroundQuit })

    // 4: Windows shutting down, restarting or signing out. No close event comes then: Windows asks every window first
    // (WM_QUERYENDSESSION, sent here on its own, which ends nothing), and Min saves when asked, in the background too
    main = await launch(page('fourth'))
    u = await ui()
    await sleep(1500)
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(page('shutdown'))} }); 1`)
    await sleep(2000)
    const hwnd = await main.evaluate(`(() => { const win = ${WIN}; win.blur(); return String(win.getNativeWindowHandle().readBigUInt64LE(0)) })()`)
    await sleep(2000)
    let asked
    try {
      asked = JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'send-window-message.ps1'), '-Hwnd', hwnd, '-Msg', '17'], { encoding: 'utf8', timeout: 30000 }))
    } catch (e) {
      asked = { error: String(e.message).slice(0, 200) }
    }
    await sleep(1500)
    const afterAsked = savedUrls()
    check('Windows asks before shutting down: the tab opened 5 s before is saved, and Min keeps running', asked.sent === true && afterAsked.includes(page('shutdown')) && t.child().exitCode === null, { asked, stillRunning: t.child().exitCode === null, saved: afterAsked })
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
