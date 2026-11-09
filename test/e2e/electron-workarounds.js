// Are Min's workarounds for Electron still needed? Run this after every Electron upgrade (AGENTS.md, section 15).
// Min's lifecycle delivery and its `browser` fix are switched off in js/preload/extensionSupport.js for this run only
// (t.patchFile puts the file back): does Electron send runtime.onInstalled/onStartup itself, and is `browser` still a
// separate object (pitfall 17)? And a rules-only extension loaded straight into Electron, without Min's install path:
// are its rulesets marked "enabled" switched on (pitfall 26)? Also off: Min putting back the API objects Chromium rebuilds
// when another extension loads (pitfall 47) and its chrome.tabs constants (pitfall 48): still missing without Min?
// A PASS here means "the workaround is still needed". A FAIL means Electron changed: check whether Min's workaround can go.
const t = require('./harness')({ name: 'electron-workarounds', minutes: 8 })
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
  return text
})
const LIFECYCLE = t.extension('lifecycle-probe')
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
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
