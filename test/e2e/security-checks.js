// Checks for weaknesses a code review reported on 2026-11-12 (AGENTS.md section 15, "Security review"). Each check passes
// when Min is safe and fails while the weakness is there, so the first run shows which reports are real.
//   A1 the error page (min://app/pages/error) went to its `url` parameter without looking at it, so a javascript: address
//      ran script on Min's own internal pages, which can change any setting. Who can open such a page: a website? an
//      extension (tabs.create)?
//   A2 an extension package whose version is ".." was written over the whole extensions folder
//   A3 a second spelling of manifest.json in an extension's zip (MANIFEST.JSON, manifest.json::$DATA) replaced the
//      manifest the user had reviewed, on Windows, where both name one file
//   A4 GM_xmlhttpRequest followed redirects to sites the script's @connect doesn't list, with cookies
//   A5 an extension's hidden helper page (offscreen document) has no context isolation: can its code reach Min's raw IPC?
//   B1 internal pages took settings from any window that posted them (a website that opened the page as a popup)
//   B2 the address bar showed an address the tab never went to (a navigation that ends without a page: 204 No Content)
//   B3 the userscript install page kept the script it showed by address only: a second install page for the same address
//      replaced what the first one installs
//   B4 the userscript install page read any local file its address named (and a UNC path would reach another computer)
//   B5 two sign-in prompts open at once both showed the second site's name
//   B6 a site allowed to use the camera got it without asking inside another site's frame
//   B7 a redirect loop seen earlier made main's check for the PDF viewer recurse forever (main-process error)
//   B8 an extension update could install an older version
const fs = require('fs')
const http = require('http')
const path = require('path')
const { makeZip, makeCrx, makeCrxKeys } = require('./make-crx.js')

const PORT = 8791
const SITE = `http://127.0.0.1:${PORT}`
const OTHER = `http://localhost:${PORT}` // another site to Chromium (host permissions, @connect, cookies go by host name)
const SCRIPT_HOST_PAGE = SITE + '/userscript-target'

// `node test/e2e/security-checks.js without-navigation-guard B1` switches off only A1's guard (websites can't go to
// min:// pages) in main.build.js for that run, so B1's own fix is tested on a route A1's guard would block
const WITHOUT_GUARD = process.argv.includes('without-navigation-guard')
const t = require('./harness')({
  name: 'security-checks' + (WITHOUT_GUARD ? '-without-navigation-guard' : ''),
  minutes: 12,
  stopOnMainErrors: false, // B7 expects one when the weakness is there; recorded instead
  settings: {
    userscriptsEnabled: true,
    // B6: the camera and microphone allowed for 127.0.0.1 only
    sitePermissions: { '127.0.0.1': { 'media:video': 'allow', 'media:audio': 'allow' } }
  }
})
const { sleep, check, finish, target, waitFor, launch, list, ui } = t
if (WITHOUT_GUARD) {
  t.patchFile('main.build.js', function (text) {
    const guards = ['if (isInternalPageURL(event.url) && !(event.initiator && isInternalPageURL(event.initiator.url))) {', 'if (isInternalPageURL(details.url) && !isInternalPageURL(view.webContents.getURL())) {']
    guards.forEach(function (code) {
      if (!text.includes(code)) throw new Error('security-checks: the guard to switch off has moved: ' + code)
      text = text.replace(code, 'if (false) {')
    })
    return text
  })
}

/* the test sites */

