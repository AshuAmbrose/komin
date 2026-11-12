// One run of the ad blocker side-by-side (measure-ad-blockers.js runs them all), in a brand-new profile of its own.
// usage: node test/e2e/measure-ad-blockers-run.js <none|min|ubol> <run> <out.json> [restart]
//   restart: start again in the profile a previous run with the same <config> and <run> set up (what a later start costs)
//   none = no blocking, min = Min's built-in blocker, ubol = uBlock Origin Lite. Full uBlock Origin (Manifest V2) was a
//   fourth setup until Min stopped loading Manifest V2 extensions (its results are in AGENTS.md section 10.2)
// Measures: startup, idle cost, five ad-heavy sites (requests, what was blocked, ad/tracker requests that got through,
// bytes, load times, visible ad slots, page errors), memory by process kind, CPU, three YouTube videos (ads, playback),
// and adblock-tester.com's score. Stops itself: main-process errors, a watchdog and a time limit.
const { spawn, execSync } = require('child_process')
const os = require('os')
const harness = require('./harness')
const http = require('http')
const path = require('path')
const fs = require('fs')
const [config, runId, outFile, mode] = process.argv.slice(2)
const RESTART = mode === 'restart'
if (!['none', 'min', 'ubol'].includes(config) || !runId || !outFile) {
  console.error('usage: node test/e2e/measure-ad-blockers-run.js <none|min|ubol> <run> <out.json> [restart]')
  process.exit(2)
}
const root = path.resolve(__dirname, '..', '..')
// profiles live until measure-ad-blockers.js deletes them (a restart run reuses one)
const PROFILE = path.join(os.tmpdir(), 'min-e2e-blockers', config + '-' + runId)
const USERDATA = PROFILE + '-development'
const UBOL_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const UBOL_CRX = harness.crxPath(UBOL_ID)
// Min's blocker gets the cached engine, so every run blocks the same from the first page (a first start would download it,
// about 2 s, and with today's lists)
const ENGINE = [path.join(harness.CACHE, 'adblocker-engine-v2.bin'), path.join(process.env.APPDATA || '', 'Min-development', 'adblocker-engine-v2.bin')].find(f => fs.existsSync(f))
async function prepareDownloads () {
  if (config === 'ubol') await harness.downloadExtensions([UBOL_ID])
}
const SITES = [
  'https://timesofindia.indiatimes.com/',
  'https://www.hindustantimes.com/',
  'https://www.ndtv.com/',
  'https://edition.cnn.com/',
  'https://www.allrecipes.com/'
]
const VIDEOS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
  'https://www.youtube.com/watch?v=JGwWNGJdvx8'
]
const TESTER = 'https://adblock-tester.com/'
const AD_HOSTS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
  'googletagservices.com', 'adservice.google', 'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com',
  'outbrain.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'scorecardresearch.com', 'quantserve.com',
  'quantcount.com', 'facebook.net', 'moatads.com', 'chartbeat.com', 'chartbeat.net', 'hotjar.com', 'yieldmo.com', 'teads.tv',
  'sharethrough.com', '33across.com', 'smartadserver.com', 'adsrvr.org', 'bidswitch.net', 'indexww.com', 'media.net',
  'lijit.com', 'sovrn.com', 'gumgum.com', 'id5-sync.com', 'demdex.net', 'everesttech.net', 'krxd.net', 'bluekai.com',
  'crwdcntrl.net', 'mathtag.com', 'rlcdn.com', 'agkn.com', 'tapad.com', 'liadm.com', 'adsafeprotected.com', 'doubleverify.com',
  'imasdk.googleapis.com', 'flashtalking.com', 'serving-sys.com', 'zemanta.com', 'yahoo.com/beacon', 'clarity.ms',
  'newrelic.com', 'nr-data.net', 'permutive.com', 'permutive.app', 'brandmetrics.com', 'onetag-sys.com', 'adform.net',
  ' 3lift.com', '3lift.com', 'triplelift.com', 'colombiaonline.com', 'colombia.com', 'izooto.com', 'vdo.ai', 'jsdelivr.net/npm/prebid',
  'prebid', 'ads.pubmatic', 'adsystem', '/ads/', 'adsense', 'adtrafficquality.google', 'fundingchoicesmessages.google.com',
  'cdn.cookielaw.org', 'onetrust.com', 'segment.io', 'segment.com', 'mixpanel.com', 'branch.io', 'tiktok.com/i18n/pixel',
  'analytics.tiktok.com', 'snap.licdn.com', 'ads.linkedin.com', 'bat.bing.com', 'pinimg.com/ct', 'ct.pinterest.com',
  'cxense.com', 'parsely.com', 'parse.ly', 'comscore.com', 'nielsen', 'imrworldwide.com', 'dotomi.com', 'ml314.com',
  'adlightning.com', 'confiant-integrations.net', 'cdn.confiant', 'browsiprod.com', 'browsi.com', 'kargo.com', 'sonobi.com',
  'adthrive.com', 'mediavine.com', 'ezoic.net', 'zergnet.com', 'mgid.com', 'revcontent.com', 'pub.network', 'yieldlove',
  'connatix.com', 'jwpltx.com', 'aniview.com', 'spotxchange.com', 'springserve.com', 'adition.com', 'yandex.ru/metrika', 'mc.yandex']
