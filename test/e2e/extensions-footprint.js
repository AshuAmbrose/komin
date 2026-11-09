// Phase 7, low-resource mode for extensions: with Dark Reader and Bitwarden installed, their processes are left alone while
// Min is in use and trimmed (working set) while it's minimized. Sizes from app.getAppMetrics every 10 s over two 60 s passes
// per phase; the window is kept focused (on top, focused again every 2 s) in the first phase, and focus is recorded.
const t = require('./harness')({ name: 'extensions-footprint', minutes: 8, extensions: ['eimadpbcbfnmbkopoojfekhnkhdbieeh', 'nngceckbapebfimnlniiiahkandclblb'] })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const DARK_READER = t.crx('eimadpbcbfnmbkopoojfekhnkhdbieeh')
const BITWARDEN = t.crx('nngceckbapebfimnlniiiahkandclblb')
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
// renderer processes that aren't the UI, a tab, or a Min window: the extensions' (and Chromium's spare renderer)
const OTHER_RENDERERS = `(() => {
  const electron = process.mainModule.require('electron')
  const known = new Set(electron.webContents.getAllWebContents().filter(wc => !wc.getURL().startsWith('chrome-extension://')).map(wc => wc.getOSProcessId()))
  return electron.app.getAppMetrics().filter(m => m.type === 'Tab' && !known.has(m.pid)).map(m => ({ pid: m.pid, mb: Math.round(m.memory.workingSetSize / 1024) }))
})()`
// samples every 10 s for the given time: {pid: [sizes]} and the focus samples
async function sample (main, ms, keepFocused) {
  const sizes = {}
  const focus = []
  const end = Date.now() + ms
  let nextSample = 0
  while (Date.now() < end) {
    if (keepFocused) {
      focus.push(await main.evaluate(`(() => { const win = ${WIN}; if (!win.isFocused()) win.focus(); return win.isFocused() })()`))
    }
    if (Date.now() >= nextSample) {
      nextSample = Date.now() + 10000
      for (const p of await main.evaluate(OTHER_RENDERERS)) {
        (sizes[p.pid] = sizes[p.pid] || []).push(p.mb)
      }
    }
    await sleep(2000)
  }
  return { sizes, focusedShare: focus.length ? focus.filter(Boolean).length / focus.length : null }
}
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    for (const crx of [DARK_READER, BITWARDEN]) {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx)}; 1`)
      console.log('installed', await s.evaluate("extensionPages.request('install-crx').catch(e => 'ERROR ' + e.message)"))
    }
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(PAGE + '?footprint')} }); 1`)
    await sleep(5000)

    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    const inUse = await sample(main, 130000, true)
    console.log('in use:', JSON.stringify(inUse))
    // a process trimmed shows a sharp drop from its largest size
    const dropped = sizes => Object.values(sizes).filter(list => list.length > 1 && Math.min(...list.slice(1)) < Math.max(...list) * 0.3).length
    if (inUse.focusedShare === 1) {
      check('while Min is in use, extension processes keep their memory', dropped(inUse.sizes) === 0, inUse.sizes)
    } else {
      check('Min stayed focused for the in-use check (it didn\'t here, so that check was skipped)', false, inUse.focusedShare)
    }

    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(false); win.minimize(); return 1 })()`)
    const minimized = await sample(main, 130000, false)
    console.log('minimized:', JSON.stringify(minimized))
    // every extension process that lived through a whole pass was trimmed
    const longLived = Object.entries(minimized.sizes).filter(([pid, list]) => list.length >= 8)
    const trimmed = longLived.filter(([pid, list]) => Math.min(...list) < Math.max(...list) * 0.3 || Math.max(...list) < 20)
    check('while Min is minimized, extension processes are trimmed', longLived.length > 0 && trimmed.length === longLived.length, { longLived: longLived.length, trimmed: trimmed.length })

    await main.evaluate(`(() => { const win = ${WIN}; win.restore(); return 1 })()`)
    await sleep(3000)
    const workers = await main.evaluate("Object.values(process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.getAllRunning()).map(w => w.scope)")
    check('the extensions still run afterwards', workers.some(w => w.includes('eimadpbcbfnmbkopoojfekhnkhdbieeh')) && workers.some(w => w.includes('nngceckbapebfimnlniiiahkandclblb')), workers)
    const page = await target(t => t.url === PAGE + '?footprint')
    await page.evaluate('location.reload(); 1')
    await sleep(3000)
    const darkened = await (await target(t => t.url === PAGE + '?footprint')).evaluate("!!document.querySelector('style.darkreader, .darkreader')")
    check('Dark Reader still darkens a page after trimming', darkened)
    s.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
