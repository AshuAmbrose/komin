// The extension survey (AGENTS.md section 10.9, phase 7): popular Chrome Web Store extensions, each downloaded from Chrome's
// update server, scanned for the extension APIs its code mentions (a text scan, so aliases are missed), then installed in Min
// in turn (the review answers "yes"): a page for its content scripts, its popup and its options page, the errors its worker
// and pages log, then removed. Main-process errors are recorded per extension instead of stopping the run.
// usage: node test/e2e/measure-extension-survey.js [ids...]     all 53 take about an hour; give ids for a few
//        node test/e2e/measure-extension-survey.js --scan [ids...]   only the scan, then which functions Min lacks (minutes)
// Results: test/e2e/results/measure-extension-survey-static.json (the scan), -runtime.json (what happened in Min) and
// -coverage.json (--scan: each chrome.* function the extensions mention that Min doesn't have, with who mentions it).
const path = require('path')
const fs = require('fs')
const http = require('http')
const EXTENSIONS = {
  ddkjiahejlhfcafbddmgiahcphecmpfh: 'uBlock Origin Lite',
  gighmmpiobklfepjocnamgkkbiglidom: 'AdBlock',
  cfhdojbkjhnklbpkdaibdccddilifddb: 'Adblock Plus',
  mlomiejdfkolichcflejclcbmpeaniij: 'Ghostery',
  pkehgijcmpdhfbdbbnkijodmdjhbjlgp: 'Privacy Badger',
  bkdgflcldnnnapblkhphbgpggdiikppg: 'DuckDuckGo Privacy Essentials',
  fihnjjcciajhdojfnbdddfaoknhalnja: 'I don\'t care about cookies',
  hlkenndednhfkekhgcdicdfddnkalmdm: 'Cookie-Editor',
  nngceckbapebfimnlniiiahkandclblb: 'Bitwarden',
  hdokiejnpimakedhajhdlcegeplioahd: 'LastPass',
  aeblfdkhhhdcdjpifhhbdiojplfjncoa: '1Password',
  ghmbeldphafepmbegfdlkpapadhbakde: 'Proton Pass',
  fdjamakpfbbddfjaooikfcpapjohcfmg: 'Dashlane',
  kbfnbcaeplbcioakkpcpgfkobkghlhen: 'Grammarly',
  aapbdbdomjkkjkaonfhkkikfgjllcleb: 'Google Translate',
  cofdbpoegempjloogbagkncekinflcnj: 'DeepL',
  oldceeleldhonbafppcapldpdifcinji: 'LanguageTool',
  iidnbdjijdkbmajdffnidomddglmieko: 'QuillBot',
  mgijmajocgfcbeboacabfgobmjgjcoja: 'Google Dictionary',
  mnjggcdmjocbbbhaepdhchncahnbgone: 'SponsorBlock',
  gebbhagfogifgggkldgodflihgfeippi: 'Return YouTube Dislike',
  ponfpcnoihfmfllpaingbgckeeldkhle: 'Enhancer for YouTube',
  nffaoalbilbmmfgbnbgppjihopabppdk: 'Video Speed Controller',
  hkgfoiooedgoejojocmhlaklaeopbecg: 'Picture-in-Picture',
  jghecgabfgfdldnmbfkhmffcabddioke: 'Volume Master',
  khncfooichmfjbepaaaebmommgaepoid: 'Unhook',
  eimadpbcbfnmbkopoojfekhnkhdbieeh: 'Dark Reader',
  chphlpgkkbolifaimnlloiipkdnihall: 'OneTab',
  edacconmaakjimmfgnblocblbcdcpbko: 'Session Buddy',
  jldhpllghnbhlbpcmnajkpdmadaolakh: 'Todoist',
  knheggckgoiihginacbkhaalnibhilkk: 'Notion Web Clipper',
  laookkfknpbbblfpciffpaejjkokdgca: 'Momentum',
  liecbddmkiiihnedobmlmillhodjkdmb: 'Loom',
  gmbmikajjgmnabiglmofipeabaddhgne: 'Save to Google Drive',
  ghbmnnjooekpmoecnnnilnnbdlolhkhi: 'Google Docs Offline',
  bmnlcjabgnpnenekpadlanbbkooimhnj: 'Honey',
  hdhinadidafjejdhmfkjgnolgimiaplp: 'Read Aloud',
  nlipoenfbbikpbjkfpfillcgkoblgpmj: 'Awesome Screenshot',
  fdpohaocaechififmbbbbbknoalclacl: 'GoFullPage',
  fmkadmapgofadopljbjfkapdkoienihi: 'React Developer Tools',
  nhdogjmejiglipccpnnnanhbledajbpd: 'Vue.js devtools',
  gppongmhjkpfnbhagpmjfkannfbllamg: 'Wappalyzer',
  bhlhnicpbhignbdhedgjhgdocnmhomnp: 'ColorZilla',
  gbmdgpbipfallnflgajpaliibnhdgobh: 'JSON Viewer',
  clngdbkpkpeebahjckkjfobafhncgmne: 'Stylus',
  jinjaccalgkegednnccohejagnlnfdag: 'Violentmonkey',
  dhdgffkkebhmkfjojejmpbldmpobfkfo: 'Tampermonkey',
  bfbameneiokkgbdmiekhjnmfkcnldhhm: 'Web Developer',
  jabopobgcpjmedljpbcaablpmlmfcogm: 'WhatFont',
  oeopbcgkkoapgobdbedcemjljbihmemj: 'Checker Plus for Gmail',
  mclkkofklkfljcocdinagocijmpgbhab: 'Google Input Tools',
  hnmpcagpplmpfojmgmnngilcnanddlhb: 'Windscribe',
  pgjjikdiikihdfpoppgaidccahalehjh: 'Speedtest by Ookla',
  immpkjjlgappgfkkfieppnmlhakdmaab: 'Imagus',
  pmjeegjhjdlccodhacdgbgfagbpmccpe: 'Clockify',
  ldipcbpaocekfooobnbcddclnhejkcpn: 'Google Scholar Button'
}
const onlyIds = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const SCAN_ONLY = process.argv.includes('--scan')
const t = require('./harness')({ name: 'measure-extension-survey', minutes: 120, stopOnMainErrors: false })
const { sleep, check, finish, waitFor, target, launch, quit, ui } = t
const packages = require(path.join(t.root, 'js/util/extensionPackages.js'))

