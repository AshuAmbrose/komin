// End-to-end test of phase 4 in the dev build: "Add to Chrome" / "Remove from Chrome" on the real Chrome Web Store page,
// the download checks, Settings, and both update paths (automatic, and "asks for more permissions" → review).
// Native dialogs are replaced from the main process (they answer "yes" and are recorded).
const path = require('path')
const fs = require('fs')
const t = require('./harness')({ name: 'extensions-webstore', minutes: 8 })
const { sleep, check, finish, list, target, launch, quit } = t
const waitFor = (fn, ms = 20000) => t.waitFor(fn, ms)
const profile = t.profileDir
const DARK = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
const STORE = 'https://chromewebstore.google.com/detail/dark-reader/' + DARK
const startedAt = Date.now()
const adblockCacheAtStart = (() => { try { return fs.statSync(path.join(profile, 'adblocker-engine-v2.bin')).mtimeMs } catch (e) { return 0 } })()

const readRegistry = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf-8')).extensions } catch (e) { return {} } }
const ui = () => target(t => t.url.startsWith('min://app/index.html'))
// the store page's install button text ("Add to Chrome" / "Remove from Chrome"), once rendered
const storeButton = store => store.evaluate("(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^(Add to|Remove from) /.test(b.innerText.trim())); return b ? b.innerText.trim() + (b.disabled ? ' (disabled)' : '') : null })()")
// the store shows its button disabled while the page is still loading; clicks wait until it's enabled with the expected text
const waitForStoreButton = (store, text) => waitFor(async () => (await storeButton(store)) === text ? text : null, 30000)
async function clickStoreButton (store, text) {
  if (!(await waitForStoreButton(store, text))) {
    return null
  }
  return store.evaluate("(() => { const b = Array.from(document.querySelectorAll('button')).find(b => /^(Add to|Remove from) /.test(b.innerText.trim())); b.click(); return b.innerText.trim() })()")
}
async function openSettings (u) {
  await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
  const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
  await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
  await sleep(500)
  return s
}
const request = (s, action, args) => s.evaluate(`extensionPages.request(${JSON.stringify(action)}, ${JSON.stringify(args || {})}).then(r => ({ result: r }), e => ({ error: e.message }))`)

