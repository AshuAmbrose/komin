// Real extensions in Min's toolbar: Dark Reader's and Bitwarden's buttons and popups
const fs = require('fs')
const t = require('./harness')({ name: 'extensions-real-popups', minutes: 8, extensions: ['eimadpbcbfnmbkopoojfekhnkhdbieeh', 'nngceckbapebfimnlniiiahkandclblb'] })
const { PAGE, sleep, check, finish, connect, list, waitFor, target, launch, quit, ui, toolbar } = t
const CRX = name => t.crx(IDS[name])
const IDS = { darkreader: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', bitwarden: 'nngceckbapebfimnlniiiahkandclblb' }
const clickButton = (u, id) => u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)

;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    for (const name of Object.keys(IDS)) {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(CRX(name))}; 1`)
      check(name + ' installed', (await s.evaluate("extensionPages.request('install-crx')")) === IDS[name])
    }
    await sleep(3000)
    // close the tabs the extensions opened on install, and go back to the test page
    await u.evaluate(`(() => { tabs.get().filter(t => !t.url.startsWith(${JSON.stringify(PAGE)})).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); return 1 })()`)
    await sleep(1500)
    const bar = await waitFor(async () => { const b = await toolbar(u); return b.buttons.length === 2 ? b : null }, 10000) || await toolbar(u)
    check('two toolbar buttons with icons', bar.buttons.length === 2 && bar.buttons.every(b => b.icon.startsWith('data:image')), bar.buttons.map(b => [b.title, b.icon.length, b.badge]))
    for (const name of Object.keys(IDS)) {
      await clickButton(u, IDS[name])
      const popupTarget = await waitFor(async () => (await list()).find(t => t.url.startsWith('chrome-extension://' + IDS[name] + '/')), 10000)
      check(name + ' popup opens', popupTarget, popupTarget && popupTarget.url)
      if (popupTarget) {
        const page = connect(popupTarget.webSocketDebuggerUrl)
        // Dark Reader shows "Loading, please wait" until its worker answers; once loaded, that overlay turns transparent
        // but stays in the page (and in innerText), marked .loader--complete. After 3 s without an answer it says the
        // UI "couldn't be loaded"
        const popupState = () => page.evaluate("JSON.stringify({ loading: !!document.querySelector('.loader:not(.loader--complete)') || /couldn't be loaded/.test(document.body ? document.body.innerText : ''), text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) : '' })").then(JSON.parse)
        const state = await waitFor(async () => { const v = await popupState(); return !v.loading && v.text.length > 20 ? v : null }, 15000) || await popupState()
        check(name + ' popup has content (not stuck on "Loading")', !state.loading && state.text.length > 20, state)
        const shot = await page.send('Page.captureScreenshot', {})
        if (shot.result) {
          fs.writeFileSync(t.output('popup-' + name + '.png'), Buffer.from(shot.result.data, 'base64'))
        }
        const bounds = await main.evaluate(`(() => { const electron = process.mainModule.require('electron'); const w = electron.BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('chrome-extension://${IDS[name]}/')); return w ? w.getBounds() : null })()`)
        check(name + ' popup size (info)', true, bounds)
        page.close()
      }
      await clickButton(u, IDS[name])
      await sleep(800)
    }
    for (const name of Object.keys(IDS)) {
      await s.evaluate(`extensionPages.request('remove', { id: '${IDS[name]}' })`)
    }
    s.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