function scan (files) {
  const manifestFile = files.find(f => f.path === 'manifest.json')
  const manifest = JSON.parse(manifestFile.data.toString('utf-8').replace(/^\uFEFF/, ''))
  const apis = {}
  for (const file of files) {
    if (!/\.(m?js|html)$/.test(file.path)) {
      continue
    }
    const text = file.data.toString('utf-8')
    for (const match of text.matchAll(/\b(?:chrome|browser)\s*\.\s*([a-zA-Z_$][\w$]*)(?:\s*\.\s*([a-zA-Z_$][\w$]*))?(?:\s*\.\s*([a-zA-Z_$][\w$]*))?/g)) {
      const ns = match[1]
      // two-level namespaces (devtools.panels, system.cpu)
      const twoLevel = ['devtools', 'system', 'app', 'input', 'enterprise', 'loginState', 'platformKeys', 'webstorePrivate'].includes(ns)
      const name = twoLevel && match[2] ? ns + '.' + match[2] + (match[3] ? '.' + match[3] : '') : ns + (match[2] ? '.' + match[2] : '')
      apis[name] = (apis[name] || 0) + 1
    }
  }
  return {
    manifestVersion: manifest.manifest_version,
    version: manifest.version,
    permissions: (manifest.permissions || []).filter(p => typeof p === 'string'),
    optionalPermissions: (manifest.optional_permissions || []).filter(p => typeof p === 'string'),
    background: manifest.background ? (manifest.background.service_worker ? 'worker' : 'page') : 'none',
    hasPopup: !!((manifest.action || manifest.browser_action || {}).default_popup),
    hasAction: !!(manifest.action || manifest.browser_action || manifest.page_action),
    pageAction: !!manifest.page_action,
    options: !!((manifest.options_ui && manifest.options_ui.page) || manifest.options_page),
    sidePanel: !!(manifest.side_panel && manifest.side_panel.default_path),
    devtools: !!manifest.devtools_page,
    contentScripts: (manifest.content_scripts || []).length,
    overrides: Object.keys(manifest.chrome_url_overrides || {}),
    apis
  }
}
// downloads (cached between runs) and the scan; an extension that's gone from the store is recorded, not fatal
async function scanAll () {
  const result = {}
  for (const id of onlyIds.length ? onlyIds : Object.keys(EXTENSIONS)) {
    try {
      await require('./harness').downloadExtensions([id])
      const data = fs.readFileSync(t.crx(id))
      const crx = packages.parseCrx(data)
      if (crx.id !== id) {
        throw new Error('id mismatch ' + crx.id)
      }
      result[id] = Object.assign({ name: EXTENSIONS[id] || id, size: data.length }, scan(packages.readExtensionZip(crx.zip)))
    } catch (e) {
      result[id] = { name: EXTENSIONS[id] || id, error: String(e.message || e) }
    }
  }
  fs.writeFileSync(t.output('static.json'), JSON.stringify(result, null, 2))
  return result
}
let staticInfo = {}
let ids = []