;(async () => {
  let main
  try {
    main = await launch(STORE)
    if (process.env.WATCHDOG_SELF_TEST) {
      // checks the safeguards: this must stop the run within seconds, without Electron's error dialog
      await main.evaluate("setTimeout(() => { throw new Error('watchdog self-test') }, 100); 1")
      await sleep(60000)
    }
    let store = await target(t => t.url.startsWith(STORE))
    let button = await waitForStoreButton(store, 'Add to Chrome') || await storeButton(store)
    check('store page shows the install button', button === 'Add to Chrome', button)
    check('store page has the store API', (await store.evaluate('typeof chrome.webstorePrivate.beginInstallWithManifest3 + " " + typeof chrome.management.getAll')) === 'function function')
    // records what the store calls, and the events it gets
    await store.evaluate(`(() => { window.__calls = []
      for (const [ns, obj] of [['management', chrome.management], ['webstorePrivate', chrome.webstorePrivate]]) {
        for (const k of Object.keys(obj)) {
          if (typeof obj[k] === 'function') {
            const f = obj[k]
            obj[k] = function (...a) { window.__calls.push(ns + '.' + k + ' ' + JSON.stringify(a.map(x => typeof x === 'function' ? 'fn' : x)).slice(0, 120)); return f.apply(this, a) }
          }
        }
      }
      for (const e of ['onInstalled', 'onUninstalled', 'onEnabled', 'onDisabled']) chrome.management[e].addListener(d => window.__calls.push('EVENT ' + e + ' ' + JSON.stringify(d).slice(0, 60)))
      return 1 })()`)

    // other pages can't use the store API (the UI is a trusted page, and still refused)
    let u = await ui()
    const refused = await u.evaluate("ipc.invoke('extensions-webstore', { action: 'getAll', args: [] })")
    check('store API refused outside the store page', refused && refused.error === 'Not allowed', refused)

    // Add to Chrome
    await clickStoreButton(store, 'Add to Chrome')
    const installed = await waitFor(() => readRegistry()[DARK], 60000)
    let dialogs = await main.evaluate('global.__dialogs')
    const review = dialogs.find(d => d.message && d.message.startsWith('Add'))
    check('Add to Chrome: permission review shown with the store\'s name', review && review.message === 'Add "Dark Reader"?' && /all websites/.test(review.detail) && review.parent, review)
    check('Add to Chrome: installed as a Web Store extension', installed && installed.source === 'webstore', installed)
    check('Add to Chrome: one review only (the download asked for nothing more)', dialogs.filter(d => d.message && d.message.startsWith('Add')).length === 1, dialogs.length)
    // extensions.json is written just before the extension finishes loading
    let state = await waitFor(async () => {
      const loaded = await main.evaluate("process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.getAllExtensions().map(e => e.id + ' ' + e.version)")
      return Array.isArray(loaded) && loaded.length > 0 ? loaded : null
    }, 10000)
    check('Add to Chrome: extension loaded', Array.isArray(state) && state.some(e => e.startsWith(DARK)), state)
    button = await waitFor(async () => { const b = await storeButton(store); return b && b.startsWith('Remove') ? b : null }, 15000)
    check('store button becomes "Remove from Chrome"', button === 'Remove from Chrome', button || await storeButton(store))
    check('store sees it as enabled', (await store.evaluate(`chrome.webstorePrivate.getExtensionStatus('${DARK}', '{}')`)) === 'enabled')
    const all = await store.evaluate('new Promise(r => chrome.management.getAll(r))')
    check('chrome.management.getAll lists it', Array.isArray(all) && all.some(e => e.id === DARK && e.enabled), all)

    // Settings
    let s = await openSettings(u)
    let listed = (await request(s, 'list')).result
    let item = listed && listed.find(e => e.id === DARK)
    check('Settings: shown as from the Chrome Web Store', item && item.source === 'webstore' && item.webStoreURL.endsWith(DARK), item && { source: item.source, webStoreURL: item.webStoreURL })
    check('Settings: source text', await s.evaluate("Array.from(document.querySelectorAll('.extension-item .userscript-detail')).some(d => d.textContent === 'From the Chrome Web Store')"))
    await s.evaluate("document.getElementById('extensions-web-store').click(); 1")
    const storeTab = await waitFor(async () => (await list()).find(t => t.url.startsWith('https://chromewebstore.google.com/category/extensions')), 15000)
    check('Settings: Web Store link opens the store in a tab', storeTab, storeTab && storeTab.url)

    // turning it off in Settings shows on the store page
    await request(s, 'set-enabled', { id: DARK, enabled: false })
    check('store sees it as disabled after Settings turns it off', (await store.evaluate(`chrome.webstorePrivate.getExtensionStatus('${DARK}', '{}')`)) === 'disabled')
    await request(s, 'set-enabled', { id: DARK, enabled: true })

    // Remove from Chrome, with the store's tab in front again (as when a user clicks it; hidden tabs don't redraw)
    await u.evaluate(`(() => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(STORE)})); ipc.emit('extensions-select-tab', {}, tab.id); return tab.id })()`)
    await sleep(1000)
    await main.evaluate('global.__dialogs = []; 1')
    await clickStoreButton(store, 'Remove from Chrome')
    // what happens after the click, second by second (registry entry, files, store button, store's status, loaded in Electron)
    const timeline = []
    for (let second = 0; second < 12; second++) {
      timeline.push([second, !!readRegistry()[DARK], fs.existsSync(path.join(profile, 'extensions', DARK)), await storeButton(store),
        await store.evaluate(`chrome.webstorePrivate.getExtensionStatus('${DARK}', '{}')`),
        await main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.getAllExtensions().length`)].join(' '))
      if (!readRegistry()[DARK] && !fs.existsSync(path.join(profile, 'extensions', DARK))) {
        break
      }
      await sleep(1000)
    }
    check('Remove from Chrome: timeline (info)', true, timeline)
    check('store calls and events (info)', true, await store.evaluate('window.__calls'))
    check('store buttons after removal (info)', true, await store.evaluate("Array.from(document.querySelectorAll('button')).filter(b => /^(Add to|Remove from) /.test(b.innerText.trim())).map(b => { const r = b.getBoundingClientRect(); return b.innerText.trim() + ' visible=' + (r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden') + ' y=' + Math.round(r.y) })"))
    await store.send('Page.captureScreenshot', {}).then(r => r.result && fs.writeFileSync(t.output('after-remove.png'), Buffer.from(r.result.data, 'base64')))
    await waitFor(() => !readRegistry()[DARK], 20000)
    dialogs = await main.evaluate('global.__dialogs')
    check('Remove from Chrome: asks first', dialogs.some(d => d.message === 'Remove "Dark Reader"? The data it saved is deleted too.'), dialogs)
    check('Remove from Chrome: removed', !readRegistry()[DARK] && !fs.existsSync(path.join(profile, 'extensions', DARK)))
    button = await waitFor(async () => { const b = await storeButton(store); return b === 'Add to Chrome' ? b : null }, 15000)
    check('store button back to "Add to Chrome"', button === 'Add to Chrome', button || await storeButton(store))

    // install again for the update tests
    await clickStoreButton(store, 'Add to Chrome')
    await waitFor(() => readRegistry()[DARK], 60000)
    await sleep(2000)

    // update without new permissions: pretend the installed copy is older
    const folder = readRegistry()[DARK].path
    const manifestPath = path.join(folder, 'manifest.json')
    const original = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    fs.writeFileSync(manifestPath, JSON.stringify(Object.assign({}, original, { version: '4.9.100' }), null, 2))
    const before = readRegistry()[DARK]
    let r = await request(s, 'check-updates')
    let after = readRegistry()[DARK]
    check('update: check runs from Settings', !r.error, r.error)
    check('update: installed automatically (no new permissions)', after && after.version === original.version && after.updatedAt > before.updatedAt && !after.pendingUpdate && !after.updateError, after)
    check('update: files replaced with the store version', JSON.parse(fs.readFileSync(path.join(after.path, 'manifest.json'), 'utf-8')).version === original.version)

    // update that asks for more: the installed copy pretends to have had fewer sites
    const narrow = JSON.parse(fs.readFileSync(path.join(after.path, 'manifest.json'), 'utf-8'))
    narrow.version = '4.9.100'
    narrow.host_permissions = ['https://example.com/*']
    narrow.content_scripts = (narrow.content_scripts || []).map(c => Object.assign({}, c, { matches: ['https://example.com/*'] }))
    fs.writeFileSync(path.join(after.path, 'manifest.json'), JSON.stringify(narrow, null, 2))
    await main.evaluate('global.__dialogs = []; 1')
    const beforePending = readRegistry()[DARK]
    r = await request(s, 'check-updates')
    after = readRegistry()[DARK]
    check('update asking for more: waits for review', after.pendingUpdate && after.pendingUpdate.version === original.version && after.updatedAt === beforePending.updatedAt, after)
    check('update asking for more: no dialog by itself', (await main.evaluate('global.__dialogs')).length === 0)
    await sleep(500)
    check('Settings: "review the update" link shown', await s.evaluate("Array.from(document.querySelectorAll('.extension-item a')).some(a => /review the update/.test(a.textContent))"))
    r = await request(s, 'review-update', { id: DARK })
    dialogs = await main.evaluate('global.__dialogs')
    const updateReview = dialogs.find(d => d.message === 'Update "Dark Reader"?')
    check('review: shows only what the update adds', updateReview && /The new version also asks to:\n• Read and change all your data on all websites/.test(updateReview.detail) && updateReview.buttons[0] === 'Update', updateReview)
    after = readRegistry()[DARK]
    check('review: update installed', after.version === original.version && !after.pendingUpdate, after)

    check('no update errors left', !after.updateError, after.updateError)

    // the ad-block lists: a stale cache (over 2 days old) is downloaded again a minute after startup, now with net.fetch
    const cachePath = path.join(profile, 'adblocker-engine-v2.bin')
    const cacheWasStale = startedAt - adblockCacheAtStart > 2 * 24 * 60 * 60 * 1000
    if (cacheWasStale) {
      const refreshed = await waitFor(() => fs.statSync(cachePath).mtimeMs > startedAt, 150000)
      check('ad-block lists downloaded again without a main-process error', refreshed, fs.statSync(cachePath).mtime)
    } else {
      check('ad-block lists: cache wasn\'t stale, download not exercised (info)', true)
    }
    s.close(); store.close(); u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
