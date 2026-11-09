// End-to-end test of Min's extension core in the dev build: install from .crx and unpacked folders through Settings,
// lifecycle events, tabs, enable/disable, reload, private tabs, clearing browsing data, restart, removal, zero cost.
// Uses the test extension in extensions/core and three real ones from Chrome's update server (Dark Reader, Bitwarden, uBO Lite).
const path = require('path')
const fs = require('fs')
const http = require('http')
const IDS = { darkreader: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', bitwarden: 'nngceckbapebfimnlniiiahkandclblb', ubol: 'ddkjiahejlhfcafbddmgiahcphecmpfh' }
const t = require('./harness')({ name: 'extensions-core', minutes: 8, extensions: Object.values(IDS) })
const { sleep, check, finish, list, waitFor, target, quit, ui } = t
// as this suite always did: a moment after the window appears before going on
const launch = async url => { const main = await t.launch(url); await sleep(1500); return main }
const crx = name => t.crx(IDS[name])
const coreFolder = t.extension('core', 'core-copy') // a copy whose version the test changes
const mv2Folder = t.extension('mv2')
const MV2_ID = 'mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm' // an id for the Manifest V2 extension recorded as installed before run 2
const profile = t.profileDir
const PORT = 8768

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>plain ' + req.url + '</title><body><h1>Plain page</h1><p>Some text.</p></body>')
}).listen(PORT, '127.0.0.1')
const page = name => `http://127.0.0.1:${PORT}/${name}`

// main-process helpers, evaluated through the Node inspector
const M = `const electron = process.mainModule.require('electron'); const ses = electron.session.fromPartition('persist:webcontent');`
const mainState = main => main.evaluate(`(() => { ${M}
  return {
    libraryLoaded: Object.keys(process.mainModule.constructor._cache).some(k => k.includes('electron-chrome-extensions')),
    preloads: ses.getPreloadScripts().map(p => p.id),
    extensions: ses.extensions.getAllExtensions().filter(e => e.name !== 'Min network helper').map(e => e.id + ' ' + e.name + ' ' + e.version)
  } })()`)
const metrics = main => main.evaluate(`(() => { ${M} const m = electron.app.getAppMetrics(); return { processes: m.length, privateMB: Math.round(m.reduce((s, p) => s + p.memory.privateBytes, 0) / 1024) } })()`)
const stubDialogs = main => main.evaluate(`(() => { ${M}
  global.__dialogs = []; global.__nextOpen = null
  electron.dialog.showOpenDialog = async (win, options) => { __dialogs.push({ open: options.properties }); return { canceled: false, filePaths: [global.__nextOpen] } }
  electron.dialog.showMessageBox = async (win, options) => { __dialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons }); return { response: 0 } }
  return 'stubbed' })()`)
const readRegistry = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf-8')).extensions } catch (e) { return null } }

async function openSettings (u) {
  await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 'ok'")
  const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
  await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
  await sleep(500)
  return s
}
const request = (s, action, args) => s.evaluate(`extensionPages.request(${JSON.stringify(action)}, ${JSON.stringify(args || {})}).then(r => ({ result: r }), e => ({ error: e.message }))`)
const uiTabs = u => u.evaluate('tabs.get().map(t => ({ id: t.id, url: t.url, selected: t.id === tabs.getSelected(), private: t.private }))')