const seen = { auth: [], scriptServes: 0, pdfServes: 0, secretCookies: [], swap: false }
const ERROR_PAGE = 'min://app/pages/error/index.html'
// a javascript: address that marks the page and asks Min to change a setting, as an attacker's would
const PAYLOAD = "javascript:document.title='A1 ran';postMessage({message:'setSetting',key:'securityProbe',value:'A1'},'*');void 0"
const errorPageFor = marker => ERROR_PAGE + '?ec=-105&url=' + encodeURIComponent(PAYLOAD) + '&m=' + marker
const userscript = (version, body) => [
  '// ==UserScript==', '// @name Install race probe', '// @namespace min-test', '// @version ' + version,
  '// @match ' + SITE + '/nothing*', '// @grant none', '// ==/UserScript==', body
].join('\n')

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, SITE)
  const html = body => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8">' + body) }
  switch (url.pathname) {
    case '/attacker':
      return html('<title>attacker</title><script>' +
        'window.go = u => { location.href = u }; window.openTab = u => { window.open(u) }; window.openPopup = u => { window.open(u, "p" + Math.random(), "width=400,height=300") };' +
        'window.frame = u => { const f = document.createElement("iframe"); f.src = u; document.body.appendChild(f) };' +
        // B1: a popup that fails to load shows Min's error page, which this page still holds
        'window.failingPopup = () => { window.popup = window.open("http://127.0.0.1:1/", "failing", "width=400,height=300"); return 1 };' +
        'window.forgeSettings = () => { window.popup.postMessage({ message: "receiveSettingsData", settings: { securityProbe: "B1", darkMode: true } }, "*"); return 1 }' +
        '</script><h1>attacker</h1>')
    case '/nocontent':
      res.writeHead(204)
      return res.end()
    case '/spoof':
      return html('<title>spoofing page</title><h1>not the other site</h1>')
    case '/self':
      res.writeHead(302, { location: '/self' })
      return res.end()
    case '/prime':
      // fills main's redirect list with a loop, then shows a PDF (Min opens its PDF viewer, which fetches it again)
      return html('<title>prime</title><script>fetch("/self").catch(() => {}).finally(() => { setTimeout(() => { location.href = "/doc.pdf" }, 300) })</script>')
    case '/doc.pdf':
      seen.pdfServes++
      if (seen.pdfServes === 1) {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        return res.end('%PDF-1.4\n%%EOF\n')
      }
      // the viewer's own request: into the loop
      res.writeHead(302, { location: '/self' })
      return res.end()
    case '/redirect-out':
      res.writeHead(302, { location: OTHER + '/secret' })
      return res.end()
    case '/secret':
      seen.secretCookies.push(req.headers.cookie || '')
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('SECRET')
    case '/set-cookie':
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=other-site-secret; path=/' })
      return res.end('<title>cookie set</title>')
    case '/userscript-target':
      return html('<title>userscript target</title><h1>target</h1>')
    case '/race.user.js':
      // what the user reviews, until the suite flips `swap`: then what an attacker swaps in
      seen.scriptServes++
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(userscript(seen.swap ? '2.0' : '1.0', seen.swap ? 'window.__race = "swapped"' : 'window.__race = "reviewed"'))
    case '/auth-a':
    case '/auth-b':
      if (req.headers.authorization) {
        seen.auth.push({ host: req.headers.host, path: url.pathname, user: Buffer.from(req.headers.authorization.split(' ')[1] || '', 'base64').toString().split(':')[0] })
        return html('<title>signed in</title>')
      }
      res.writeHead(401, { 'www-authenticate': 'Basic realm="test ' + url.pathname + '"', 'content-type': 'text/html' })
      return res.end('<title>401</title>')
    case '/cam':
      return html('<title>camera</title><script>navigator.mediaDevices.getUserMedia({ video: true }).then(s => { s.getTracks().forEach(t => t.stop()); top.postMessage("granted", "*") }, e => top.postMessage("refused " + e.name, "*"))</script>')
    case '/embed-cam':
      return html('<title>waiting</title><script>addEventListener("message", e => { document.title = String(e.data) })</script><iframe allow="camera; microphone" src="' + SITE + '/cam"></iframe>')
    default:
      return html('<title>page ' + url.pathname + '</title>')
  }
})
server.listen(PORT, '127.0.0.1')

/* files made before Min starts */

// A4: a userscript that may connect to its own page's host (127.0.0.1) only
const scriptDir = path.join(t.profileDir, 'userscripts')
fs.mkdirSync(scriptDir, { recursive: true })
fs.writeFileSync(path.join(scriptDir, 'Connect probe.user.js'), [
  '// ==UserScript==', '// @name Connect probe', '// @namespace min-test', '// @match ' + SCRIPT_HOST_PAGE + '*',
  '// @grant GM_xmlhttpRequest', '// @connect 127.0.0.1', '// ==/UserScript==',
  'GM_xmlhttpRequest({ url: "' + SITE + '/redirect-out", onload: r => { document.title = "loaded " + r.status + " " + r.responseText }, onerror: e => { document.title = "refused " + (e.error || "") } })'
].join('\n'))