const AD_SELECTOR = '[id^="div-gpt-ad"], [id*="google_ads_iframe"], ins.adsbygoogle, .adsbygoogle, iframe[src*="doubleclick.net"], iframe[src*="googlesyndication"], iframe[id^="google_ads_iframe"], iframe[name^="google_ads_iframe"], [id^="taboola-"], .trc_related_container, .OUTBRAIN, [data-google-query-id], [class*="ad-slot"], [class*="adSlot"], [class*="ad-container"], [class*="adContainer"], [id*="ad-slot"], [id*="adSlot"], amp-ad, [data-ad-slot], [data-ad-unit], [class*="advertisement"], [id*="advertisement"]'
const PORT = 8790
const BLANK = n => `http://127.0.0.1:${PORT}/blank${n}`
const TIME_LIMIT = 25 * 60 * 1000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const result = { config, run: runId, startedAt: new Date().toISOString(), notes: [] }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>blank</title><body></body>')
}).listen(PORT, '127.0.0.1')

let child = null
let finished = false
function finish (stopReason) {
  if (finished) return
  finished = true
  if (stopReason) result.stoppedEarly = stopReason
  if (child && child.exitCode === null) child.kill()
  server.close()
  result.finishedAt = new Date().toISOString()
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
  console.log(stopReason ? 'STOPPED ' + stopReason : 'DONE ' + config + ' ' + runId)
  setTimeout(() => process.exit(stopReason ? 1 : 0), 500)
}
setTimeout(() => finish('time limit'), TIME_LIMIT)
process.on('unhandledRejection', e => finish('script error: ' + String(e && (e.stack || e.message) || e).slice(0, 400)))

// CDP connection; flattened child sessions (cross-site frames) share the socket and carry a sessionId
function connect (wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const listeners = []
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } else if (d.method) listeners.forEach(fn => fn(d))
  }
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ready.catch(() => {})
  const send = async (method, params = {}, sessionId) => {
    await ready
    const i = ++id
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
    return Promise.race([new Promise(resolve => pending.set(i, resolve)), sleep(30000).then(() => ({ timeout: true }))])
  }
  return {
    send,
    on: fn => listeners.push(fn),
    evaluate: async (expression, sessionId) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.timeout) return 'TIMEOUT'
      if (r.error) return 'ERR ' + JSON.stringify(r.error)
      return r.result.exceptionDetails ? 'EXC ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300) : r.result.result.value
    },
    close: () => { try { ws.close() } catch (e) {} }
  }
}
async function list (port) { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() } catch (e) { return [] } }
async function waitFor (fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch (e) {} await sleep(250) } return null }
async function target (predicate, ms) { const t = await waitFor(async () => (await list(9333)).find(predicate), ms); return t ? connect(t.webSocketDebuggerUrl) : null }

