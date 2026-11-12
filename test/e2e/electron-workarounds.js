// Are Min's workarounds for Electron still needed? Run this after every Electron upgrade (AGENTS.md, section 15).
// Min's lifecycle delivery and its `browser` fix are switched off in js/preload/extensionSupport.js for this run only
// (t.patchFile puts the file back): does Electron send runtime.onInstalled/onStartup itself, and is `browser` still a
// separate object (pitfall 17)? And a rules-only extension loaded straight into Electron, without Min's install path:
// are its rulesets marked "enabled" switched on (pitfall 26)? Also off: Min putting back the API objects Chromium rebuilds
// when another extension loads (pitfall 47) and its chrome.tabs constants (pitfall 48): still missing without Min?
// And with Min's tab list for extensions off (main/extensionTabs.js, switched off in main.build.js): does the library on its
// own still list tabs in the order their pages were created, number the tabs a query matched, and drop a tab without a page
// (pitfall 51)? And with Min's permission checks off (main/extensionPermissions.js, and the APIs js/preload/extensionSupport.js
// takes away): does the library still give an extension that asked for nothing every tab's address and every site's cookies?
// A PASS here means "the workaround is still needed". A FAIL means Electron or the library changed: check whether Min's
// workaround can go.
const t = require('./harness')({ name: 'electron-workarounds', minutes: 10 })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
// each switch-off must find its code, or the run would test nothing
const switchOff = (text, code, replacement) => {
  if (!text.includes(code)) {
    throw new Error('electron-workarounds: the code to switch off has moved: ' + code.trim())
  }
  return text.replace(code, replacement)
}
t.patchFile('js/preload/extensionSupport.js', text => {
  text = text.replace(/\r\n/g, '\n')
  text = switchOff(text, "lifecycle: isWorker ? () => ipcRenderer.invoke('min-extension-lifecycle', process.pid) : null", 'lifecycle: null')
  text = switchOff(text, '      globalThis.browser = chrome\n', '')
  text = switchOff(text, "  ipcRenderer.on('min-extension-restore-apis', () => runInExtensionWorld(restoreExtensionAPIs))\n", '')
  text = switchOff(text, 'Object.keys(constants).filter(name => chrome.tabs[name] === undefined).forEach(', '[].forEach(')
  text = switchOff(text, '        if (!declared.has(name)) {\n', '        if (false) {\n')
  return text
})
// the generated file, for this run only (npm run build first, as for every suite)
t.patchFile('main.build.js', text => switchOff(switchOff(text.replace(/\r\n/g, '\n'), '  startExtensionTabSync()\n', '\n'), '  startExtensionPermissionChecks()\n', '\n'))
const LIFECYCLE = t.extension('lifecycle-probe')
const TABS = t.extension('tabs')
const UNPRIVILEGED = t.extension('unprivileged')
const page = name => PAGE + '?' + name
const RULES = t.extension('network-noworker', 'rules-fresh')
const workerOf = id => target(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://' + id + '/'), 10000)
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(LIFECYCLE)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    await sleep(2000)
    let w = await workerOf(id)
    const installEvents = w && await w.evaluate('self.events')
    const browserInfo = w && await w.evaluate('self.browserInfo()')
    check('still needed: Electron doesn\'t send runtime.onInstalled (Min\'s delivery off)', Array.isArray(installEvents) && !installEvents.some(e => e.startsWith('installed')), installEvents)
    check('still needed: `browser` isn\'t the same object as `chrome` (Min\'s fix off)', browserInfo && browserInfo.exists && !browserInfo.sameObject, browserInfo)
    const tabIdNone = w && await w.evaluate('typeof chrome.tabs.TAB_ID_NONE')
    check('still needed: the library\'s chrome.tabs has no TAB_ID_NONE (Min\'s constants off)', tabIdNone === 'undefined', tabIdNone)
    const tabsCreate = () => w.evaluate('typeof chrome.tabs.create')
    const createBefore = w && await tabsCreate()

    // rulesets, loaded straight into Electron
    const rulesId = await main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.loadExtension(${JSON.stringify(RULES)}).then(e => e.id)`)
    await sleep(1000)
    // loading it rebuilt the first extension's API objects (Min would put them back within 2 s)
    await sleep(2000)
    const createAfter = w && await tabsCreate()
    check('still needed: loading another extension rebuilds a running worker\'s chrome.tabs without the library\'s functions (Min\'s restore off)', createBefore === 'function' && createAfter === 'undefined', { before: createBefore, after: createAfter })
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${rulesId}/manifest.json' }); 1`)
    const rulesPage = await target(t => t.url === `chrome-extension://${rulesId}/manifest.json`)
    // the page's target is listed before its extension APIs are there
    await waitFor(async () => rulesPage && (await rulesPage.evaluate('typeof (globalThis.chrome && chrome.declarativeNetRequest)')) === 'object', 10000)
    const enabled = rulesPage && await rulesPage.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()')
    check('still needed: rulesets marked "enabled" load switched off', Array.isArray(enabled) && !enabled.includes('on'), enabled)
    await main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.removeExtension(${JSON.stringify(rulesId)}); 1`)

    // onStartup after a restart
    s.close()
    u.close()
    if (rulesPage) rulesPage.close()
    if (w) w.close()
    await quit(main)
    main = await launch(PAGE)
    u = await ui()
    await sleep(3000)
    await main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.startWorkerForScope('chrome-extension://${id}/').then(() => 1, e => String(e))`)
    await sleep(1500)
    w = await workerOf(id)
    const restartEvents = w && await w.evaluate('self.events')
    check('still needed: Electron doesn\'t send runtime.onStartup after a restart', Array.isArray(restartEvents) && !restartEvents.includes('startup'), restartEvents)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s2 = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s2.evaluate('typeof extensionPages')) === 'object')
    await s2.evaluate(`extensionPages.request('remove', { id: '${id}' })`)
    u.close()
    await quit(main)

    // the extension library alone with Min's tabs: three tabs opened in the background from wa-a, which Min puts right after
    // it each time (wa-a, wa-d, wa-c, wa-b)
    main = await launch(page('wa-a'))
    u = await ui()
    await sleep(2000)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s3 = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s3.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(TABS)}; 1`)
    const tabsId = await s3.evaluate("extensionPages.request('load-unpacked')")
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(UNPRIVILEGED)}; 1`)
    const unprivilegedId = await s3.evaluate("extensionPages.request('load-unpacked')")
    s3.close()
    await u.evaluate("ipc.emit('extensions-close-tab', {}, tabs.get().find(t => t.url.startsWith('min://app/pages/settings/')).id); 1")
    const idOf = name => u.evaluate(`tabs.get().find(t => t.url === ${JSON.stringify(page(name))}).id`)
    const select = async name => { await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(await idOf(name))}); 1`); await sleep(1500) }
    await select('wa-a')
    const tw = await workerOf(tabsId)
    for (const name of ['wa-b', 'wa-c', 'wa-d']) {
      await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'open-${name}', url: ${JSON.stringify(page(name))}, active: false }); 1`)
      await sleep(2000)
    }
    const ours = urls => urls.filter(url => url && url.includes('?wa-'))
    const minOrder = ours(await u.evaluate('tabs.get().map(t => t.url)'))
    const libraryOrder = tw && ours((await tw.evaluate('listTabs()')).map(x => x.url))
    check('still needed: the library lists tabs in the order their pages were created, not the window\'s (Min\'s tab list off)', minOrder.length === 4 && Array.isArray(libraryOrder) && libraryOrder.length === 4 && JSON.stringify(libraryOrder) !== JSON.stringify(minOrder), { min: minOrder, library: libraryOrder })
    await select('wa-c')
    const active = tw && await tw.evaluate('listTabs({ active: true, currentWindow: true })')
    const place = (await u.evaluate('tabs.get().map(t => t.url)')).indexOf(page('wa-c'))
    check('still needed: the library numbers the tabs a query matched (the active tab gets index 0, not its place)', Array.isArray(active) && active.length === 1 && active[0].index === 0 && place > 0, { active, place })
    await select('wa-a')
    const bBefore = tw && (await tw.evaluate('listTabs()')).find(x => x.url === page('wa-b'))
    if (tw) await tw.evaluate('self.events = []; 1')
    await u.evaluate(`ipc.emit('hibernateTab', {}, ${JSON.stringify(await idOf('wa-b'))}); 1`)
    await sleep(1500)
    const afterHibernating = tw && await tw.evaluate('listTabs()')
    const events = tw && await tw.evaluate('self.events')
    check('still needed: the library drops a tab without a page and reports it closed (a hibernated tab)', !!bBefore && Array.isArray(afterHibernating) && !afterHibernating.some(x => x.url === page('wa-b')) && events.some(e => e.type === 'removed' && e.id === bBefore.id), { before: bBefore, after: afterHibernating, events })
    // an extension without the "tabs" or "cookies" permission (never granted), and with no access to these pages
    const uw = await workerOf(unprivilegedId)
    const pageTab = await target(x => x.type === 'page' && x.url === page('wa-a'), 10000)
    if (pageTab) await pageTab.evaluate("document.cookie = 'secret=1; path=/'; 1")
    await sleep(500)
    const addresses = uw && (await uw.evaluate('listTabs()')).map(x => x.url).filter(Boolean)
    check('still needed: the library gives every extension every tab\'s address (Min\'s permission checks off)', Array.isArray(addresses) && addresses.includes(page('wa-a')), addresses)
    const cookies = uw && await uw.evaluate('readCookies()')
    check('still needed: the library gives every extension every site\'s cookies (Min\'s permission checks off)', Array.isArray(cookies) && cookies.includes('secret=1'), cookies)
    // its bridge to main takes the extension's id as an argument, and stays within reach of the extension's code
    const asAnother = uw && await uw.evaluate(`readCookiesAs(${JSON.stringify(tabsId)})`)
    check('still needed: an extension can call main in another extension\'s name (Min\'s sender check off)', Array.isArray(asAnother) && asAnother.includes('secret=1'), asAnother)
    if (pageTab) pageTab.close()
    if (uw) uw.close()
    if (tw) tw.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
