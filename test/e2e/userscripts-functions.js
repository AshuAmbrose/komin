// Userscripts' Greasemonkey functions (values and listeners, styles and elements, xmlhttpRequest with @connect, download,
// openInTab, clipboard, notification, menu commands, resources), installing from a link and from a local file, automatic
// and approved updates, edited scripts, and the Settings list (on/off, remove, new script). Compares with
// userscripts-functions.expected.json. Opens Notepad for "New script" and closes it again.
const http = require('http')
const path = require('path')
const fs = require('fs')

const t = require('./harness')({ name: 'userscripts-functions', minutes: 6, settings: { userscriptsEnabled: true } })
const CDP_PORT = t.CDP_PORT
const PORT = 8765
const BASE = `http://127.0.0.1:${PORT}`
const OTHER = `http://localhost:${PORT}`
const profile = t.profileDir
const scriptDir = path.join(profile, 'userscripts')
const dataDir = path.join(profile, 'userscriptData')
const downloadDir = path.join(t.runDir, 'downloads')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function sortForComparison (out) {
  if (Array.isArray(out.afterDoneViews)) out.afterDoneViews.sort()
  // which requests reached the test server, not how many times (an aborted or slow request is sometimes sent again)
  if (Array.isArray(out.serverRequests)) out.serverRequests = [...new Set(out.serverRequests)].sort()
  return out
}
const throwing = c => ({ ...c, evaluate: async e => { const v = await c.evaluate(e); if (typeof v === 'string' && /^(EXC|ERR|TIMEOUT)/.test(v)) throw new Error(v.slice(0, 400)); return v } })
async function json (url) { return (await fetch(url)).json() }
function cdp (wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const ready = new Promise(resolve => { ws.onopen = resolve })
  return {
    evaluate: async (expression) => {
      await ready
      const i = ++id
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      const r = await new Promise(resolve => pending.set(i, resolve))
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
      return r.result && r.result.result ? r.result.result.value : undefined
    },
    send: async (method, params = {}) => {
      await ready
      const i = ++id
      ws.send(JSON.stringify({ id: i, method, params }))
      return new Promise(resolve => pending.set(i, resolve))
    },
    close: () => ws.close()
  }
}

function userscript (meta, body) {
  return '// ==UserScript==\n' + meta.map(m => '// ' + m).join('\n') + '\n// ==/UserScript==\n' + body + '\n'
}