let watched = null
setInterval(async () => {
  if (!watched || finished) return
  const { main, child: current } = watched
  if (current.exitCode !== null && !current.quitting) return finish('Min exited unexpectedly (code ' + current.exitCode + ')')
  const errors = await Promise.race([main.evaluate('global.__mainErrors || []'), sleep(10000).then(() => 'NO ANSWER')])
  if (!watched || watched.main !== main || current.quitting) return
  if (errors === 'NO ANSWER' || errors === 'TIMEOUT') return finish('the main process stopped answering')
  if (Array.isArray(errors) && errors.length > 0) return finish('main-process error: ' + errors[0].slice(0, 600))
}, 3000)

async function launch (url) {
  const t0 = Date.now()
  child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['--inspect=9339', '--remote-debugging-port=9333', '--user-data-dir=' + PROFILE, '.', '--development-mode', url], { cwd: root, stdio: 'ignore' })
  child.exited = new Promise(resolve => child.on('exit', resolve))
  const inspector = await waitFor(async () => (await list(9339))[0], 20000)
  if (!inspector) { finish('Min didn\'t start'); return null }
  const main = connect(inspector.webSocketDebuggerUrl)
  // errors recorded instead of shown in a dialog; dialogs answered; every page muted from the start (no sound during tests)
  await main.evaluate(`(() => { const electron = process.mainModule.require('electron')
    global.__mainErrors = []; process.on('uncaughtException', e => global.__mainErrors.push(String(e && e.stack || e)))
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [global.__nextOpen] })
    electron.dialog.showMessageBox = async () => ({ response: 0 })
    electron.app.on('web-contents-created', (e, wc) => { try { wc.setAudioMuted(true) } catch (err) {} })
    electron.webContents.getAllWebContents().forEach(wc => { try { wc.setAudioMuted(true) } catch (err) {} })
    return 1 })()`)
  watched = { main, child }
  const u = await target(t => t.url.startsWith('min://app/index.html'), 20000)
  return { main, u, startupMs: Date.now() - t0 }
}
async function quit (main) {
  child.quitting = true
  watched = null
  await main.evaluate("process.mainModule.require('electron').app.quit(); 1")
  main.close()
  await Promise.race([child.exited, sleep(20000)])
  if (child.exitCode === null) { child.kill(); await child.exited }
}
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"

// CPU: every process's cumulative CPU seconds, sampled every 2 s, so processes that exit still count
const cpuByPid = new Map()
async function sampleCpu (main) {
  const m = await main.evaluate("process.mainModule.require('electron').app.getAppMetrics().map(x => [x.pid, x.cpu.cumulativeCPUUsage || 0])")
  if (Array.isArray(m)) m.forEach(([pid, cpu]) => cpuByPid.set(pid, Math.max(cpuByPid.get(pid) || 0, cpu)))
}
const cpuTotal = () => Array.from(cpuByPid.values()).reduce((a, b) => a + b, 0)
let sampler = null
function startSampler (main) { sampler = setInterval(() => sampleCpu(main).catch(() => {}), 2000) }

// memory by kind of process: main, UI, history service, GPU, utility (network, audio…), extensions, web pages
function extensionPids () {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'electron.exe\'\\" | Where-Object { $_.CommandLine -like \'*--extension-process*\' } | ForEach-Object { $_.ProcessId }"', { encoding: 'utf8' })
    return new Set(out.split(/\s+/).filter(Boolean).map(Number))
  } catch (e) { return new Set() }
}
async function memory (main) {
  const ext = extensionPids()
  const metrics = await main.evaluate(`(() => { const e = process.mainModule.require('electron'); const owners = {}; e.webContents.getAllWebContents().forEach(wc => { try { owners[wc.getOSProcessId()] = wc.getURL() } catch (err) {} }); return e.app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name || '', owner: owners[m.pid] || '', privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })) })()`)
  const groups = { main: 0, ui: 0, history: 0, gpu: 0, utility: 0, extensions: 0, pages: 0 }
  const counts = { main: 0, ui: 0, history: 0, gpu: 0, utility: 0, extensions: 0, pages: 0 }
  for (const m of metrics) {
    let g
    if (m.type === 'Browser') g = 'main'
    else if (m.owner.startsWith('min://app/index.html')) g = 'ui'
    else if (m.owner.includes('placesService')) g = 'history'
    else if (m.type === 'GPU') g = 'gpu'
    else if (m.type === 'Utility' || m.type === 'Zygote' || m.type === 'Sandbox helper' || m.type === 'Unknown') g = 'utility'
    else if (ext.has(m.pid) || m.owner.startsWith('chrome-extension://')) g = 'extensions'
    else g = 'pages'
    groups[g] += m.privateMB
    counts[g]++
  }
  return { totalMB: Object.values(groups).reduce((a, b) => a + b, 0), processes: metrics.length, groups, counts }
}

