// Shared harness for Min's end-to-end tests and measurements (test/e2e/README.md, AGENTS.md section 13).
//
// Each run starts Min with a profile of its own in the system's temp folder, deleted afterwards, so neither the
// maintainer's dev profile (%APPDATA%\Min-development) nor their real one (%APPDATA%\Min) is touched.
// Safeguards: a main-process error stops the run (Electron's error dialog would otherwise freeze main and the run would
// hang), a watchdog checks every 3 s that main still answers and Min is still running, and every run has a time limit.
//
// usage in a suite:
//   const t = require('./harness')({ name: 'toolbar', minutes: 8 })
//   const { check, finish, launch, quit, ... } = t
// Environment: MIN_TEST_PACKAGED=1 runs dist/app/win-unpacked/Min.exe instead of the dev build; MIN_TEST_KEEP_PROFILE=1
// keeps the run's profile folder; MIN_TEST_CDP_PORT, MIN_TEST_INSPECT_PORT and MIN_TEST_PAGE_PORT change the ports.
const { spawn, execSync, execFileSync } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')

const root = path.resolve(__dirname, '..', '..')
const packaged = process.env.MIN_TEST_PACKAGED === '1'
const CDP_PORT = Number(process.env.MIN_TEST_CDP_PORT || 9333)
const INSPECT_PORT = Number(process.env.MIN_TEST_INSPECT_PORT || 9339)
const PORT = Number(process.env.MIN_TEST_PAGE_PORT || 8771)
const PAGE = `http://127.0.0.1:${PORT}/page`
// downloads kept between runs: real extensions from Chrome's update server, the ad-block engine
const CACHE = path.join(os.tmpdir(), 'min-e2e-cache')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function isScreenLocked () {
  // Windows draws nothing while it's locked (LogonUI running): visible-window checks (popups, frames, screenshots) fail.
  // Only this Windows session counts: another signed-in account's locked session runs a LogonUI of its own.
  try {
    const session = execSync(`tasklist /FI "PID eq ${process.pid}" /FO CSV /NH`, { encoding: 'utf8' }).trim().split('","')[3]
    return /LogonUI/i.test(execSync(`tasklist /FI "IMAGENAME eq LogonUI.exe" /FI "SESSION eq ${session}"`, { encoding: 'utf8' }))
  } catch (e) {
    return null
  }
}