const SCRIPTS = {
  'gm-values.user.js': userscript(['@name Values', '@namespace test', '@version 1.0', `@match ${BASE}/gm*`, '@grant GM_getValue', '@grant GM_setValue', '@grant GM_deleteValue', '@grant GM_listValues', '@grant GM_addValueChangeListener', '@grant GM.getValue', '@grant GM_getValues', '@grant GM_setValues'], `
window.__gm = { changes: [] }
const n = GM_getValue('count', 0)
GM_setValue('count', n + 1)
window.__gm.count = n + 1
GM_setValue('obj', { a: [1, 2] })
const copy = GM_getValue('obj'); copy.a.push(3)
window.__gm.objAfterMutatingCopy = GM_getValue('obj')
GM_setValue('temp', 1); GM_deleteValue('temp')
GM_setValues({ x: 1, y: 'two' })
window.__gm.getValues = GM_getValues(['x', 'y', 'missing'])
window.__gm.list = GM_listValues().sort()
window.__gm.inside = { setValue: typeof GM_setValue, xhrNotGranted: typeof GM_xmlhttpRequest, info: GM_info.script.name, handler: GM_info.scriptHandler, version: GM_info.script.version, unsafeWindowIsWindow: unsafeWindow === window, thisIsWindow: this === window, gm4: typeof GM.getValue, metaStr: GM_info.scriptMetaStr.includes('@name Values') }
window.__gm.pageSees = { GM_setValue: typeof window.GM_setValue, GM: typeof window.GM, GM_info: typeof window.GM_info }
GM.getValue('count').then(v => { window.__gm.gm4Value = v })
GM_addValueChangeListener('shared', (key, oldValue, newValue, remote) => window.__gm.changes.push({ key, oldValue, newValue, remote }))
window.__gmSet = (k, v) => GM_setValue(k, v)
`),
  'gm-xhr.user.js': userscript(['@name XHR', `@match ${BASE}/gm*`, '@grant GM_xmlhttpRequest', '@grant GM.xmlHttpRequest', '@connect localhost'], `
const results = window.__xhr = {}
const done = (name, value) => { results[name] = value }
const base = '${BASE}', other = '${OTHER}'
GM_xmlhttpRequest({ url: base + '/api/json', responseType: 'json', onload: r => done('sameHostJSON', { status: r.status, ok: r.response && r.response.ok, finalUrl: r.finalUrl, hasHeaders: /content-type/i.test(r.responseHeaders) }) })
GM_xmlhttpRequest({ method: 'POST', url: other + '/api/echo', headers: { 'X-Test': 'yes', 'Content-Type': 'text/plain' }, data: 'hello body', onload: r => done('crossOriginPOST', JSON.parse(r.responseText)) })
GM_xmlhttpRequest({ url: 'http://127.0.0.2:${PORT}/api/json', onload: () => done('blocked', 'loaded?!'), onerror: r => done('blocked', { error: r.error }) })
GM_xmlhttpRequest({ url: base + '/api/html', responseType: 'document', onload: r => done('document', { title: r.response && r.response.title, xmlTitle: r.responseXML && r.responseXML.querySelector('h1').textContent }) })
GM_xmlhttpRequest({ url: base + '/api/xml', onload: r => done('xml', r.responseXML ? r.responseXML.documentElement.nodeName : null) })
GM_xmlhttpRequest({ url: base + '/api/binary', responseType: 'arraybuffer', onload: r => done('arraybuffer', { isArrayBuffer: r.response instanceof ArrayBuffer, bytes: Array.from(new Uint8Array(r.response)) }) })
GM_xmlhttpRequest({ url: base + '/api/binary', responseType: 'blob', onload: r => done('blob', { isBlob: r.response instanceof Blob, size: r.response.size, type: r.response.type }) })
GM_xmlhttpRequest({ url: base + '/api/slow', timeout: 300, ontimeout: () => done('timeout', true), onload: () => done('timeout', 'loaded?!') })
const aborted = GM_xmlhttpRequest({ url: base + '/api/slow', onabort: () => done('abort', true), onload: () => done('abort', 'loaded?!') })
setTimeout(() => aborted.abort(), 100)
GM.xmlHttpRequest({ url: base + '/api/json' }).then(r => done('promise', JSON.parse(r.responseText).ok), e => done('promise', 'rejected ' + e.error))
const form = new FormData(); form.append('field', 'value')
GM_xmlhttpRequest({ method: 'POST', url: base + '/api/echo', data: form, onload: r => { const d = JSON.parse(r.responseText); done('formData', { multipart: /multipart\\/form-data/.test(d.contentType), hasField: d.body.includes('value') }) } })
GM_xmlhttpRequest({ url: base + '/api/redirect', onload: r => done('redirect', r.finalUrl) })
const events = []
GM_xmlhttpRequest({ url: base + '/api/json', onloadstart: () => events.push('loadstart'), onreadystatechange: r => events.push('rs' + r.readyState), onprogress: () => events.push('progress'), onload: () => events.push('load'), onloadend: () => { events.push('loadend'); done('events', events.filter((e, i) => events.indexOf(e) === i)) } })
`),
  'gm-misc.user.js': userscript(['@name Misc', `@match ${BASE}/gm*`, `@require ${BASE}/lib.js`, `@resource txt ${BASE}/res.txt`, '@grant GM_addStyle', '@grant GM_addElement', '@grant GM_registerMenuCommand', '@grant GM_getResourceText', '@grant GM_getResourceURL', '@grant GM_setClipboard', '@grant GM_openInTab', '@grant GM_notification', '@grant GM_download', '@grant GM_log', '@connect 127.0.0.1'], `
window.__misc = {}
window.__misc.require = { libVarShared: typeof libVar === 'number' ? libVar : null, libGlobal: window.__lib }
window.__misc.resourceText = GM_getResourceText('txt')
const url = GM_getResourceURL('txt')
window.__misc.resourceURLScheme = url && url.split(':')[0]
fetch(url).then(r => r.text()).then(t => { window.__misc.resourceFetch = t }, e => { window.__misc.resourceFetch = 'failed ' + e })
window.__misc.dataURL = GM_getResourceURL('txt', false).slice(0, 30)
const style = GM_addStyle('html { --gm-style: applied; }')
window.__misc.addStyleReturnsElement = style && style.tagName
const el = GM_addElement('div', { id: 'gm-added', textContent: 'added' })
window.__misc.addElement = el && el.id
window.__misc.menuRuns = 0
window.__misc.menuId = GM_registerMenuCommand('Count menu runs', () => { window.__misc.menuRuns++ })
window.__gmClipboard = text => GM_setClipboard(text)
window.__gmOpenTab = () => { window.__openedTab = GM_openInTab('${BASE}/opened', { active: false }) }
window.__gmCloseTab = () => window.__openedTab.close()
window.__gmNotify = () => GM_notification({ title: 'Min test', text: 'Userscript test notification', timeout: 1500, ondone: () => { window.__misc.notificationDone = true } })
window.__gmDownload = () => GM_download({ url: '${BASE}/download.bin', name: 'gm-test.bin', onload: () => { window.__misc.download = 'loaded' }, onerror: e => { window.__misc.download = 'error ' + e.details } })
window.__gmDownloadBlocked = () => GM_download({ url: 'http://127.0.0.2:${PORT}/download.bin', onerror: e => { window.__misc.downloadBlocked = e.details } })
GM_log('hello from GM_log')
`),
  'gm-none.user.js': userscript(['@name None', `@match ${BASE}/gm*`, '@grant none'], `
window.__none = { getValue: typeof GM_getValue, info: typeof GM_info, gmInfo: typeof GM.info, gmGetValue: typeof GM.getValue }
`),
  'gm-auto.user.js': userscript(['@name Auto grant', `@match ${BASE}/gm*`], `
GM_setValue('auto', 1)
window.__auto = { setValue: typeof GM_setValue, getValue: GM_getValue('auto'), addStyle: typeof GM_addStyle }
`),
  'gm-csp.user.js': userscript(['@name CSP GM', `@match ${BASE}/csp`, '@grant GM_addStyle', '@grant GM_getValue', '@grant GM_xmlhttpRequest', '@run-at document-start'], `
GM_addStyle('html { --gm-csp: applied; }')
window.__cspGM = { getValue: GM_getValue('nothing', 'default') }
GM_xmlhttpRequest({ url: '${BASE}/api/html', responseType: 'document', onload: r => { window.__cspGM.document = r.response && r.response.title } })
`),
  'gm-menu-run.user.js': userscript(['@name Manual GM', `@match ${BASE}/gm*`, '@run-at context-menu', '@grant GM_setValue', '@grant GM_getValue'], `
GM_setValue('manual', (GM_getValue('manual', 0)) + 1)
window.__manual = GM_getValue('manual')
`),
  'gm-bad-require.user.js': userscript(['@name Bad require', `@match ${BASE}/gm*`, `@require ${BASE}/lib.js#sha256=0000`], 'window.__badRequire = true'),
  'gm-disabled.user.js': userscript(['@name To disable', `@match ${BASE}/gm*`], 'window.__toDisable = true'),
  'gm-remove.user.js': userscript(['@name Remove me', `@match ${BASE}/gm*`], 'window.__toRemove = true'),
  '127.0.0.1.js': 'var legacyGlobal = 1\n'
}