// Chrome's extension API namespaces (developer.chrome.com/docs/extensions/reference), to tell a gap in Min from code
// for other browsers (Firefox's browser.menus and the like), which Chrome doesn't have either
const CHROME_NAMESPACES = new Set(['accessibilityFeatures', 'action', 'alarms', 'audio', 'bookmarks', 'browsingData', 'certificateProvider',
  'commands', 'contentSettings', 'contextMenus', 'cookies', 'debugger', 'declarativeContent', 'declarativeNetRequest', 'desktopCapture',
  'devtools', 'documentScan', 'dom', 'downloads', 'enterprise', 'events', 'extension', 'extensionTypes', 'fileBrowserHandler',
  'fileSystemProvider', 'fontSettings', 'gcm', 'history', 'i18n', 'identity', 'idle', 'input', 'instanceID', 'loginState', 'management',
  'notifications', 'offscreen', 'omnibox', 'pageCapture', 'permissions', 'platformKeys', 'power', 'printerProvider', 'printing',
  'printingMetrics', 'privacy', 'processes', 'proxy', 'readingList', 'runtime', 'scripting', 'search', 'sessions', 'sidePanel', 'storage',
  'system', 'systemLog', 'tabCapture', 'tabGroups', 'tabs', 'topSites', 'tts', 'ttsEngine', 'types', 'userScripts', 'vpnProvider',
  'wallpaper', 'webAuthenticationProxy', 'webNavigation', 'webRequest', 'windows'])
// properties that are normally undefined in Chrome too, and functions Chrome doesn't have (Firefox's, or removed from
// Chrome before Manifest V3), which extensions mention for other browsers
const UNDEFINED_IN_CHROME = new Set(['runtime.lastError', 'extension.lastError'])
const NOT_IN_CHROME = new Set(['runtime.getBrowserInfo', 'runtime.port', 'commands.update', 'extension.onRequest', 'extension.sendRequest', 'extension.onRequestExternal'])
// type names in comments and JSDoc (chrome.tabs.Tab, chrome.runtime.MessageSender): not there at run time in Chrome either
const isTypeName = name => name.split('.').slice(1).some(part => /^[A-Z][a-z]/.test(part))

