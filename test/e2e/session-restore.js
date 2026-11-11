// Session restore (AGENTS.md section 10.7): tabs opened just before quitting come back at the next start. Min saves the
// session every 30 s and once more as it quits; this checks the second, both ways of quitting (Quit in the menu, and
// closing the last window), with the changes made well inside the 30 s.
const t = require('./harness')({ name: 'session-restore', minutes: 6 })
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
    await main.evaluate(`(() => { ${WIN}.close(); return 1 })()`).catch(() => {})
    await Promise.race([t.child().exited, sleep(20000)])
    main.close()
    const afterClose = savedUrls()
    check('closing the window: the tab opened 5 s before is saved', afterClose.includes(page('close')), afterClose)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