let installVersion = '1.0'
function installScript (version) {
  const extra = version === '1.2' ? ['@grant GM_xmlhttpRequest', '@connect *'] : []
  return userscript(['@name Installed', '@namespace test-install', `@version ${version}`, '@description A script installed from the web', '@author Tester', `@match ${BASE}/installed*`, `@require ${BASE}/lib.js`, '@grant GM_getValue', ...extra, `@updateURL ${BASE}/install/test.meta.js`, `@downloadURL ${BASE}/install/test.user.js`],
    'window.__installed = GM_info.script.version')
}

const GM_PAGE = '<!doctype html><html><head><title>gm</title></head><body><h1>gm</h1></body></html>'
const requests = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', d => { body += d })
  req.on('end', () => {
    requests.push(req.method + ' ' + req.headers.host + req.url)
    const url = req.url
    const send = (type, data, headers = {}) => { res.writeHead(200, Object.assign({ 'content-type': type }, headers)); res.end(data) }
    if (url === '/csp') return send('text/html', '<!doctype html><title>csp</title><p>csp</p>', { 'content-security-policy': "script-src 'none'; style-src 'none'; require-trusted-types-for 'script'" })
    if (url.startsWith('/gm') || url.startsWith('/installed') || url === '/opened' || url === '/blank' || url === '/back') return send('text/html', GM_PAGE)
    if (url === '/api/json') return send('application/json', JSON.stringify({ ok: true }))
    if (url === '/api/echo') return send('application/json', JSON.stringify({ method: req.method, xTest: req.headers['x-test'] || null, contentType: req.headers['content-type'] || null, origin: req.headers.origin || null, body }))
    if (url === '/api/html') return send('text/html', '<!doctype html><title>Doc title</title><h1>Heading</h1>')
    if (url === '/api/xml') return send('text/xml', '<?xml version="1.0"?><feed><item/></feed>')
    if (url === '/api/binary') return send('application/octet-stream', Buffer.from([1, 2, 3, 250]))
    if (url === '/api/slow') { setTimeout(() => send('text/plain', 'slow'), 2000); return }
    if (url === '/api/redirect') { res.writeHead(302, { location: '/api/json' }); return res.end() }
    if (url === '/lib.js') return send('application/javascript', "var libVar = 42\nwindow.__lib = 'loaded'")
    if (url === '/res.txt') return send('text/plain; charset=utf-8', 'resource text ✓')
    if (url === '/download.bin') return send('application/octet-stream', Buffer.from('download'), { 'content-disposition': 'attachment' })
    if (url === '/install/test.user.js') return send('text/javascript; charset=utf-8', installScript(installVersion))
    if (url === '/install/test.meta.js') return send('text/javascript; charset=utf-8', installScript(installVersion).split('// ==/UserScript==')[0] + '// ==/UserScript==\n')
    res.writeHead(404); res.end('not found')
  })
})

