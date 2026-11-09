// The Electron version Min runs (package.json's electronVersion); extensions' storage.sync shared by the worker, a page script and the popup, kept
// apart from local storage and across a restart; the password store (async file reads and writes) with concurrent saves,
// a delete and a restart. Passwords are fake test values.
const t = require('./harness')({ name: 'storage-and-passwords', minutes: 8 })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const SYNC = t.extension('sync')
const SYNC_PAGE = PAGE + '?sync'
const fakeAccount = n => ({ domain: 'min-test.example', username: 'user' + n, password: 'PLACEHOLDER_TEST_PASSWORD_' + n })
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    const versions = await main.evaluate('({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node })')
    check('Min runs on the Electron in package.json (' + require('../../package.json').electronVersion + ')', versions.electron === require('../../package.json').electronVersion, versions)

    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(SYNC)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    await sleep(1500)
    let w = await target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'), 10000)
    await w.evaluate("self.setSync('from-worker')")
    const areas = await w.evaluate('self.readAreas()')
    check('storage.sync is its own area, not local', areas.sync === 'from-worker' && areas.local === undefined, areas)
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SYNC_PAGE)} }); 1`)
    const page = await target(t => t.url === SYNC_PAGE && t.type === 'page')
    const seen = await waitFor(async () => { const v = await page.evaluate('(document.documentElement && document.documentElement.dataset.syncSetting) || null'); return typeof v === 'string' && !v.startsWith('EXC') ? v : null }, 8000)
    check('a content script reads what the worker saved in sync', seen === 'from-worker', seen)
    await w.evaluate("self.setSync('second')")
    const changed = await waitFor(async () => { const v = await page.evaluate('document.documentElement.dataset.syncSetting'); return v === 'changed second' ? v : null }, 5000)
    check('...and gets storage.onChanged for sync', changed === 'changed second', await page.evaluate('document.documentElement.dataset.syncSetting'))
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${id}/popup.html' }); 1`)
    const popup = await target(t => t.url === `chrome-extension://${id}/popup.html`)
    check('the extension\'s own page reads the same sync value', (await waitFor(() => popup.evaluate('window.popupSetting || null'), 5000)) === 'second')

    // the password store
    await u.evaluate("ipc.invoke('credentialStoreDeletePassword', { domain: 'min-test.example', username: 'user0' })")
    const before = (await u.evaluate('ipc.invoke("credentialStoreGetCredentials")')).length
    await u.evaluate(`ipc.invoke('credentialStoreSetPassword', ${JSON.stringify(fakeAccount(0))})`)
    await u.evaluate(`Promise.all([1, 2, 3, 4, 5].map(n => ipc.invoke('credentialStoreSetPassword', { domain: 'min-test.example', username: 'user' + n, password: 'PLACEHOLDER_TEST_PASSWORD_' + n }))).then(() => 1)`)
    let credentials = await u.evaluate('ipc.invoke("credentialStoreGetCredentials")')
    let ours = credentials.filter(c => c.domain === 'min-test.example').map(c => c.username).sort()
    check('password store: six saves (five at once) all kept', ours.join(',') === 'user0,user1,user2,user3,user4,user5' && credentials.length === before + 6, ours)
    await u.evaluate("ipc.invoke('credentialStoreDeletePassword', { domain: 'min-test.example', username: 'user3' })")
    credentials = await u.evaluate('ipc.invoke("credentialStoreGetCredentials")')
    check('password store: a delete', !credentials.some(c => c.username === 'user3' && c.domain === 'min-test.example'))

    // a restart
    s.close()
    u.close()
    page.close()
    popup.close()
    w.close()
    await quit(main)
    main = await launch(PAGE)
    u = await ui()
    await sleep(3000)
    w = await target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'), 15000)
    if (!w) {
      // the worker sleeps until something wakes it: a page with its content script does
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SYNC_PAGE + '2')} }); 1`)
      w = await target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'), 15000)
    }
    check('after a restart: the sync value is still there', w && (await w.evaluate('self.readAreas()')).sync === 'second')
    credentials = await u.evaluate('ipc.invoke("credentialStoreGetCredentials")')
    ours = credentials.filter(c => c.domain === 'min-test.example').map(c => c.username).sort()
    check('after a restart: the passwords are still there', ours.join(',') === 'user0,user1,user2,user4,user5', ours)
    for (const n of [0, 1, 2, 4, 5]) {
      await u.evaluate(`ipc.invoke('credentialStoreDeletePassword', { domain: 'min-test.example', username: 'user${n}' })`)
    }
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