// extension packages
const crxDir = path.join(t.runDir, 'crx')
fs.mkdirSync(crxDir, { recursive: true })
const manifest = (name, extra = {}) => JSON.stringify(Object.assign({ manifest_version: 3, name, version: '1.0', description: 'Min security check' }, extra))
const writeCrx = (file, files, options) => { const made = makeCrx(makeZip(files), options); fs.writeFileSync(path.join(crxDir, file), made.crx); return made.id }
const filler = {}
for (let i = 0; i < 80; i++) filler['f/' + i + '.js'] = '// ' + 'x'.repeat(40000) + '\n'
const victimId = writeCrx('victim.crx', { 'manifest.json': manifest('Victim') })
const dotsId = writeCrx('dots.crx', { 'manifest.json': manifest('Dots', { version: '..' }), 'planted/readme.txt': 'planted' })
const upperId = writeCrx('upper.crx', Object.assign({ 'manifest.json': manifest('Upper case') }, filler, { 'MANIFEST.JSON': manifest('Upper case', { permissions: ['cookies'], host_permissions: ['<all_urls>'] }) }))
const streamId = writeCrx('stream.crx', Object.assign({ 'manifest.json': manifest('Data stream') }, filler, { 'manifest.json::$DATA': manifest('Data stream', { permissions: ['cookies'], host_permissions: ['<all_urls>'] }) }))
// B8: version 2.0 installed, its update server offers 1.0 signed with the same key
const updateKeys = makeCrxKeys()
const UPDATE_URL = 'https://updates.min-security-check.test/update.xml'
const updatingId = writeCrx('update-2.crx', { 'manifest.json': manifest('Updating', { version: '2.0', update_url: UPDATE_URL }) }, { keys: updateKeys })
writeCrx('update-1.crx', { 'manifest.json': manifest('Updating', { version: '1.0', update_url: UPDATE_URL }) }, { keys: updateKeys })
// B4: a local file a page shouldn't be able to have main read
const secretFile = path.join(t.runDir, 'private', 'notes.user.js')
fs.mkdirSync(path.dirname(secretFile), { recursive: true })
fs.writeFileSync(secretFile, userscript('9', '// LOCAL-FILE-MARKER'))

/* helpers */