// --scan: which of the functions the extensions mention Min lacks. A generated extension that asks for every permission
// they ask for lists what chrome.* holds in its background worker and in one of its pages (popups and options pages
// get the same as that page)
async function coverage () {
  const wanted = {}
  const permissions = new Set()
  for (const id of ids) {
    const info = staticInfo[id]
    info.permissions.concat(info.optionalPermissions).filter(p => !/[/*:]/.test(p) && p !== '<all_urls>').forEach(p => permissions.add(p))
    Object.keys(info.apis).filter(name => !name.includes('$')).forEach(name => { (wanted[name] = wanted[name] || []).push(info.name) })
  }
  const folder = path.join(t.runDir, 'every-permission')
  fs.mkdirSync(folder, { recursive: true })
  // chrome.action only exists for an extension whose manifest has an action, as in Chrome
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Min survey: every permission', version: '1.0', background: { service_worker: 'sw.js' }, action: { default_title: 'Min survey' }, permissions: [...permissions].sort(), host_permissions: ['<all_urls>'] }, null, 2))
  fs.writeFileSync(path.join(folder, 'sw.js'), '// only here so the survey can list what chrome.* holds in a worker\n')
  fs.writeFileSync(path.join(folder, 'page.html'), '<!doctype html><title>Min survey: every permission</title>')
  const main = await launch(SURVEY_PAGE)
  const u = await ui()
  await sleep(1500)
  await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
  const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
  await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
  await main.evaluate(`global.__nextOpen = ${JSON.stringify(folder)}; 1`)
  const id = await s.evaluate("extensionPages.request('load-unpacked').then(r => r, e => 'ERR ' + e.message)")
  const item = ((await s.evaluate("extensionPages.request('list')")) || []).find(e => e.id === id) || {}
  const worker = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
  await u.evaluate(`ipc.emit('addTab', {}, { url: 'chrome-extension://${id}/page.html' }); 1`)
  const page = await target(x => x.url.startsWith('chrome-extension://' + id + '/page.html') && x.type === 'page', 15000)
  const typeNames = Object.keys(wanted).filter(isTypeName).sort()
  const names = Object.keys(wanted).filter(name => !isTypeName(name)).sort()
  const present = `(names => names.filter(name => { let value = chrome; for (const part of name.split('.')) { if (value === undefined || value === null) return false; try { value = value[part] } catch (e) { return false } } return value !== undefined }))(${JSON.stringify(names)})`
  const presentTypes = present.replace(JSON.stringify(names), JSON.stringify(typeNames))
  const inWorker = new Set(worker ? await worker.evaluate(present) : [])
  const inPage = new Set(page ? await page.evaluate(present) : [])
  const typesPresent = new Set((worker ? await worker.evaluate(presentTypes) : []).concat(page ? await page.evaluate(presentTypes) : []))
  // devtools.* exists only in an extension's DevTools page (inside the DevTools window), which the probe doesn't open
  const missing = names.filter(name => !inWorker.has(name) && !inPage.has(name) && !UNDEFINED_IN_CHROME.has(name)).map(name => ({
    api: name,
    chromeHasIt: CHROME_NAMESPACES.has(name.split('.')[0]) && !NOT_IN_CHROME.has(name),
    devtoolsPagesOnly: name.split('.')[0] === 'devtools',
    extensions: wanted[name]
  })).sort((a, b) => b.extensions.length - a.extensions.length || a.api.localeCompare(b.api))
  const result = {
    date: new Date().toISOString(),
    electron: require(path.join(t.root, 'package.json')).electronVersion,
    extensions: ids.length,
    manifestV2: ids.filter(id => staticInfo[id].manifestVersion !== 3).map(id => staticInfo[id].name),
    probe: { id, permissions: [...permissions].sort(), unsupportedPermissions: item.unsupported || null, worker: !!worker, page: !!page },
    mentioned: names.length,
    // capitalized names: Chrome's enums (tabs.TabStatus) exist at run time, type names (tabs.Tab) don't; review by hand
    typeNamesMissing: typeNames.filter(name => !typesPresent.has(name)).map(name => ({ api: name, extensions: wanted[name] })),
    typeNamesPresent: typeNames.filter(name => typesPresent.has(name)),
    onlyInPage: names.filter(name => !inWorker.has(name) && inPage.has(name)),
    onlyInWorker: names.filter(name => inWorker.has(name) && !inPage.has(name)),
    missing
  }
  fs.writeFileSync(t.output('coverage.json'), JSON.stringify(result, null, 2))
  const gaps = missing.filter(m => m.chromeHasIt && !m.devtoolsPagesOnly)
  check('coverage: ' + names.length + ' names mentioned, ' + gaps.length + ' of Chrome\'s missing in Min (info)', !!worker && !!page, { probe: result.probe, manifestV2: result.manifestV2, devtoolsNotChecked: missing.filter(m => m.devtoolsPagesOnly).length, notInChrome: missing.filter(m => !m.chromeHasIt).map(m => m.api) })
  for (const m of gaps) {
    console.log('MISSING ' + m.api + ' (' + m.extensions.length + '): ' + m.extensions.join(', '))
  }
  for (const m of result.typeNamesMissing) {
    console.log('CAPITALIZED ' + m.api + ' (' + m.extensions.length + '): ' + m.extensions.join(', '))
  }
  console.log('CAPITALIZED PRESENT ' + result.typeNamesPresent.join(' '))
  s.close(); u.close()
  if (worker) worker.close()
  if (page) page.close()
  await quit(main)
}
const YOUTUBE = ['mnjggcdmjocbbbhaepdhchncahnbgone', 'gebbhagfogifgggkldgodflihgfeippi', 'ponfpcnoihfmfllpaingbgckeeldkhle', 'khncfooichmfjbepaaaebmommgaepoid', 'nffaoalbilbmmfgbnbgppjihopabppdk', 'jghecgabfgfdldnmbfkhmffcabddioke', 'hkgfoiooedgoejojocmhlaklaeopbecg']
const WIKIPEDIA = ['aapbdbdomjkkjkaonfhkkikfgjllcleb', 'mgijmajocgfcbeboacabfgobmjgjcoja', 'cofdbpoegempjloogbagkncekinflcnj']
const SURVEY_PORT = 8775
const surveyServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><html lang="en"><title>Survey page</title><body><h1>A page for content scripts</h1>' +
    '<p>' + 'Extensions add their scripts to pages like this one, which has some text, a form and a link. '.repeat(12) + '</p>' +
    '<form action="/login" method="post"><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>' +
    '<textarea>Some text in a text box, for writing helpers.</textarea><a href="/other">another page</a></body></html>')
}).listen(SURVEY_PORT, '127.0.0.1')
const SURVEY_PAGE = `http://127.0.0.1:${SURVEY_PORT}/page`
const LOGGER = `(event, ...rest) => keep('page:' + (wc.isDestroyed() ? '' : wc.getURL().slice(0, 120)), event.level !== undefined ? event.level : rest[0], event.message !== undefined ? event.message : rest[1], event.sourceId !== undefined ? event.sourceId : rest[3])`

;(async () => {
  let main
  staticInfo = await scanAll()
  ids = Object.keys(staticInfo).filter(id => !staticInfo[id].error)
  if (SCAN_ONLY) {
    try {
      await coverage()
    } catch (e) {
      check('harness error', false, String(e.stack || e))
    }
    return finish()
  }
  const report = {}
  const save = () => fs.writeFileSync(t.output('runtime.json'), JSON.stringify(report, null, 2))
  try {
    main = await launch(SURVEY_PAGE)
    await main.evaluate(`(() => { const electron = process.mainModule.require('electron')
      global.__logs = []
      const keep = (source, level, message, url) => { if (global.__logs.length < 5000) global.__logs.push({ source, level: String(level), message: String(message).slice(0, 400), url: String(url || '').slice(0, 200) }) }
      const ses = electron.session.fromPartition('persist:webcontent')
      ses.serviceWorkers.on('console-message', (event, details) => keep('worker', details.level, details.message, details.sourceUrl))
      electron.app.on('web-contents-created', (e, wc) => wc.on('console-message', ${LOGGER}))
      electron.webContents.getAllWebContents().forEach(wc => wc.on('console-message', ${LOGGER}))
      return 1 })()`)
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    let s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    let settingsTab = await u.evaluate('tabs.getSelected()')
    await u.evaluate("window.__opened = []; ipc.on('extensions-open-tab', (e, d) => window.__opened.push(JSON.stringify(d).slice(0, 200))); 1")

    for (const id of ids) {
      if (t.isFinished()) break
      const info = staticInfo[id]
      const entry = report[id] = { name: info.name }
      // an extension can close every tab (OneTab does): Settings comes back
      if ((await s.evaluate('typeof extensionPages')) !== 'object') {
        await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
        s = await target(t => t.url.startsWith('min://app/pages/settings/'))
        await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
        settingsTab = await u.evaluate('tabs.getSelected()')
      }
      console.log('--- ' + info.name)
      await main.evaluate('global.__logs = []; global.__mainErrors = []; global.__dialogs = []; 1')
      await u.evaluate('window.__opened = []; 1')
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.crx(id))}; 1`)
      const installed = await Promise.race([s.evaluate("extensionPages.request('install-crx').catch(e => 'ERROR ' + e.message)"), sleep(60000).then(() => 'TIMEOUT')])
      entry.installed = installed === id ? true : installed
      if (installed !== id) { save(); continue }
      await sleep(5000)
      entry.worker = await main.evaluate(`(() => { const electron = process.mainModule.require('electron'); const running = electron.session.fromPartition('persist:webcontent').serviceWorkers.getAllRunning(); return Object.values(running).some(w => w.scope.startsWith('chrome-extension://${id}/')) })()`)
      const page = YOUTUBE.includes(id) ? 'https://www.youtube.com/watch?v=jNQXAC9IVRw' : (WIKIPEDIA.includes(id) ? 'https://en.wikipedia.org/wiki/Web_browser' : SURVEY_PAGE + '?' + id)
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(page)} }); 1`)
      await sleep(YOUTUBE.includes(id) ? 8000 : 4000)
      if (info.hasPopup) {
        const clicked = await u.evaluate(`(() => { const b = document.querySelector('#extension-actions [data-extension-id="${id}"]'); if (!b) return false; b.click(); return true })()`)
        await sleep(3500)
        entry.popup = clicked ? await main.evaluate(`(async () => { const electron = process.mainModule.require('electron'); const w = electron.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().startsWith('chrome-extension://${id}/')); if (!w) return 'no popup window'; const text = await w.webContents.executeJavaScript('document.body ? document.body.innerText.length : -1').catch(e => 'ERR ' + e.message); const b = w.getBounds(); return { textLength: text, size: b.width + 'x' + b.height } })()`) : 'no button'
        if (clicked) await u.evaluate(`(() => { const b = document.querySelector('#extension-actions [data-extension-id="${id}"]'); if (b) b.click(); return 1 })()`)
        await sleep(800)
      }
      if (info.options) {
        await s.evaluate(`extensionPages.request('open-options', { id: '${id}' })`)
        await sleep(3500)
        entry.options = await main.evaluate(`(async () => { const electron = process.mainModule.require('electron'); const wc = electron.webContents.getAllWebContents().find(w => !w.isDestroyed() && w.getURL().startsWith('chrome-extension://${id}/') && w.getType() !== 'backgroundPage' && !electron.BrowserWindow.fromWebContents(w)); if (!wc) return 'no options tab'; return { url: wc.getURL().slice(0, 100), textLength: await wc.executeJavaScript('document.body ? document.body.innerText.length : -1').catch(e => 'ERR ' + e.message) } })()`)
      }
      entry.tabs = (await u.evaluate('tabs.get().map(t => t.url)')).filter(t => !t.startsWith('min://app/pages/settings') && t !== page)
      entry.opened = await u.evaluate('window.__opened')
      const logs = await main.evaluate('global.__logs')
      const mainErrors = await main.evaluate('global.__mainErrors')
      const own = logs.filter(l => (l.source === 'worker' || l.url.startsWith('chrome-extension://' + id) || l.source.startsWith('page:chrome-extension://' + id)) && !/^(info|0|1|-1|verbose|debug|log)$/i.test(l.level))
      const seen = new Set()
      entry.errors = own.filter(l => { const k = l.message.slice(0, 160); if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 25).map(l => '[' + l.level + '] ' + l.source.slice(0, 60) + ' :: ' + l.message + (l.url ? ' @' + l.url.replace('chrome-extension://' + id, '') : ''))
      entry.mainErrors = (mainErrors || []).map(e => e.slice(0, 500))
      entry.removed = await s.evaluate(`extensionPages.request('remove', { id: '${id}' }).then(() => true, e => 'ERROR ' + e.message)`)
      // back to the Settings tab only
      await u.evaluate(`(() => { tabs.get().filter(t => t.id !== ${JSON.stringify(settingsTab)}).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); return 1 })()`)
      await sleep(1500)
      console.log(JSON.stringify({ worker: entry.worker, popup: entry.popup, options: entry.options, errors: entry.errors.length, mainErrors: entry.mainErrors.length }))
      save()
    }
    s.close()
    u.close()
    await quit(main)
    surveyServer.close()
    check('survey finished', true, Object.keys(report).length)
    finish()
  } catch (e) {
    save()
    check('harness error', false, String(e.stack || e))
    surveyServer.close()
    finish()
  }
})()