const WRAP_MAIN = `(() => {
  const { ipcMain, clipboard, session } = process.mainModule.require('electron')
  const original = ipcMain.listeners('page-start')[0]
  ipcMain.removeAllListeners('page-start')
  global.__usLog = []
  ipcMain.on('page-start', (e, url) => {
    const t = process.hrtime.bigint()
    original(e, url)
    const ms = Number(process.hrtime.bigint() - t) / 1e6
    const us = e.returnValue && e.returnValue.userscripts
    global.__usLog.push({ frameUrl: e.senderFrame && e.senderFrame.url, ms, bytes: us ? JSON.stringify(us).length : 0, scripts: us ? us.map(s => s.name) : null })
  })
  Promise.resolve(clipboard.readText()).then(t => { global.__savedClipboard = t })
  // save GM_download files to the scratchpad instead of showing a save dialog
  session.fromPartition('persist:webcontent').prependListener('will-download', (e, item) => item.setSavePath(${JSON.stringify(path.join(downloadDir, 'gm-test.bin'))}))
  return 'wrapped'
})()`

async function targets () { return json(`http://127.0.0.1:${CDP_PORT}/json/list`) }
async function pageTarget (match) { return (await targets()).find(t => t.type === 'page' && match(t.url)) }
async function waitFor (fn, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch (e) {}
    await sleep(200)
  }
  return null
}