// runs code in a page as if the user had just clicked (window.open and the like need that)
const withClick = (connection, expression) => connection.send('Runtime.evaluate', { expression, userGesture: true, returnByValue: true })
// the addresses of every frame in the tab showing a page
const frameURLs = (main, prefix) => main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(prefix)})); return wc ? wc.mainFrame.framesInSubtree.map(f => f.url) : [] })()`)
const pageTarget = (prefix, ms = 10000) => target(x => x.type === 'page' && x.url.startsWith(prefix), ms)
const targetsStartingWith = async prefix => (await list()).filter(x => x.url.startsWith(prefix))
const openTab = (u, url) => u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
const closeTabsStartingWith = (u, prefix) => u.evaluate(`tabs.get().filter(t => t.url.startsWith(${JSON.stringify(prefix)})).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1`)
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null } }
const registry = () => (readJSON(path.join(t.profileDir, 'extensions.json')) || {}).extensions || {}
// `node test/e2e/security-checks.js A1 B5` runs only those sections
const ONLY = process.argv.slice(2).filter(arg => arg !== 'without-navigation-guard')
async function section (name, fn) {
  if (ONLY.length > 0 && !ONLY.some(wanted => name.split('-').includes(wanted))) {
    return
  }
  try {
    await fn()
  } catch (e) {
    check(name + ': the check itself failed', false, String(e.stack || e).slice(0, 600))
  }
}

;(async () => {
  let main
  try {
    main = await launch(SITE + '/start', { args: ['--use-fake-device-for-media-stream'] })
    const u = await ui()
    await sleep(1500)

    // Settings, for installing extensions
    await openTab(u, 'min://settings')
    const settingsPage = await pageTarget('min://app/pages/settings/')
    await waitFor(async () => (await settingsPage.evaluate('typeof extensionPages')) === 'object')
    const installCrx = async file => {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(path.join(crxDir, file))}; 1`)
      return settingsPage.evaluate("extensionPages.request('install-crx').catch(e => 'refused: ' + e.message)")
    }
    const loadUnpacked = async folder => {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(folder)}; 1`)
      return settingsPage.evaluate("extensionPages.request('load-unpacked').catch(e => 'refused: ' + e.message)")
    }

    await section('A1', async function () {
      // a website tries every way to get one of its tabs, popups or frames onto an internal page it chose
      await openTab(u, SITE + '/attacker')
      const attacker = await pageTarget(SITE + '/attacker')
      await sleep(1000)
      const tries = { location: 'go', newTab: 'openTab', popup: 'openPopup', frame: 'frame' }
      const reached = {}
      for (const [way, fn] of Object.entries(tries)) {
        await withClick(attacker, `${fn}(${JSON.stringify(errorPageFor(way))}); 1`).catch(() => {})
        await sleep(2000)
        reached[way] = (await targetsStartingWith(errorPageFor(way))).length > 0 ||
          (await u.evaluate(`tabs.get().some(t => t.url.includes('m=${way}'))`)) === true ||
          (await frameURLs(main, SITE + '/attacker')).some(url => url.includes('m=' + way))
      }
      check('A1 a website can\'t open Min\'s internal pages (address, new tab, popup, frame)', Object.values(reached).every(r => !r), reached)
      attacker.close()
      await closeTabsStartingWith(u, SITE + '/attacker')
      await closeTabsStartingWith(u, ERROR_PAGE)

      // the error page with a javascript: address, as the user or an extension could open it; then "Try again"
      await openTab(u, errorPageFor('direct'))
      const errorPage = await target(x => x.type === 'page' && x.url.startsWith(ERROR_PAGE) && x.url.includes('m=direct'), 10000)
      await sleep(1000)
      await errorPage.evaluate("document.getElementById('primary-button').click(); 1").catch(() => {})
      await sleep(2500)
      const title = await errorPage.evaluate('document.title').catch(e => 'gone: ' + e.message)
      const probe = t.readSettings().securityProbe
      check('A1 the error page\'s "Try again" doesn\'t run a javascript: address', title !== 'A1 ran' && probe !== 'A1', { title, settingWrittenByThePage: probe || null })
      errorPage.close()
      await closeTabsStartingWith(u, ERROR_PAGE)
    })

    await section('B1', async function () {
      // the website opens a popup of its own, sends it to Min's Settings page (A1 shows a page may go there) and keeps
      // its handle on it, then posts the page made-up settings
      await openTab(u, SITE + '/attacker?b1')
      const attacker = await pageTarget(SITE + '/attacker?b1')
      await sleep(1000)
      await withClick(attacker, `window.popup = window.open(${JSON.stringify(SITE + '/popup')}, 'b1', 'width=400,height=300'); 1`)
      await sleep(2000)
      await attacker.evaluate("window.popup.location.href = 'min://app/pages/settings/index.html?b1'; 1").catch(() => {})
      const popupSettings = await pageTarget('min://app/pages/settings/index.html?b1', 10000)
      if (!popupSettings) {
        check('B1 (info): the popup couldn\'t be sent to Settings, so this route can\'t be tried', true)
        attacker.close()
        return
      }
      await waitFor(async () => (await popupSettings.evaluate('settings.loaded')) === true)
      await attacker.evaluate("window.popup.postMessage({ message: 'receiveSettingsData', settings: { securityProbe: 'B1', filtering: { trackers: false, exceptionDomains: ['forged.example'] } } }, '*'); 1")
      await sleep(2500)
      const seenByPage = await popupSettings.evaluate('settings.list.securityProbe || null')
      const filtering = t.readSettings().filtering || null
      check('B1 an internal page doesn\'t take settings posted by another window (nor writes them back)', seenByPage !== 'B1' && !(filtering && JSON.stringify(filtering).includes('forged.example')), { seenByPage, filteringSaved: filtering })
      popupSettings.close()
      attacker.close()
      await closeTabsStartingWith(u, 'min://app/pages/settings/index.html?b1')
      await closeTabsStartingWith(u, SITE + '/attacker')
      await closeTabsStartingWith(u, SITE + '/popup')
    })

    await section('B2', async function () {
      await openTab(u, SITE + '/spoof')
      const spoof = await pageTarget(SITE + '/spoof')
      await sleep(1000)
      await spoof.evaluate(`location.href = ${JSON.stringify(OTHER + '/nocontent')}; 1`)
      await sleep(3000)
      const shown = await u.evaluate("(tabs.get().find(t => t.url.includes('/nocontent') || t.url.includes('/spoof')) || {}).url")
      const actual = await spoof.evaluate('location.href')
      check('B2 the address bar shows the page that\'s really there after a navigation that ends without a page (204)', shown === actual, { addressBar: shown, page: actual })
      // the same address typed by the user (Min starts it, so it's shown at once): once it ends without a page, the
      // address bar goes back to the page that's there
      const tabId = await u.evaluate(`tabs.get().find(t => t.url === ${JSON.stringify(actual)}).id`)
      await u.evaluate(`ipc.emit('extensions-load-tab', {}, { tabId: ${JSON.stringify(tabId)}, url: ${JSON.stringify(OTHER + '/nocontent?typed')} }); 1`)
      await sleep(3000)
      const shownAfterTyped = await u.evaluate(`(tabs.get().find(t => t.id === ${JSON.stringify(tabId)}) || {}).url`)
      const actualAfterTyped = await spoof.evaluate('location.href')
      check('B2 a typed address that ends without a page: the address bar goes back to the page that\'s there', shownAfterTyped === actualAfterTyped, { addressBar: shownAfterTyped, page: actualAfterTyped })
      spoof.close()
      await closeTabsStartingWith(u, SITE + '/spoof')
      await closeTabsStartingWith(u, OTHER + '/nocontent')
    })

    await section('B7', async function () {
      await main.evaluate('global.__mainErrors = []; 1')
      await openTab(u, SITE + '/prime')
      await sleep(6000)
      const errors = await main.evaluate('global.__mainErrors')
      const viewer = (await targetsStartingWith('min://app/pages/pdfViewer')).length > 0
      check('B7 a redirect loop and a PDF don\'t make main\'s PDF viewer check recurse forever', Array.isArray(errors) && !errors.some(e => /Maximum call stack/.test(e)), { pdfViewerOpened: viewer, pdfRequests: seen.pdfServes, mainErrors: (errors || []).map(e => e.slice(0, 160)) })
      await closeTabsStartingWith(u, 'min://app/pages/pdfViewer')
      await closeTabsStartingWith(u, SITE + '/prime')
    })

    await section('A4', async function () {
      // the other site has a cookie the script shouldn't be able to send or read
      await openTab(u, OTHER + '/set-cookie')
      await sleep(1500)
      await closeTabsStartingWith(u, OTHER + '/set-cookie')
      await openTab(u, SCRIPT_HOST_PAGE)
      const page = await pageTarget(SCRIPT_HOST_PAGE)
      const title = await waitFor(async () => { const v = await page.evaluate('document.title'); return /^(loaded|refused)/.test(v) ? v : null }, 10000)
      check('A4 GM_xmlhttpRequest doesn\'t follow a redirect to a site the script\'s @connect doesn\'t list', !/SECRET/.test(title || ''), { result: title, cookiesSentToTheOtherSite: seen.secretCookies })
      page.close()
      await closeTabsStartingWith(u, SCRIPT_HOST_PAGE)
    })

    await section('B3', async function () {
      // two install pages for one address: the user reviews the first, an attacker's page opens the second
      await openTab(u, SITE + '/race.user.js')
      const first = await pageTarget('min://app/pages/userscriptInstall/')
      await waitFor(async () => (await first.evaluate("!document.getElementById('details').hidden")) === true)
      const reviewed = await first.evaluate("document.body.innerText.includes('1.0')")
      seen.swap = true
      await openTab(u, SITE + '/race.user.js')
      await sleep(3000)
      await first.evaluate("document.getElementById('install-button').click(); 1")
      await sleep(2000)
      const files = fs.readdirSync(scriptDir).filter(f => f.startsWith('Install race probe'))
      const installed = files.map(f => fs.readFileSync(path.join(scriptDir, f), 'utf8')).join('\n')
      check('B3 the userscript installed is the one its install page showed', !installed.includes('swapped'), { firstPageShowedVersion1: reviewed, serves: seen.scriptServes, installed: installed.includes('swapped') ? 'swapped' : installed.includes('reviewed') ? 'reviewed' : 'nothing' })
      first.close()
      await closeTabsStartingWith(u, 'min://app/pages/userscriptInstall/')
    })

    await section('A2-A3-B8', async function () {
      // A2: another extension is installed first; the ".." package mustn't touch it
      const victim = await installCrx('victim.crx')
      const victimFolder = path.join(t.profileDir, 'extensions', victimId)
      const dots = await installCrx('dots.crx')
      check('A2 an extension whose version is ".." is refused and leaves the other extensions alone', victim === victimId && dots !== dotsId && fs.existsSync(victimFolder) && !fs.existsSync(path.join(t.profileDir, 'extensions', 'planted')), { victim, dots, victimStillThere: fs.existsSync(victimFolder), plantedFolder: fs.existsSync(path.join(t.profileDir, 'extensions', 'planted')) })

      // A3: the manifest the user reviewed is the one installed
      for (const [file, id, label] of [['upper.crx', upperId, 'MANIFEST.JSON'], ['stream.crx', streamId, 'manifest.json::$DATA']]) {
        const dialogsBefore = await main.evaluate('__dialogs.length')
        const result = await installCrx(file)
        const review = await main.evaluate(`__dialogs.slice(${dialogsBefore}).map(d => d.detail || d.message).join(' | ')`)
        const entry = registry()[id]
        const installed = entry ? readJSON(path.join(entry.path, 'manifest.json')) : null
        const loaded = await main.evaluate(`(() => { const e = process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.getExtension(${JSON.stringify(id)}); return e ? e.manifest.permissions || [] : null })()`)
        check('A3 a second spelling of manifest.json (' + label + ') doesn\'t replace the reviewed one', !(installed && (installed.permissions || []).includes('cookies')) && !(loaded || []).includes('cookies'), { result, reviewShown: review.slice(0, 200), installedPermissions: installed && installed.permissions, loadedPermissions: loaded })
      }

      // B8: the update server offers an older version
      const installed = await installCrx('update-2.crx')
      await main.evaluate(`(() => {
        const electron = process.mainModule.require('electron')
        const fs = process.mainModule.require('fs')
        const original = electron.net.fetch
        electron.net.fetch = async function (url, options) {
          if (String(url).startsWith(${JSON.stringify(UPDATE_URL)})) {
            return new Response('<?xml version="1.0"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${updatingId}"><updatecheck codebase="https://updates.min-security-check.test/update-1.crx" version="3.0" status="ok"/></app></gupdate>')
          }
          if (String(url) === 'https://updates.min-security-check.test/update-1.crx') {
            return new Response(fs.readFileSync(${JSON.stringify(path.join(crxDir, 'update-1.crx'))}))
          }
          return original.call(this, url, options)
        }
        return 1 })()`)
      await settingsPage.evaluate("extensionPages.request('check-updates').catch(e => 'error: ' + e.message)")
      await sleep(1500)
      const version = (registry()[updatingId] || {}).version
      check('B8 an extension update never installs an older version', installed === updatingId && version === '2.0', { installed, versionAfterUpdateCheck: version, updateError: (registry()[updatingId] || {}).updateError })
    })

    await section('A5', async function () {
      const id = await loadUnpacked(t.extension('offscreen'))
      const worker = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
      await worker.evaluate('openHelper()')
      const helper = await target(x => x.url === 'chrome-extension://' + id + '/offscreen.html', 15000)
      const reach = await helper.evaluate(`(() => {
        const out = { require: typeof require, process: typeof process, module: typeof module }
        out.globals = Object.getOwnPropertyNames(globalThis).filter(n => /ipc|electron|require|node|process/i.test(n))
        let ipc = null
        try { ipc = require('electron').ipcRenderer } catch (e) { out.requireError = e.message }
        out.rawIPC = !!(ipc && typeof ipc.send === 'function')
        return out
      })()`)
      check('A5 an extension\'s hidden helper page can\'t reach Min\'s raw IPC', reach && reach.rawIPC === false && reach.require === 'undefined', reach)
      worker.close()
      helper.close()
    })

    await section('B4', async function () {
      // an extension (with no permissions at all) opens the install page for a local file
      const id = await loadUnpacked(t.extension('unprivileged'))
      const worker = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
      const installPage = 'min://app/pages/userscriptInstall/index.html?url=' + encodeURIComponent(require('url').pathToFileURL(secretFile).href)
      const opened = await worker.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(installPage)}, active: false }).then(() => 'opened', e => 'refused: ' + e.message)`)
      const page = await pageTarget('min://app/pages/userscriptInstall/index.html?url=file', 10000)
      const shown = page ? await waitFor(async () => { const v = await page.evaluate('(() => { const status = document.getElementById("status"); const details = document.getElementById("details"); if (details.hidden && (status.hidden || !status.textContent.trim())) return null; return { details: !details.hidden, status: status.hidden ? "" : status.textContent, name: document.getElementById("script-name").textContent, marker: document.body.innerHTML.includes("LOCAL-FILE-MARKER") } })()'); return v && typeof v === 'object' ? v : null }, 15000) : null
      check('B4 the install page doesn\'t read a local file named in its address (an extension opened it)', !(shown && (shown.marker || shown.details)), { opened, pageOpened: !!page, shown })
      // and the same extension opening an internal page with a javascript: address (A1's route for extensions)
      const errorOpened = await worker.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(errorPageFor('extension'))}, active: false }).then(() => 'opened', e => 'refused: ' + e.message)`)
      check('A1 (info): an extension without permissions can open Min\'s internal pages', true, { errorPage: errorOpened, installPage: opened })
      if (page) page.close()
      worker.close()
      await closeTabsStartingWith(u, 'min://app/pages/')
    })

    await section('B6', async function () {
      // 127.0.0.1 may use the camera; localhost puts it in a frame and lets it ask
      await openTab(u, OTHER + '/embed-cam')
      const page = await pageTarget(OTHER + '/embed-cam')
      const title = await waitFor(async () => { const v = await page.evaluate('document.title'); return v !== 'waiting' ? v : null }, 6000)
      const pending = await u.evaluate("Array.from(document.querySelectorAll('.permission-request, #permission-request-bar, .permission-request-bar')).map(e => e.innerText).join(' | ')")
      check('B6 a site allowed the camera doesn\'t get it inside another site\'s frame without a prompt', title !== 'granted', { frameGot: title || 'no answer (a prompt is waiting)', promptText: pending })
      page.close()
      await closeTabsStartingWith(u, OTHER + '/embed-cam')
    })

    await section('B5', async function () {
      await openTab(u, SITE + '/auth-a')
      await openTab(u, OTHER + '/auth-b')
      await sleep(3000)
      const prompts = (await targetsStartingWith('min://app/pages/prompt/')).filter(x => x.type === 'page')
      const shown = []
      for (const p of prompts) {
        const connection = t.connect(p.webSocketDebuggerUrl)
        const label = await connection.evaluate("document.getElementById('label').textContent")
        shown.push(label)
        // the user signs in to the site the prompt names
        const user = /localhost/.test(label) ? 'user-for-b' : 'user-for-a'
        await connection.evaluate(`(() => { const inputs = document.querySelectorAll('#input-container input'); inputs[0].value = ${JSON.stringify(user)}; inputs[1].value = 'pw'; document.getElementById('ok').click(); return 1 })()`).catch(() => {})
        connection.close()
        await sleep(800)
      }
      await sleep(2000)
      const wrong = seen.auth.filter(a => (a.path === '/auth-a' && a.user !== 'user-for-a') || (a.path === '/auth-b' && a.user !== 'user-for-b'))
      check('B5 two sign-in prompts at once each name their own site, and each site gets its own answer', prompts.length === 2 && new Set(shown).size === 2 && wrong.length === 0, { prompts: shown, received: seen.auth })
      await closeTabsStartingWith(u, SITE + '/auth-a')
      await closeTabsStartingWith(u, OTHER + '/auth-b')
    })

    u.close()
    settingsPage.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  server.close()
  finish()
})()