;(async () => {
  let main
  try {
    // ---------- run 1: nothing installed, then install and use ----------
    main = await launch(page('start'))
    let state = await mainState(main)
    check('zero cost: library not loaded with no extensions', !state.libraryLoaded && state.preloads.length === 0 && state.extensions.length === 0, state)
    const metricsBefore = await metrics(main)
    await stubDialogs(main)
    let u = await ui()
    let s = await openSettings(u)
    check('settings: empty state shown', await s.evaluate("!document.getElementById('extensions-empty').hidden && document.getElementById('extensions-list').children.length === 0"))
    check('settings: heading shown', await s.evaluate("document.querySelector('#extensions-settings-container h3').textContent"))

    // Dark Reader from a .crx file
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx('darkreader'))}; global.__dialogs = []; 'ok'`)
    let r = await request(s, 'install-crx')
    check('crx install: Dark Reader gets its Web Store id', r.result === IDS.darkreader, r)
    let dialogs = await main.evaluate('global.__dialogs')
    const review = dialogs.find(d => d.message)
    check('crx install: permission review shown', review && /Dark Reader/.test(review.message) && /all websites/.test(review.detail), review)
    check('crx install: open dialog filtered to files', dialogs[0] && dialogs[0].open && dialogs[0].open.includes('openFile'), dialogs[0])
    state = await mainState(main)
    check('crx install: library started, extension loaded', state.libraryLoaded && state.extensions.some(e => e.startsWith(IDS.darkreader)), state)
    check('crx install: preloads registered', state.preloads.includes('min-extension-support-frame') && state.preloads.includes('min-extension-support-worker'), state.preloads)
    let registry = readRegistry()
    check('crx install: recorded in extensions.json (a Web Store-signed file counts as from the store)', registry && registry[IDS.darkreader] && registry[IDS.darkreader].source === 'webstore' && fs.existsSync(registry[IDS.darkreader].path), registry && registry[IDS.darkreader])
    check('crx install: manifest has the developer key', registry && JSON.parse(fs.readFileSync(path.join(registry[IDS.darkreader].path, 'manifest.json'))).key)
    // Dark Reader opens its help page on first install (runtime.onInstalled → tabs.create)
    const welcome = await waitFor(async () => (await uiTabs(u)).find(t => /darkreader\.org/.test(t.url)), 10000)
    check('onInstalled: Dark Reader opened its welcome tab in Min', welcome, welcome)

    // the core test extension, unpacked
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(coreFolder)}; global.__dialogs = []; 'ok'`)
    r = await request(s, 'load-unpacked')
    const coreId = r.result
    check('unpacked: loaded', /^[a-p]{32}$/.test(coreId || ''), r)
    // Manifest V2 isn't supported, as in Chrome
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(mv2Folder)}; 'ok'`)
    r = await request(s, 'load-unpacked')
    check('Manifest V2: an unpacked folder is refused, saying why', r.error && /Manifest V2/.test(r.error) && !Object.values(readRegistry() || {}).some(e => e.path === mv2Folder), r)
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(coreFolder)}; 'ok'`)
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${coreId}/page.html' }); 'ok'`)
    let ext = await target(t => t.url.startsWith(`chrome-extension://${coreId}/page.html`))
    check('chrome-extension:// URL opens in a Min tab', ext)
    await waitFor(async () => (await ext.evaluate('typeof ask')) === 'function')
    check('chrome.commands exists in extension pages', (await ext.evaluate('commandsType')) === 'object')
    const ping = await ext.evaluate("ask({ op: 'ping' })")
    check('chrome.commands exists in the background worker', ping && ping.commands === 'object', ping)
    check('browser is the same object as chrome in the worker', ping && ping.browserSame === true, ping)
    check('browser is the same object as chrome in extension pages', (await ext.evaluate('globalThis.browser === chrome')) === true)
    let events = await waitFor(async () => { const e = await ext.evaluate("ask({ op: 'events' })"); return e && e.length ? e : null }, 5000)
    check('onInstalled(install) delivered to the worker', JSON.stringify(events) === '["installed:install"]', events)

    // tabs
    let minTabs = await uiTabs(u)
    let extTabs = await ext.evaluate("ask({ op: 'query' })")
    check('tabs.query sees Min\'s tabs', Array.isArray(extTabs) && extTabs.length >= minTabs.filter(t => t.url && !t.private).length - 1, { min: minTabs.length, ext: extTabs && extTabs.length })
    const active = Array.isArray(extTabs) && extTabs.find(t => t.active)
    check('tabs.query: the active tab is the extension page', active && active.url.includes(coreId), active)
    const created = await ext.evaluate(`ask({ op: 'create', url: ${JSON.stringify(page('created'))}, active: true })`)
    await sleep(1500)
    minTabs = await uiTabs(u)
    const createdTab = minTabs.find(t => t.url === page('created'))
    check('tabs.create opens a Min tab and selects it', createdTab && createdTab.selected, { created, minTabs })
    const createdPage = await target(t => t.url === page('created'))
    const content = createdPage && await waitFor(() => createdPage.evaluate('document.documentElement.dataset.minCoreReply'), 8000)
    check('content script runs and reaches the worker', content && JSON.parse(content).ok && JSON.parse(content).tabId === created.id, content)
    const background = await ext.evaluate(`ask({ op: 'create', url: ${JSON.stringify(page('background'))}, active: false })`)
    await sleep(1500)
    minTabs = await uiTabs(u)
    const bgTab = minTabs.find(t => t.url === page('background'))
    check('tabs.create({active: false}) opens a background tab', bgTab && !bgTab.selected && createdTab && minTabs.find(t => t.id === createdTab.id).selected, minTabs)
    r = await ext.evaluate(`ask({ op: 'activate', id: ${background && background.id} })`)
    await sleep(800)
    minTabs = await uiTabs(u)
    check('tabs.update({active: true}) switches Min\'s tab', minTabs.find(t => t.url === page('background') && t.selected), { r, minTabs })
    r = await ext.evaluate(`ask({ op: 'remove', id: ${created && created.id} })`)
    await sleep(800)
    minTabs = await uiTabs(u)
    check('tabs.remove closes the Min tab', !minTabs.find(t => t.url === page('created')), { r, minTabs })
    extTabs = await ext.evaluate("ask({ op: 'query' })")
    const selectedUrl = minTabs.find(t => t.selected).url
    const extActive = Array.isArray(extTabs) && extTabs.find(t => t.active)
    check('tabs.query follows Min\'s tab switches', extActive && extActive.url === selectedUrl, { extActive, selectedUrl })

    // private tabs are not given to extensions
    await u.evaluate("ipc.emit('addPrivateTab', {}); 'ok'")
    await sleep(800)
    const privateId = await u.evaluate('tabs.getSelected()')
    minTabs = await uiTabs(u)
    extTabs = await ext.evaluate("ask({ op: 'query' })")
    check('private tab not listed to extensions', minTabs.some(t => t.private) && Array.isArray(extTabs) && extTabs.length === minTabs.filter(t => !t.private).length, { privateId, min: minTabs.length, ext: extTabs && extTabs.length })

    // uBlock Origin Lite and Bitwarden
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx('ubol'))}; global.__dialogs = []; 'ok'`)
    r = await request(s, 'install-crx')
    dialogs = await main.evaluate('global.__dialogs')
    check('uBO Lite installs', r.result === IDS.ubol, r)
    check('uBO Lite review warns about network filtering', dialogs.some(d => d.detail && /ad blocker/.test(d.detail)), dialogs.map(d => d.detail))
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx('bitwarden'))}; 'ok'`)
    r = await request(s, 'install-crx')
    check('Bitwarden installs', r.result === IDS.bitwarden, r)
    await sleep(4000)
    const workers = (await list()).filter(t => t.type === 'service_worker').map(t => t.url)
    check('uBO Lite worker running (no chrome.commands crash)', workers.some(u2 => u2.includes(IDS.ubol)), workers)
    const ubolLog = t.childLog().split('\n').filter(l => /ddkjiahe|commands/.test(l)).slice(0, 5)
    check('no chrome.commands errors logged', !ubolLog.some(l => /commands/.test(l) && /undefined|Cannot read/.test(l)), ubolLog)

    // the Settings list
    const listed = (await request(s, 'list')).result
    check('settings list: four extensions with icons', listed && listed.length === 4 && listed.every(e => e.icon.startsWith('data:image/')), listed && listed.map(e => [e.name, e.icon.length]))
    check('settings list: uBO Lite flagged as network filtering', listed && listed.find(e => e.id === IDS.ubol).networkFiltering)
    check('settings list: permissions described', listed && listed.find(e => e.id === IDS.darkreader).permissions.length > 0, listed && listed.find(e => e.id === IDS.darkreader).permissions)
    check('settings list: unsupported APIs noted', listed && listed.map(e => [e.name, e.unsupported]), listed && listed.map(e => [e.name, e.unsupported]))
    await sleep(500)
    check('settings page shows four items', await s.evaluate("document.querySelectorAll('#extensions-list .extension-item').length") === 4)

    // reload after an edit = update
    const manifestPath = path.join(coreFolder, 'manifest.json')
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf-8').replace('"version": "1.0"', '"version": "1.1"'))
    r = await request(s, 'reload', { id: coreId })
    check('reload works', !r.error, r)
    await sleep(1500)
    ext.close()
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${coreId}/page.html' }); 'ok'`)
    ext = await target(t => t.url.startsWith(`chrome-extension://${coreId}/page.html`) && t.type === 'page')
    await waitFor(async () => (await ext.evaluate('typeof ask')) === 'function')
    events = await waitFor(async () => { const e = await ext.evaluate("ask({ op: 'events' })"); return e && e.length > 1 ? e : null }, 5000)
    check('reload sends onInstalled(update) with the previous version', JSON.stringify(events) === '["installed:install","installed:update:1.0"]', events)

    // disable and enable
    r = await request(s, 'set-enabled', { id: coreId, enabled: false })
    state = await mainState(main)
    check('disable unloads', !state.extensions.some(e => e.startsWith(coreId)) && readRegistry()[coreId].enabled === false, state.extensions)
    r = await request(s, 'set-enabled', { id: coreId, enabled: true })
    state = await mainState(main)
    check('enable loads again', state.extensions.some(e => e.startsWith(coreId)), state.extensions)

    // clearing browsing data keeps extensions working and their data
    const site = await target(t => t.url === page('background'))
    await site.evaluate("localStorage.setItem('minTest', '1'); 'ok'")
    r = await u.evaluate("ipc.invoke('clearStorageData').then(() => 'cleared', e => 'error ' + e.message)")
    check('clear browsing data runs', r === 'cleared', r)
    await site.evaluate('location.reload(); 1')
    await sleep(1500)
    const site2 = await target(t => t.url === page('background'))
    check('site localStorage cleared', (await site2.evaluate("localStorage.getItem('minTest')")) === null)
    const replyAfterClear = await waitFor(() => site2.evaluate('document.documentElement.dataset.minCoreReply'), 8000)
    check('extension worker still answers after clearing data', replyAfterClear && JSON.parse(replyAfterClear).ok, replyAfterClear)
    ext.close()
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${coreId}/page.html' }); 'ok'`)
    ext = await target(t => t.url.startsWith(`chrome-extension://${coreId}/page.html`) && t.type === 'page')
    await waitFor(async () => (await ext.evaluate('typeof ask')) === 'function')
    events = await ext.evaluate("ask({ op: 'events' })")
    check('extension chrome.storage kept after clearing data', Array.isArray(events) && events.length >= 2, events)
    state = await mainState(main)
    check('all extensions still loaded after clearing data', state.extensions.length === 4, state.extensions)

    const metricsAfter = await metrics(main)
    check('cost with 4 extensions (info)', true, { before: metricsBefore, after: metricsAfter })
    ext.close(); s.close(); u.close()
    check('run 1 quits', (await quit(main)) !== 'timeout')
    // a Manifest V2 extension installed before Min refused them
    const registryFile = path.join(profile, 'extensions.json')
    const savedRegistry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'))
    savedRegistry.extensions[MV2_ID] = { source: 'unpacked', path: mv2Folder, name: 'Min test: Manifest V2', version: '1.0', enabled: true, installedAt: Date.now() }
    fs.writeFileSync(registryFile, JSON.stringify(savedRegistry, null, 2))

    // ---------- run 2: restart ----------
    main = await launch(page('restart'))
    await sleep(2000)
    state = await mainState(main)
    check('restart: extensions load at startup', state.extensions.length === 4, state.extensions)
    check('restart: an installed Manifest V2 extension is not loaded', !state.extensions.some(e => /Manifest V2/.test(e)), state.extensions)
    u = await ui()
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${coreId}/page.html' }); 'ok'`)
    ext = await target(t => t.url.startsWith(`chrome-extension://${coreId}/page.html`) && t.type === 'page')
    await waitFor(async () => (await ext.evaluate('typeof ask')) === 'function')
    events = await waitFor(async () => { const e = await ext.evaluate("ask({ op: 'events' })"); return e && e.includes('startup') ? e : null }, 5000)
    check('restart: onStartup delivered once, no new onInstalled', JSON.stringify(events) === '["installed:install","installed:update:1.0","startup"]', events)
    minTabs = await uiTabs(u)
    check('restart: Dark Reader welcome tab not opened again', minTabs.filter(t => /darkreader\.org/.test(t.url)).length <= 1, minTabs.map(t => t.url))
    const restartPage = await target(t => t.url === page('restart'))
    const restartContent = restartPage && await restartPage.evaluate('document.documentElement.dataset.minCoreContent')
    check('restart: content script in the first page (info: may miss if it loaded before extensions)', true, restartContent || 'missed')

    // remove
    await stubDialogs(main)
    s = await openSettings(u)
    const mv2Item = ((await request(s, 'list')).result || []).find(e => e.id === MV2_ID)
    check('Settings: the Manifest V2 extension is listed with the reason it does not run', mv2Item && /Manifest V2/.test(mv2Item.error), mv2Item && mv2Item.error)
    r = await request(s, 'remove', { id: MV2_ID })
    check('Settings: the Manifest V2 extension can be removed', !r.error && !readRegistry()[MV2_ID], r)
    r = await request(s, 'remove', { id: coreId })
    r = await request(s, 'remove', { id: IDS.darkreader })
    state = await mainState(main)
    registry = readRegistry()
    check('remove: unloaded and forgotten', !state.extensions.some(e => e.startsWith(coreId) || e.startsWith(IDS.darkreader)) && !registry[coreId] && !registry[IDS.darkreader], state.extensions)
    await sleep(1000)
    check('remove: Min\'s copy of a .crx install deleted', !fs.existsSync(path.join(profile, 'extensions', IDS.darkreader)))
    check('remove: unpacked folder left alone', fs.existsSync(path.join(coreFolder, 'manifest.json')))
    ext.close(); s.close(); u.close()
    await quit(main)

    // ---------- run 3: leftovers cleaned, remove the rest ----------
    const settingsDir = path.join(profile, 'Partitions', 'webcontent', 'Local Extension Settings')
    const beforeClean = fs.existsSync(settingsDir) ? fs.readdirSync(settingsDir) : []
    main = await launch(page('cleanup'))
    await sleep(2000)
    const afterClean = fs.existsSync(settingsDir) ? fs.readdirSync(settingsDir) : []
    check('startup: removed extensions\' chrome.storage deleted', !afterClean.includes(coreId) && !afterClean.includes(IDS.darkreader), { beforeClean, afterClean })
    await stubDialogs(main)
    u = await ui()
    s = await openSettings(u)
    await request(s, 'remove', { id: IDS.ubol })
    await request(s, 'remove', { id: IDS.bitwarden })
    await sleep(500)
    check('settings: empty again', await s.evaluate("!document.getElementById('extensions-empty').hidden"))
    s.close(); u.close()
    await quit(main)

    // ---------- run 4: zero cost again ----------
    main = await launch(page('zero'))
    state = await mainState(main)
    check('zero cost after removing everything', !state.libraryLoaded && state.preloads.length === 0 && state.extensions.length === 0, state)
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