;(async () => {
  fs.mkdirSync(downloadDir, { recursive: true })
  fs.mkdirSync(scriptDir, { recursive: true })
  for (const [name, content] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(scriptDir, name), content)

  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
  const out = {}
  const mainConnection = await t.launch(`${BASE}/blank`)
  const pages = []
  const open = async (ui, url, match) => {
    await ui.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 'ok'`)
    const target = await waitFor(() => pageTarget(match || (u => u === url)))
    await sleep(1500)
    const page = cdp(target.webSocketDebuggerUrl)
    pages.push(page)
    return page
  }
  try {
    let ui = null; let main = null
    for (let i = 0; i < 80 && !(ui && main); i++) {
      await sleep(500)
      try { ui = ui || (await targets()).find(t => t.url.startsWith('min://app/index.html')) } catch (e) {}
      main = mainConnection
    }
    const uiPage = cdp(ui.webSocketDebuggerUrl)
    const mainProc = throwing(main)
    out.uiReady = await waitFor(() => uiPage.evaluate('typeof ipc === "object" && typeof tabs === "object"'), 15000)
    if (!out.uiReady) out.uiState = await uiPage.evaluate('({ url: location.href, readyState: document.readyState, scripts: Array.from(document.scripts).map(s => s.src) })')
    out.wrap = await mainProc.evaluate(WRAP_MAIN)
    // @require/@resource files download on first load; give them a moment
    await sleep(2500)
    out.uiList = await uiPage.evaluate(`ipc.invoke('userscripts-list').then(l => l.map(s => s.name))`)

    // 1. Greasemonkey functions on a normal page
    const gm = await open(uiPage, `${BASE}/gm?1`)
    await sleep(2500)
    out.values = await gm.evaluate('window.__gm')
    out.xhr = await gm.evaluate('window.__xhr')
    out.misc = await gm.evaluate('window.__misc')
    out.none = await gm.evaluate('window.__none')
    out.auto = await gm.evaluate('window.__auto')
    out.style = await gm.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--gm-style').trim()`)
    out.legacy = await gm.evaluate('window.legacyGlobal')
    out.badRequireRan = await gm.evaluate('window.__badRequire === true')

    // 2. menu commands in the context menu data
    out.menuCommands = await uiPage.evaluate(`(async () => {
      const tabId = tabs.get().find(t => t.url.endsWith('/gm?1')).id
      const commands = await ipc.invoke('userscripts-menu-commands', tabId)
      if (commands[0]) await ipc.invoke('userscripts-menu-command-run', { tabId, frameKey: commands[0].frameKey, scriptId: commands[0].scriptId, id: commands[0].id })
      return commands.map(c => c.caption + ' / ' + c.scriptName)
    })()`)
    await sleep(300)
    out.menuRuns = await gm.evaluate('window.__misc.menuRuns')

    // 3. clipboard, open/close tab, notification, download
    await gm.evaluate(`window.__gmClipboard('min userscript clipboard test'); 'ok'`)
    await sleep(300)
    out.clipboard = await mainProc.evaluate(`process.mainModule.require('electron').clipboard.readText()`)
    await mainProc.evaluate(`process.mainModule.require('electron').clipboard.writeText(global.__savedClipboard); 'restored'`)
    const tabCount = async () => uiPage.evaluate('tabs.count()')
    const beforeOpen = await tabCount()
    await gm.evaluate(`window.__gmOpenTab(); 'ok'`)
    await sleep(1500)
    out.openInTab = { before: beforeOpen, after: await tabCount(), openedURL: await uiPage.evaluate(`!!tabs.get().find(t => t.url === '${BASE}/opened')`), selectedStillGM: await uiPage.evaluate(`tabs.get(tabs.getSelected()).url`) }
    await gm.evaluate(`window.__gmCloseTab(); 'ok'`)
    await sleep(1000)
    out.openInTab.afterClose = await tabCount()
    await gm.evaluate(`window.__gmNotify(); 'ok'`)
    await gm.evaluate(`window.__gmDownload(); window.__gmDownloadBlocked(); 'ok'`)
    await sleep(3000)
    out.notificationDone = await gm.evaluate('window.__misc.notificationDone === true')
    out.download = { script: await gm.evaluate('window.__misc.download'), blocked: await gm.evaluate('window.__misc.downloadBlocked'), file: fs.existsSync(path.join(downloadDir, 'gm-test.bin')) ? fs.readFileSync(path.join(downloadDir, 'gm-test.bin'), 'utf-8') : null }

    // 4. values: shared between tabs, kept across reloads, saved to disk
    const gm2 = await open(uiPage, `${BASE}/gm?2`)
    await sleep(1000)
    out.secondTabCount = await gm2.evaluate('window.__gm.count')
    await gm.evaluate(`window.__gmSet('shared', 5); 'ok'`)
    await sleep(500)
    out.valueChange = { otherTab: await gm2.evaluate('window.__gm.changes'), sameTab: await gm.evaluate('window.__gm.changes') }
    await sleep(1500)
    const valueFile = path.join(dataDir, 'values', 'gm-values.user.js.json')
    out.valueFile = fs.existsSync(valueFile) ? JSON.parse(fs.readFileSync(valueFile, 'utf-8')) : null
    await gm2.send('Page.reload')
    await sleep(1500)
    out.afterReloadCount = await gm2.evaluate('window.__gm.count')

    // 5. manual run of a context-menu script with Greasemonkey functions
    out.manualRun = await uiPage.evaluate(`(async () => {
      const tabId = tabs.get().find(t => t.url.endsWith('/gm?1')).id
      await ipc.invoke('userscripts-run', { tabId, scriptId: 'gm-menu-run.user.js' })
      await ipc.invoke('userscripts-run', { tabId, scriptId: 'gm-menu-run.user.js' })
      return 'ran twice'
    })()`)
    await sleep(500)
    out.manualValue = await gm.evaluate('window.__manual')

    // 6. strict CSP + Trusted Types page
    const csp = await open(uiPage, `${BASE}/csp`)
    await sleep(1500)
    out.csp = await csp.evaluate(`({ gm: window.__cspGM, style: getComputedStyle(document.documentElement).getPropertyValue('--gm-csp').trim() })`)

    // 7. install from a .user.js link
    const linkPage = await open(uiPage, `${BASE}/back`)
    await linkPage.evaluate(`location.href = '${BASE}/install/test.user.js'; 'ok'`)
    let installTarget = await waitFor(() => pageTarget(u => u.startsWith('min://app/pages/userscriptInstall/')))
    out.installPageURL = installTarget && installTarget.url
    await sleep(1500)
    let install = cdp(installTarget.webSocketDebuggerUrl)
    pages.push(install)
    out.installPage = await install.evaluate(`({ name: document.getElementById('script-name').textContent, meta: document.getElementById('script-meta').textContent, warnings: Array.from(document.querySelectorAll('#warnings > li')).map(li => li.textContent), permissions: document.getElementById('permissions').innerText, button: document.getElementById('install-button').textContent, codeShown: document.getElementById('code').textContent.includes('==UserScript==') })`)
    await sleep(500)
    out.historyAfterPrompt = await mainProc.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().startsWith('min://app/pages/userscriptInstall/')); return wc ? wc.navigationHistory.getAllEntries().map(e => e.url) : null })()`)
    await install.evaluate(`document.getElementById('install-button').click(); 'clicked'`)
    await waitFor(() => install.evaluate(`document.getElementById('status').textContent.startsWith('Installed')`))
    out.installStatus = await install.evaluate(`document.getElementById('status').textContent`)
    out.installedFile = fs.readdirSync(scriptDir).filter(f => f.startsWith('Installed'))
    out.registry = JSON.parse(fs.readFileSync(path.join(dataDir, 'scripts.json'), 'utf-8'))['Installed.user.js']
    await install.evaluate(`document.getElementById('cancel-button').click(); 'done'`)
    await sleep(1000)
    await sleep(1000)
    out.afterDone = await uiPage.evaluate(`tabs.get().map(t => t.url)`)
    out.afterDoneViews = (await targets()).filter(t => t.type === 'page').map(t => t.url)
    const installed = await open(uiPage, `${BASE}/installed`)
    await sleep(800)
    out.installedRuns = await installed.evaluate('window.__installed')

    // 8. updates through the Settings page: same permissions (automatic), more permissions (needs approval), local edit
    const settingsPage = await open(uiPage, 'min://app/pages/settings/index.html')
    await sleep(1000)
    installVersion = '1.1'
    out.update11 = await settingsPage.evaluate(`userscriptPages.request('check-updates').then(d => d.scripts.filter(s => s.name === 'Installed').map(s => ({ version: s.version, pending: s.pendingUpdate })))`)
    installVersion = '1.2'
    out.update12 = await settingsPage.evaluate(`userscriptPages.request('check-updates').then(d => d.scripts.filter(s => s.name === 'Installed').map(s => ({ version: s.version, pending: s.pendingUpdate })))`)
    // review the pending update on the install page
    await settingsPage.evaluate(`window.location = 'min://app/pages/userscriptInstall/index.html?url=' + encodeURIComponent('${BASE}/install/test.user.js') + '&id=Installed.user.js'; 'ok'`)
    await sleep(2000)
    installTarget = await pageTarget(u => u.startsWith('min://app/pages/userscriptInstall/') && u.includes('&id='))
    install = cdp(installTarget.webSocketDebuggerUrl)
    pages.push(install)
    out.reviewPage = await install.evaluate(`({ heading: document.getElementById('heading').textContent, warnings: Array.from(document.querySelectorAll('#warnings > li')).map(li => li.textContent), button: document.getElementById('install-button').textContent })`)
    await install.evaluate(`document.getElementById('install-button').click(); 'clicked'`)
    await waitFor(() => install.evaluate(`document.getElementById('status').textContent.startsWith('Installed')`))
    out.afterReviewVersion = JSON.parse(fs.readFileSync(path.join(dataDir, 'scripts.json'), 'utf-8'))['Installed.user.js'].pendingUpdate || 'no pending update'
    await installed.send('Page.reload')
    await sleep(1000)
    out.installedRunsAfterUpdate = await installed.evaluate('window.__installed')
    // a local edit stops automatic updates
    fs.appendFileSync(path.join(scriptDir, 'Installed.user.js'), '\n// edited locally\n')
    await sleep(800)
    installVersion = '1.3'
    await install.evaluate(`history.back(); 'ok'`)
    await sleep(1500)
    const settingsTarget = await pageTarget(u => u.startsWith('min://app/pages/settings/'))
    const settings2 = cdp(settingsTarget.webSocketDebuggerUrl)
    pages.push(settings2)
    out.updateEdited = await settings2.evaluate(`userscriptPages.request('check-updates').then(d => d.scripts.filter(s => s.name === 'Installed').map(s => ({ version: s.version, pending: s.pendingUpdate })))`)

    // 9. the Settings list: errors, disable, remove
    out.settingsList = await settings2.evaluate(`userscriptPages.request('list').then(d => d.scripts.map(s => ({ name: s.name, enabled: s.enabled, from: s.sourceURL ? 'web' : 'local', downloadError: s.downloadError || undefined, pending: s.pendingUpdate ? s.pendingUpdate.reason : undefined })))`)
    await sleep(500)
    out.settingsRendered = await settings2.evaluate(`Array.from(document.querySelectorAll('.userscript-item')).map(i => i.innerText.replace(/\\s+/g, ' ').trim())`)
    await settings2.evaluate(`userscriptPages.request('set-enabled', { id: 'gm-disabled.user.js', enabled: false }).then(() => userscriptPages.request('remove', { id: 'gm-remove.user.js' })).then(() => 'ok')`)
    await sleep(800)
    await gm.send('Page.reload')
    await sleep(1500)
    out.afterDisableRemove = await gm.evaluate(`({ disabledRan: window.__toDisable === true, removedRan: window.__toRemove === true, removedFileExists: ${JSON.stringify(fs.existsSync(path.join(scriptDir, 'gm-remove.user.js')))} })`)
    out.removedFileExists = fs.existsSync(path.join(scriptDir, 'gm-remove.user.js'))

    // 10. a non-management min:// page can't use the management messages
    const newtab = await open(uiPage, 'min://app/pages/newtab/index.html', u => u.startsWith('min://app/pages/newtab'))
    out.otherPageBlocked = await newtab.evaluate(`new Promise(r => { window.addEventListener('message', e => { if (e.data && e.data.message === 'userscriptsResult') r(e.data.error || 'allowed!') }); window.postMessage({ message: 'userscripts', requestId: 1, action: 'list' }, location.origin); setTimeout(() => r('no reply'), 2000) })`)

    // 11. a local .user.js file opens the install page too (noticed by the preload, since file: has no response headers)
    const localFile = path.join(downloadDir, 'local-test.user.js')
    fs.writeFileSync(localFile, userscript(['@name Local file', '@match ${BASE}/local*'], 'window.__local = 1'))
    const localURL = require('url').pathToFileURL(localFile).href
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(localURL)} }); 'ok'`)
    const localInstall = await waitFor(() => pageTarget(u => u.startsWith('min://app/pages/userscriptInstall/') && u.includes('local-test.user.js')))
    out.localInstallPage = localInstall ? decodeURIComponent(localInstall.url.split('url=')[1]) : 'did not open'
    out.localInstallHistory = await mainProc.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().includes('local-test.user.js') && w.getURL().startsWith('min://')); return wc ? wc.navigationHistory.getAllEntries().map(e => e.url.slice(0, 60)) : null })()`)

    // 12. "New script" creates a template and opens it in Notepad (closed again here)
    out.createdScript = await settings2.evaluate(`userscriptPages.request('create')`)
    await sleep(1500)
    out.createdFile = fs.existsSync(path.join(scriptDir, out.createdScript)) ? fs.readFileSync(path.join(scriptDir, out.createdScript), 'utf-8').split('\n').slice(0, 3) : null
    const ps1 = path.join(t.runDir, 'close-notepad.ps1')
    fs.writeFileSync(ps1, "Get-CimInstance Win32_Process -Filter \"Name='notepad.exe'\" | Where-Object { $_.CommandLine -like '*New script.user.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }")
    out.notepadClosed = require('child_process').execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps1 + '"').toString().trim()

    out.mainLog = await mainProc.evaluate('global.__usLog')
    pages.forEach(p => p.close())
    uiPage.close(); mainProc.close()
  } catch (e) {
    out.error = String(e.stack || e)
  } finally {
    server.close()
    await sleep(1500)
    out.serverRequests = requests.filter(r => !r.includes('/favicon')).slice(0, 80)
    out.mainProcessOutput = t.childLog().split('\n').filter(l => /userscript|Error|error|warn/i.test(l)).slice(0, 30)
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(out, null, 2))
    t.check('no script error', !out.error, out.error)
    // the order of open pages and of concurrent requests changes from run to run: compare them as sets. mainLog (which frames
    // asked for scripts) depends on timing too, and holds no script names in this suite: not compared
    sortForComparison(out)
    t.compareToExpected(out, [/^\.mainLog/,/^\.mainProcessOutput/, /\.(installedAt|updatedAt|lastUpdateCheck)$/, /^\.misc\.menuId$/, /^\.notepadClosed$/, /^\.timings?\b/])
    t.finish()
  }
})()