const hostOf = url => { try { return new URL(url).hostname } catch (e) { return '' } }
const isAdTracker = url => { const u = url.toLowerCase(); return AD_HOSTS.some(h => u.includes(h.trim())) }
const baseDomain = host => host.split('.').slice(-2).join('.')

async function loadSite (main, u, site, index) {
  const blank = BLANK(index)
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
  const t = await waitFor(async () => (await list(9333)).find(x => x.url === blank && x.type === 'page'), 15000)
  if (!t) return { site, error: 'tab not found' }
  const c = connect(t.webSocketDebuggerUrl)
  const requests = new Map()
  const stats = { requests: 0, blocked: 0, redirectedAway: 0, standInRefused: 0, failedOther: 0, finished: 0, bytes: 0, adTrackerSeen: 0, adTrackerLoaded: 0, thirdPartyLoaded: 0, exceptions: 0, frames: 0 }
  const siteBase = baseDomain(hostOf(site))
  let loaded = false
  c.on(async d => {
    const p = d.params || {}
    if (d.method === 'Target.attachedToTarget') {
      stats.frames++
      const s = p.sessionId
      await c.send('Network.enable', {}, s)
      await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s)
      await c.send('Runtime.runIfWaitingForDebugger', {}, s)
    } else if (d.method === 'Network.requestWillBeSent') {
      const key = (d.sessionId || '') + p.requestId
      if (p.redirectResponse) {
        const to = p.request.url
        if (to.startsWith('chrome-extension:') || to.startsWith('data:')) { stats.redirectedAway++; const r = requests.get(key); if (r) r.neutral = true }
      }
      if (!requests.has(key)) {
        stats.requests++
        const ad = isAdTracker(p.request.url)
        if (ad) stats.adTrackerSeen++
        requests.set(key, { url: p.request.url, ad })
      } else {
        requests.get(key).url = p.request.url
      }
    } else if (d.method === 'Network.loadingFinished') {
      const r = requests.get((d.sessionId || '') + p.requestId)
      stats.finished++
      stats.bytes += p.encodedDataLength || 0
      if (r && !r.neutral && !r.url.startsWith('chrome-extension:') && !r.url.startsWith('data:')) {
        if (r.ad) stats.adTrackerLoaded++
        if (baseDomain(hostOf(r.url)) !== siteBase) stats.thirdPartyLoaded++
      }
    } else if (d.method === 'Network.loadingFailed') {
      // a stand-in Chromium refused (Ghostery's data: redirects, section 10.2) fails like a block: counted in both
      if (/UNSAFE_REDIRECT/.test(p.errorText || '')) stats.standInRefused++
      if (/BLOCKED_BY_CLIENT|UNSAFE_REDIRECT/.test(p.errorText || '')) stats.blocked++
      else stats.failedOther++
    } else if (d.method === 'Runtime.exceptionThrown' && !d.sessionId) {
      stats.exceptions++
    } else if (d.method === 'Page.loadEventFired' && !d.sessionId) {
      loaded = true
    }
  })
  await c.send('Network.enable')
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Network.setCacheDisabled', { cacheDisabled: false })
  await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  const start = Date.now()
  await c.send('Page.navigate', { url: site })
  await waitFor(() => loaded, 35000)
  const loadWaitMs = Date.now() - start
  await sleep(15000)
  const page = await c.evaluate(`(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {}
    const visible = Array.from(document.querySelectorAll(${JSON.stringify(AD_SELECTOR)})).filter(el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 20 && r.height >= 20 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' })
    const outer = visible.filter(el => !visible.some(other => other !== el && other.contains(el)))
    return { url: location.href, title: document.title.slice(0, 60), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0), loadMs: Math.round(nav.loadEventEnd || 0), visibleAdSlots: outer.length, adAreaKpx: Math.round(outer.reduce((a, el) => { const r = el.getBoundingClientRect(); return a + r.width * r.height }, 0) / 1000), iframes: document.querySelectorAll('iframe').length }
  })()`)
  c.close()
  return Object.assign({ site, loadEventSeen: loaded, loadWaitMs }, stats, { bytes: Math.round(stats.bytes / 1024) }, typeof page === 'object' ? page : { pageError: String(page) })
}