// The Chromium version Min runs, for Chrome's update server (it serves the newest version that supports it)
function chromiumVersion () {
  try {
    const electron = path.join(root, 'node_modules/electron/dist/electron.exe')
    return execFileSync(electron, ['-p', 'process.versions.chrome'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim()
  } catch (e) {
    return '156.0.0.0'
  }
}

// Real extensions: downloaded once from Chrome's update server into the cache (delete the cache for newer versions)
function crxPath (id) {
  return path.join(CACHE, 'crx', id + '.crx')
}
async function downloadExtensions (ids) {
  const missing = ids.filter(id => !fs.existsSync(crxPath(id)))
  if (missing.length === 0) {
    return
  }
  const { getWebStoreDownloadURL } = require(path.join(root, 'js/util/extensionPackages.js'))
  const version = chromiumVersion()
  fs.mkdirSync(path.join(CACHE, 'crx'), { recursive: true })
  for (const id of missing) {
    // some are big (Bitwarden is tens of MB): up to 10 minutes each
    const response = await fetch(getWebStoreDownloadURL(id, version), { signal: AbortSignal.timeout(600000) })
    if (!response.ok) {
      throw new Error('downloading extension ' + id + ': HTTP ' + response.status)
    }
    fs.writeFileSync(crxPath(id) + '.tmp', Buffer.from(await response.arrayBuffer()))
    fs.renameSync(crxPath(id) + '.tmp', crxPath(id))
    console.log('downloaded extension ' + id)
  }
}

// Repo files a suite changes for its run (t.patchFile) are backed up here and put back when the run ends; a run that was
// killed is put back by the next one
const PATCHED = path.join(CACHE, 'patched')
function restorePatchedFiles () {
  if (!fs.existsSync(PATCHED)) {
    return
  }
  for (const entry of fs.readdirSync(PATCHED)) {
    const original = path.join(root, decodeURIComponent(entry))
    fs.copyFileSync(path.join(PATCHED, entry), original)
    fs.rmSync(path.join(PATCHED, entry))
    console.log('restored ' + original)
  }
}

// Observations that mention this run's temp folder or where the repo is checked out are made comparable between runs and
// machines: those parts become <run> and <repo>
function normalizeObserved (value) {
  const repo = root.replace(/\\/g, '/')
  const text = JSON.stringify(value)
    // file:///C:/Users/…/Temp/min-e2e-run-AbC123 (Chromium writes ~ as %7E) and C:\Users\…\min-e2e-run-AbC123
    .replace(/file:\/\/\/[^"]*?min-e2e-run-[A-Za-z0-9]+/g, 'file:///<run>')
    .replace(/[A-Za-z]:(\\\\|\/)[^"]*?min-e2e-run-[A-Za-z0-9]+/g, '<run>')
    .split('file:///' + repo).join('file:///<repo>')
    .split(repo).join('<repo>')
    // the repo path as it appears inside a JSON string (backslashes escaped)
    .split(JSON.stringify(root).slice(1, -1)).join('<repo>')
  return JSON.parse(text)
}

function removeFolder (folder) {
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    return true
  } catch (e) {
    return false
  }
}

// stopOnMainErrors: false keeps going after a main-process error (the run records them itself, like the extension survey)
// adblockEngine: false starts with no ad-block engine, as a new user's first start does (adblock-first-start)
module.exports = function harness ({ name, minutes = 8, settings = {}, extensions = [], stopOnMainErrors = true, adblockEngine = true }) {
  restorePatchedFiles()
  process.on('exit', restorePatchedFiles)
  // run folders left by a run that was killed (one run at a time, so none of them is in use)
  for (const entry of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('min-e2e-run-'))) {
    removeFolder(path.join(os.tmpdir(), entry))
  }
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-e2e-run-'))
  // Min adds "-development" to --user-data-dir in development mode, so its profile is <userDataDir>-development
  const userDataDir = path.join(runDir, 'profile')
  const profileDir = userDataDir + '-development'
  const resultsDir = path.join(__dirname, 'results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const outFile = process.env.MIN_TEST_OUT || path.join(resultsDir, name + '.json')
  const logFile = outFile.replace(/\.json$/, '') + '.log'
  // a file next to the results, for screenshots and extra data: t.output('popup.png')
  const output = file => path.join(resultsDir, name + '-' + file)

  // a fresh profile: no usage statistics or update checks from test runs; the ad-block engine from the cache, so
  // Min's blocker works from the first page instead of after a 6 MB download and 1-2 s of building
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ collectUsageStats: false, updateNotificationsEnabled: false, ...settings }))
  // an empty saved session, so Min doesn't open its first-run tour (a tab on minbrowser.org) beside the suite's tabs
  fs.writeFileSync(path.join(profileDir, 'sessionRestore.json'), JSON.stringify({ version: 2, state: { tasks: [] } }))
  const cachedEngine = path.join(CACHE, 'adblocker-engine-v2.bin')
  // with no cache yet, start it from a copy of the dev profile's engine (only read, never changed); otherwise the first
  // run's engine is downloaded and kept
  const devEngine = path.join(process.env.APPDATA || '', 'Min-development', 'adblocker-engine-v2.bin')
  if (adblockEngine && !fs.existsSync(cachedEngine) && fs.existsSync(devEngine)) {
    fs.mkdirSync(CACHE, { recursive: true })
    fs.copyFileSync(devEngine, cachedEngine)
  }
  if (adblockEngine && fs.existsSync(cachedEngine)) {
    fs.copyFileSync(cachedEngine, path.join(profileDir, 'adblocker-engine-v2.bin'))
  }

  const results = []
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : '')) }
  const screenLockedAtStart = isScreenLocked()
  if (screenLockedAtStart) {
    console.log('warning: the screen is locked, so Min\'s windows draw nothing; checks that need a visible window will fail')
  }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>page ' + req.url + '</title><body style="height: 100vh"><h1>Test page</h1></body>')
  }).listen(PORT, '127.0.0.1')

  let child = null
  let childLog = ''
  let finished = false
  let watched = null
  // Stops the run: closes Min, writes the results, deletes the profile, exits. Called at the end of a suite, and by the
  // watchdog, the time limit, a script error or Ctrl+C.
  async function finish (stopReason) {
    if (finished) {
      return
    }
    finished = true
    watched = null
    if (stopReason) {
      check('run stopped early: ' + stopReason, false)
    }
    if (child && child.exitCode === null) {
      child.kill()
      await Promise.race([child.exited, sleep(10000)])
    }
    server.close()
    const passed = results.filter(r => r.ok).length
    fs.writeFileSync(outFile, JSON.stringify({ suite: name, packaged, date: new Date().toISOString(), passed, total: results.length, stoppedEarly: stopReason || null, screenLocked: screenLockedAtStart || isScreenLocked(), results }, null, 2))
    fs.writeFileSync(logFile, childLog)
    // keep the newest ad-block engine for the next run
    const engine = path.join(profileDir, 'adblocker-engine-v2.bin')
    try {
      if (fs.existsSync(engine) && (!fs.existsSync(cachedEngine) || fs.statSync(engine).mtimeMs > fs.statSync(cachedEngine).mtimeMs)) {
        fs.mkdirSync(CACHE, { recursive: true })
        fs.copyFileSync(engine, cachedEngine)
      }
    } catch (e) {}
    if (process.env.MIN_TEST_KEEP_PROFILE === '1') {
      console.log('profile kept: ' + profileDir)
    } else if (!removeFolder(runDir)) {
      console.log('couldn\'t delete ' + runDir + ' (still in use); the next run deletes it')
    }
    console.log(passed + '/' + results.length + ' passed')
    process.exit(stopReason || passed < results.length ? 1 : 0)
  }
  // real extensions download first; the time limit starts once they're there
  const prepared = downloadExtensions(extensions)
  prepared.then(() => setTimeout(() => finish('time limit (' + minutes + ' min)'), minutes * 60 * 1000), e => finish('downloading extensions failed: ' + e.message))
  process.on('unhandledRejection', e => finish('test script error: ' + String((e && (e.stack || e.message)) || e).slice(0, 300)))
  process.on('SIGINT', () => finish('interrupted'))

  function connect (wsUrl) {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map()
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
    const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ready.catch(() => {}) // a page that navigated away closes its connection; callers see the failure
    const send = async (method, params = {}) => { await ready; const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise(resolve => pending.set(i, resolve)) }
    return {
      send,
      evaluate: async expression => {
        const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(30000).then(() => ({ timeout: true }))])
        if (r.timeout) return 'TIMEOUT'
        if (r.error) return 'ERR ' + JSON.stringify(r.error)
        return r.result.exceptionDetails ? 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500) : r.result.result.value
      },
      close: () => ws.close()
    }
  }
  async function list (port = CDP_PORT) { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch (e) { return [] } }
  async function waitFor (fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch (e) {} await sleep(250) } return null }
  async function target (predicate, ms) { const t = await waitFor(async () => (await list()).find(predicate), ms); return t ? connect(t.webSocketDebuggerUrl) : null }

  // watchdog: main-process errors, main answering, Min alive
  setInterval(async function () {
    if (!watched || finished) {
      return
    }
    const { main, child: current } = watched
    if (current.exitCode !== null && !current.quitting) {
      return finish('Min exited unexpectedly (code ' + current.exitCode + ')')
    }
    const errors = await Promise.race([main.evaluate('global.__mainErrors || []'), sleep(10000).then(() => 'NO ANSWER')])
    if (!watched || watched.main !== main || current.quitting) {
      return
    }
    if (errors === 'NO ANSWER' || errors === 'TIMEOUT') {
      return finish('the main process stopped answering')
    }
    if (stopOnMainErrors && Array.isArray(errors) && errors.length > 0) {
      return finish('main-process error: ' + errors[0].slice(0, 600))
    }
  }, 3000)

  // Starts Min on a URL in this run's profile, connects to its main process (Node inspector) and sets up the helpers
  // the suites use there: native dialogs answer "yes" and are recorded, native menus are recorded instead of shown.
  async function launch (url, { args = [] } = {}) {
    await prepared
    const common = ['--inspect=' + INSPECT_PORT, '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir, ...args]
    if (packaged) {
      const folder = path.join(root, 'dist/app/win-unpacked')
      child = spawn(path.join(folder, 'Min.exe'), [...common, '--development-mode', url], { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] })
    } else {
      child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [...common, '.', '--development-mode', url], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const keepLog = data => { childLog = (childLog + data).slice(-500000) }
    child.stdout.on('data', keepLog)
    child.stderr.on('data', keepLog)
    child.exited = new Promise(resolve => child.on('exit', resolve))
    const inspector = await waitFor(async () => (await list(INSPECT_PORT))[0])
    if (!inspector) {
      finish('Min didn\'t start')
    }
    const main = connect(inspector.webSocketDebuggerUrl)
    await main.evaluate("global.__mainErrors = []; process.on('uncaughtException', e => global.__mainErrors.push(String(e && e.stack || e))); 1")
    watched = { main, child }
    // the UI's target appears before its page has loaded: wait until its scripts have run
    const uiPage = await target(t => t.url.startsWith('min://app/index.html'))
    if (uiPage) {
      await waitFor(async () => (await uiPage.evaluate("document.readyState === 'complete' && typeof tabs === 'object' && !!document.getElementById('extension-actions')")) === true)
      uiPage.close()
    }
    await main.evaluate(`(() => { const electron = process.mainModule.require('electron')
      global.__dialogs = []
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [global.__nextOpen] })
      electron.dialog.showMessageBox = async (win, options) => { __dialogs.push({ message: options.message, detail: options.detail, buttons: options.buttons, parent: !!(win && win.id) }); return { response: 0 } }
      // native menus are recorded, not shown
      global.__menus = []
      electron.Menu.prototype.popup = function (options) { global.__menus.push({ menu: this, options }) }
      global.__menuLabels = menu => menu.items.map(item => item.type === 'separator' ? '---' : item.label + (item.enabled === false ? ' (disabled)' : '') + (item.submenu ? ' > [' + __menuLabels(item.submenu).join(', ') + ']' : ''))
      global.__clickMenuItem = (label) => { const entry = __menus[__menus.length - 1]; const find = menu => { for (const item of menu.items) { if (item.label === label) return item; if (item.submenu) { const found = find(item.submenu); if (found) return found } } }; const item = find(entry.menu); item.click(item, null, {}); return true }
      global.__tab = () => electron.webContents.getAllWebContents().find(wc => wc.getURL().startsWith(${JSON.stringify(PAGE)}))
      return 1 })()`)
    return main
  }
  // Quits Min and waits for it to exit; returns 'timeout' if it had to be killed after 20 s
  async function quit (main) {
    child.quitting = true
    watched = null
    await main.evaluate("process.mainModule.require('electron').app.quit(); 1")
    main.close()
    const code = await Promise.race([child.exited, sleep(20000).then(() => 'timeout')])
    if (code === 'timeout') { child.kill(); await child.exited }
    return code
  }

  // A fresh copy of a test extension (test/e2e/extensions/<name>) in the run folder: Electron writes into the folders of
  // extensions it loads (_metadata), and some suites change their copy
  function extension (extensionName, copyName = extensionName) {
    const copy = path.join(runDir, 'extensions', copyName)
    if (!fs.existsSync(copy)) {
      fs.cpSync(path.join(__dirname, 'extensions', extensionName), copy, { recursive: true, filter: source => !source.includes('_metadata') })
    }
    return copy
  }

  // Changes a repo file for this run only (change: text => new text), for example to switch off one of Min's workarounds.
  // It's put back when the run ends, even after an error or Ctrl+C, and by the next run if this one was killed.
  function patchFile (relativePath, change) {
    const file = path.join(root, relativePath)
    const original = fs.readFileSync(file, 'utf8')
    const changed = change(original)
    if (changed === original) {
      throw new Error('patchFile: nothing changed in ' + relativePath + ' (has the code moved?)')
    }
    fs.mkdirSync(PATCHED, { recursive: true })
    const backup = path.join(PATCHED, encodeURIComponent(relativePath))
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, original)
    }
    fs.writeFileSync(file, changed)
  }

  // For suites that record what they observe instead of checking it (the userscript suites): compares the observations with
  // <name>.expected.json, the results of a run that was checked by hand, and adds one check per top-level entry. Paths that
  // match an `ignore` pattern (timings, ids, dates) aren't compared. With MIN_TEST_UPDATE_EXPECTED=1 (or no expected file
  // yet) the observations become the new expected results: review the file's diff before committing it.
  function compareToExpected (observed, ignore = []) {
    const expectedFile = path.join(__dirname, name + '.expected.json')
    const normalized = normalizeObserved(observed)
    if (process.env.MIN_TEST_UPDATE_EXPECTED === '1' || !fs.existsSync(expectedFile)) {
      fs.writeFileSync(expectedFile, JSON.stringify(normalized, null, 2) + '\n')
      check('expected results written to ' + path.basename(expectedFile) + ' (review them)', true)
      return
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'))
    const differences = {}
    const walk = (x, y, at) => {
      if (ignore.some(pattern => pattern.test(at))) {
        return
      }
      if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y) || (x === null) !== (y === null)) {
        differences[at] = [x, y]
      } else if (x && typeof x === 'object') {
        for (const k of new Set(Object.keys(x).concat(Object.keys(y)))) {
          walk(x[k], y[k], at + '.' + k)
        }
      } else if (x !== y) {
        differences[at] = [x, y]
      }
    }
    for (const k of new Set(Object.keys(expected).concat(Object.keys(normalized)))) {
      const before = Object.keys(differences).length
      walk(expected[k], normalized[k], '.' + k)
      const found = Object.keys(differences).slice(before)
      check(k + ' as expected', found.length === 0, found.length ? found.slice(0, 8).map(at => at + ': expected ' + JSON.stringify(differences[at][0]) + ', got ' + JSON.stringify(differences[at][1])) : undefined)
    }
  }

  // Min's browser UI and its extension toolbar
  const ui = () => target(t => t.url.startsWith('min://app/index.html'))
  const toolbar = u => u.evaluate(`(() => { const c = document.getElementById('extension-actions'); return { hidden: c.hidden, buttons: Array.from(c.querySelectorAll('button')).map(b => ({ id: b.dataset.extensionId, title: b.title, icon: (b.querySelector('img') || {}).src ? b.querySelector('img').src.slice(0, 22) : '', badge: b.querySelector('.extension-action-badge') ? b.querySelector('.extension-action-badge').textContent : '', badgeColor: b.querySelector('.extension-action-badge') ? getComputedStyle(b.querySelector('.extension-action-badge')).backgroundColor : '' })) } })()`)
  const buttonRect = (u, id) => u.evaluate(`(() => { const r = document.querySelector('#extension-actions [data-extension-id="${id}"]').getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom } })()`)
  const popupWindow = main => main.evaluate(`(() => { const electron = process.mainModule.require('electron'); const popup = electron.BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('/popup.html')); const win = electron.BaseWindow.getAllWindows().find(w => !(w instanceof electron.BrowserWindow) && !w.isDestroyed()); return popup ? { popup: popup.getBounds(), win: win.getBounds(), content: win.getContentBounds(), visible: popup.isVisible() } : null })()`)
  const lastMenu = main => main.evaluate('__menus.length ? __menuLabels(__menus[__menus.length - 1].menu) : null')
  const key = (main, keyCode, modifiers) => main.evaluate(`(() => { const wc = __tab(); wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); wc.sendInputEvent({ type: 'keyUp', keyCode: ${JSON.stringify(keyCode)}, modifiers: ${JSON.stringify(modifiers)} }); return 1 })()`)
  // A screenshot of a CDP target (a page, the UI, a popup) into the results folder. The tab's page is a separate view drawn
  // over the UI, so a screenshot of the UI shows the toolbar but not the page.
  async function screenshot (connection, file) {
    const shot = await connection.send('Page.captureScreenshot', { format: 'png' })
    if (shot.result && shot.result.data) {
      fs.writeFileSync(output(file), Buffer.from(shot.result.data, 'base64'))
      return output(file)
    }
    return null
  }

  return {
    root,
    packaged,
    profileDir,
    runDir,
    CDP_PORT,
    INSPECT_PORT,
    PORT,
    PAGE,
    results,
    sleep,
    check,
    finish,
    connect,
    list,
    waitFor,
    target,
    launch,
    quit,
    child: () => child,
    isFinished: () => finished,
    // what Min printed (stdout and stderr, the last 500 KB); also saved as results/<name>.log
    childLog: () => childLog,
    crx: crxPath,
    extension,
    patchFile,
    compareToExpected,
    output,
    isScreenLocked,
    ui,
    toolbar,
    buttonRect,
    popupWindow,
    lastMenu,
    key,
    screenshot,
    readSettings: () => { try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf-8')) } catch (e) { return {} } },
    // only while Min is closed: Min keeps its settings in memory and writes them back
    writeSettings: values => fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify(values))
  }
}

// for standalone measurement scripts (measure-ad-blockers-run.js) that manage their own profiles
module.exports.CACHE = CACHE
module.exports.crxPath = crxPath
module.exports.downloadExtensions = downloadExtensions
module.exports.normalizeObserved = normalizeObserved