async function watchVideo (main, u, url) {
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
  const t = await waitFor(async () => (await list(9333)).find(x => x.url.startsWith(url) && x.type === 'page'), 20000)
  if (!t) return { url, error: 'tab not found' }
  const c = connect(t.webSocketDebuggerUrl)
  const start = Date.now()
  let adSeen = false; let adSeconds = 0; let mainPlayedAtMs = null; let enforcement = false; let last = null
  while (Date.now() - start < 40000) {
    const s = await c.evaluate(`(() => { const p = document.querySelector('#movie_player'); const v = document.querySelector('video'); return { ad: !!(p && p.classList.contains('ad-showing')), time: v ? v.currentTime : -1, paused: v ? v.paused : null, enforcement: !!document.querySelector('ytd-enforcement-message-view-model, tp-yt-paper-dialog ytd-enforcement-message-view-model') } })()`)
    if (s && typeof s === 'object') {
      last = s
      if (s.ad) { adSeen = true; adSeconds += 0.5 }
      if (s.enforcement) enforcement = true
      if (!s.ad && s.time > 2 && mainPlayedAtMs === null) mainPlayedAtMs = Date.now() - start
      if (mainPlayedAtMs !== null && Date.now() - start > mainPlayedAtMs + 3000) break
    }
    await sleep(500)
  }
  c.close()
  const tabId = await u.evaluate(`(tabs.get().find(t => t.url.startsWith(${JSON.stringify(url)})) || {}).id`)
  if (tabId) await u.evaluate(`ipc.emit('extensions-close-tab', {}, ${JSON.stringify(tabId)}); 1`)
  return { url, adSeen, adSecondsApprox: adSeconds, mainVideoPlayedAfterMs: mainPlayedAtMs, antiAdblockWarning: enforcement, last }
}

async function testerScore (main, u) {
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(TESTER)} }); 1`)
  const t = await waitFor(async () => (await list(9333)).find(x => x.url.startsWith(TESTER) && x.type === 'page'), 20000)
  if (!t) return { error: 'tab not found' }
  const c = connect(t.webSocketDebuggerUrl)
  const text = await waitFor(async () => { const v = await c.evaluate("(document.querySelector('.final-score') || {}).innerText || ''"); return typeof v === 'string' && /points/.test(v) ? v : null }, 45000)
  c.close()
  const m = text && text.match(/(\d+)\s*points out of (\d+)/)
  return { score: m ? Number(m[1]) : null, outOf: m ? Number(m[2]) : null, text: text ? text.replace(/\s+/g, ' ') : null }
}

async function installExtension () {
  const r = await launch(BLANK(0))
  if (!r) return false
  const { main, u } = r
  await sleep(2000)
  await u.evaluate("ipc.emit('addTab', {}, { url: 'min://app/pages/settings/index.html' }); 1")
  const s = await target(t => t.url.startsWith('min://app/pages/settings/') && t.type === 'page', 15000)
  await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
  await main.evaluate(`global.__nextOpen = ${JSON.stringify(UBOL_CRX)}; 1`)
  const installed = await s.evaluate(`extensionPages.request('install-crx').then(r => JSON.stringify(r).slice(0, 300)).catch(e => 'ERROR ' + e.message)`)
  const listed = await s.evaluate("extensionPages.request('list').then(r => JSON.stringify((r.extensions || r).map ? (r.extensions || r).map(x => ({ name: x.name, version: x.version, enabled: x.enabled, loaded: x.loaded, filteringNetwork: x.filteringNetwork, error: x.error || null, unsupported: x.unsupported || null })) : r).slice(0, 800)).catch(e => 'ERROR ' + e.message)")
  result.install = { installed, listed }
  console.log('installed', installed.slice(0, 200))
  // first start: the blocker sets itself up (lists compiled, rulesets turned on)
  await sleep(60000)
  s.close(); u.close()
  await quit(main)
  return true
}

;(async () => {
  try {
    await prepareDownloads()
    if (!RESTART) {
    fs.rmSync(PROFILE, { recursive: true, force: true })
    fs.rmSync(USERDATA, { recursive: true, force: true })
    fs.mkdirSync(USERDATA, { recursive: true })
    const settings = { enableAutoplay: true, collectUsageStats: false, updateNotificationsEnabled: false }
    if (config === 'none') settings.filtering = { blockingLevel: 0, contentTypes: [], exceptionDomains: [] }
    fs.writeFileSync(path.join(USERDATA, 'settings.json'), JSON.stringify(settings))
    fs.writeFileSync(path.join(USERDATA, 'windowBounds.json'), JSON.stringify({ x: 40, y: 40, width: 1400, height: 900, maximized: false }))
    // an empty saved session: no first-run tour tab
    fs.writeFileSync(path.join(USERDATA, 'sessionRestore.json'), JSON.stringify({ version: 2, state: { tasks: [] } }))
    if (config !== 'none' && ENGINE) fs.copyFileSync(ENGINE, path.join(USERDATA, 'adblocker-engine-v2.bin'))
    if (config !== 'none' && !ENGINE) result.notes = (result.notes || []).concat(['no cached ad-block engine: Min started from its bundled list'])

    }
    if (!RESTART && config === 'ubol') {
      if (!(await installExtension())) return
      const saved = JSON.parse(fs.readFileSync(path.join(USERDATA, 'settings.json'), 'utf8'))
      result.extensionFilteringOn = saved.extensionsFilteringNetworkNow
    }

    const r = await launch(BLANK(0))
    if (!r) return
    const { main, u } = r
    result.startupMs = r.startupMs
    // only this Windows session's lock screen counts (AGENTS.md pitfall 45)
    result.screenLocked = harness.isScreenLocked()
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    await sampleCpu(main)
    let c0 = cpuTotal()
    startSampler(main)
    // start-up: the first 45 s (blockers load their rules), then idle with one blank tab
    await sleep(45000)
    await sampleCpu(main)
    result.startupCpuSecondsFirst45s = Math.round((cpuTotal() - c0) * 100) / 100
    result.startupMemory = await memory(main)
    c0 = cpuTotal()
    await sleep(30000)
    await sampleCpu(main)
    result.idleCpuSecondsPer30s = Math.round((cpuTotal() - c0) * 100) / 100
    result.idleMemory = await memory(main)
    if (RESTART) { clearInterval(sampler); u.close(); await quit(main); return finish() }

    c0 = cpuTotal()
    result.sites = []
    for (const [i, site] of SITES.entries()) {
      const s = await loadSite(main, u, site, i + 1)
      console.log('SITE ' + JSON.stringify(s))
      result.sites.push(s)
    }
    await sleep(20000)
    await sampleCpu(main)
    result.sitesCpuSeconds = Math.round((cpuTotal() - c0) * 100) / 100
    result.loadedMemory = await memory(main)
    c0 = cpuTotal()
    await sleep(60000)
    await sampleCpu(main)
    result.idleWithTabsCpuSecondsPer60s = Math.round((cpuTotal() - c0) * 100) / 100

    result.youtube = []
    for (const v of VIDEOS) {
      const y = await watchVideo(main, u, v)
      console.log('VIDEO ' + JSON.stringify(y))
      result.youtube.push(y)
    }
    result.tester = await testerScore(main, u)
    console.log('TESTER ' + JSON.stringify(result.tester))
    clearInterval(sampler)
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    result.notes.push('harness error: ' + String(e.stack || e).slice(0, 500))
    finish('harness error')
  }
})()
