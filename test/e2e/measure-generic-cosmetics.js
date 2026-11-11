// What Min's generic hiding rules cost (AGENTS.md section 10.2, "Generic hiding rules"): pages report their classes, ids
// and links (js/preload/default.js), main looks up the matching rules (main/filtering.js, cosmetic-filters-dom).
// One run, in a profile of its own, in one of three modes:
//   on    the setting hideAdSpacesWhileLoading on: a shown page is watched from its first bytes on;
//   late  Min's default: the watcher starts once the page is parsed (DOMContentLoaded), as Ghostery's and uBO Lite's do;
//   off   no generic rules (MIN_GENERIC_COSMETICS=0, read by main at start).
// What it does:
//   - seven sites, each opened in the shown tab, scrolled five times (pages load more as you scroll), then 10 s more;
//   - then a minute with the last tab shown and the others in the background, then a minute minimized;
//   - processor time of all of Min per phase (seconds, % of one core, % of all cores) and private memory at its end; the
//     reports pages sent and main's time answering them (from main);
//   - per site: when the page was first drawn and when its first report came (until then a box only these rules hide is
//     on screen), and the watcher's own time in the page (dist/preload.js patched to time it).
// usage: node test/e2e/measure-generic-cosmetics.js <on|late|off> [label]      results: results/measure-generic-cosmetics-<mode>[-label].json
// Run each mode at least twice, alternating (on, late, on, late): the sites change from minute to minute. MIN_TEST_OLD
// switches other changes of this branch back for the run (old-behaviour.js), for example MIN_TEST_OLD=domainWithoutWWW.
const mode = process.argv[2]
if (!['on', 'late', 'off'].includes(mode)) {
  console.error('usage: node test/e2e/measure-generic-cosmetics.js <on|late|off> [label]')
  process.exit(2)
}
if (mode === 'off') process.env.MIN_GENERIC_COSMETICS = '0'
const label = process.argv[3] ? '-' + process.argv[3].replace(/[^a-z0-9-]/gi, '') : ''
const t = require('./harness')({ name: 'measure-generic-cosmetics-' + mode + label, minutes: 15, settings: { hideAdSpacesWhileLoading: mode === 'on' } })
const { PAGE, sleep, check, finish, connect, list, waitFor, launch, quit, ui } = t
const old = require('./old-behaviour')(t)

// the watcher's time in each page (its scans and its mutation callbacks, nested calls counted once) and when it sent its
// first report, read through a DOM event: the watcher runs in the preload's isolated world
const TIMER = `  var watching = false
  ;(function () {
    var W = { ms: 0, calls: 0, mutations: 0 }
    var depth = 0
    var timed = function (fn) {
      return function () {
        if (depth++) { try { return fn.apply(this, arguments) } finally { depth-- } }
        var start = performance.now()
        try { return fn.apply(this, arguments) } finally { depth--; W.ms += performance.now() - start; W.calls++ }
      }
    }
    monitor.handleUpdatedNodes = timed(monitor.handleUpdatedNodes)
    var report = monitor.cb
    monitor.cb = function (update) {
      if (update.type === 'features' && W.firstReportMs === undefined) W.firstReportMs = performance.now()
      return report(update)
    }
    var NativeObserver = window.MutationObserver
    window.MutationObserver = function (cb) { return new NativeObserver(timed(function (m, o) { W.mutations += m.length; return cb(m, o) })) }
    document.addEventListener('min-watcher-report', function () { document.documentElement.setAttribute('data-min-watcher', JSON.stringify(W)) })
  })()
`
t.patchFile('dist/preload.js', function (text) {
  const replace = (s, from, to) => {
    if (!s.includes(from)) throw new Error('dist/preload.js: "' + from.trim() + '" not found (has the code moved?)')
    return s.replace(from, to)
  }
  return replace(text.replace(/\r\n/g, '\n'), '  var watching = false\n', TIMER)
})
const WATCHER = "(() => { document.dispatchEvent(new Event('min-watcher-report')); const w = document.documentElement.getAttribute('data-min-watcher'); return w ? JSON.parse(w) : null })()"
const SITES = [
  'https://edition.cnn.com/',
  'https://www.hindustantimes.com/',
  'https://timesofindia.indiatimes.com/',
  'https://www.ndtv.com/',
  'https://www.allrecipes.com/',
  'https://www.youtube.com/',
  'https://en.wikipedia.org/wiki/Web_browser'
]
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
// processor seconds so far, all of Min, and the main process alone
const CPU = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const sum = l => l.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0); return { all: sum(m), main: sum(m.filter(x => x.type === 'Browser')) } })()"
// private memory and working set (what Task Manager shows) in MB, all of Min and by kind (Electron's types: renderers are 'Tab', the UI's included)
const MEMORY = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const mb = l => Math.round(l.reduce((a, x) => a + (x.memory.privateBytes || 0), 0) / 1024); const ws = l => Math.round(l.reduce((a, x) => a + (x.memory.workingSetSize || 0), 0) / 1024); return { allMB: mb(m), renderersMB: mb(m.filter(x => x.type === 'Tab')), gpuMB: mb(m.filter(x => x.type === 'GPU')), mainMB: mb(m.filter(x => x.type === 'Browser')), workingSetMB: ws(m), renderersWorkingSetMB: ws(m.filter(x => x.type === 'Tab')), processes: m.length } })()"
const CORES = require('os').cpus().length
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d

;(async () => {
  try {
    // Chromium counts a covered window's pages, and every page while the display is off (an idle computer), as hidden, and
    // hidden pages aren't watched: its occlusion check is off, so the runs don't depend on the screen. Minimized still hides.
    const main = await launch(PAGE, { args: ['--disable-features=CalculateNativeWinOcclusion'] })
    const u = await ui()
    await sleep(2000)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    // count the pages' reports and main's time answering them
    await main.evaluate(`(() => { const ipc = process.mainModule.require('electron').ipcMain; global.__domReports = { count: 0, ms: 0, classes: 0, ids: 0, hrefs: 0 }
      for (const fn of ipc.listeners('cosmetic-filters-dom')) { ipc.removeListener('cosmetic-filters-dom', fn)
        ipc.on('cosmetic-filters-dom', function (event, url, found) { const start = process.hrtime.bigint(); fn(event, url, found); const r = __domReports; r.count++; r.ms += Number(process.hrtime.bigint() - start) / 1e6; r.classes += (found && found.classes || []).length; r.ids += (found && found.ids || []).length; r.hrefs += (found && found.hrefs || []).length; global.__domReportTimes.push({ url, at: Date.now() }) }) }
      global.__domReportTimes = []
      return 1 })()`)
    // when each page was first drawn, and when its generic rules came: until then a box only they hide is on screen
    const PAGE_TIMES = "(() => { const p = n => { const e = performance.getEntriesByName(n)[0]; return e ? e.startTime : null }; const nav = performance.getEntriesByType('navigation')[0]; return { url: location.href, origin: performance.timeOrigin, firstPaint: p('first-contentful-paint'), domContentLoaded: nav ? nav.domContentLoadedEventStart : null } })()"
    const pageTimes = []
    check('screen unlocked (info)', true, { screenLocked: t.isScreenLocked(), mode })

    // per phase: processor seconds, as a share of one core and of the whole processor (all logical cores), and private
    // memory at its end
    const phase = async (fn) => {
      const a = await main.evaluate(CPU)
      const start = Date.now()
      await fn()
      const b = await main.evaluate(CPU)
      const wall = (Date.now() - start) / 1000
      const all = b.all - a.all
      return { allSeconds: round(all), mainSeconds: round(b.main - a.main, 2), wallSeconds: round(wall), percentOfOneCore: round(all / wall * 100), percentOfAllCores: round(all / wall / CORES * 100, 2), memoryAtEnd: await main.evaluate(MEMORY) }
    }
    const loading = await phase(async () => {
      for (const site of SITES) {
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(site)} }); 1`)
        const target = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url.startsWith(site.split('/').slice(0, 3).join('/'))), 20000)
        if (!target) continue
        const c = connect(target.webSocketDebuggerUrl)
        await waitFor(async () => (await c.evaluate('document.readyState')) === 'complete', 30000)
        for (let i = 0; i < 5; i++) {
          await c.evaluate('window.scrollBy(0, Math.round(window.innerHeight * 0.9)); 1')
          await sleep(1000)
        }
        await sleep(10000)
        // read at the end: a new tab's first document is a blank page, and its timings are final by now
        const times = await c.evaluate(PAGE_TIMES)
        if (times && typeof times === 'object') times.watcher = await c.evaluate(WATCHER)
        pageTimes.push(times)
        c.close()
      }
    })
    const reportsAfterLoading = await main.evaluate('global.__domReports')
    const reportTimes = await main.evaluate('global.__domReportTimes')
    // per site, in ms from the page's start: first drawn, parsed, its first report as the page recorded it (its generic
    // rules follow within milliseconds), and the first that reached main from that host since the page's start (until
    // 2026-11-10 the only one; it can be the last report of a page the site replaced, as YouTube's seemed to be)
    const genericRulesTiming = pageTimes.filter(p => p && p.url).map(function (p) {
      const host = new URL(p.url).host
      const first = reportTimes.filter(r => { try { return new URL(r.url).host === host && r.at >= p.origin } catch (e) { return false } }).sort((a, b) => a.at - b.at)[0]
      const firstReportAtMain = first ? Math.round(first.at - p.origin) : null
      const w = p.watcher && typeof p.watcher === 'object' ? p.watcher : null
      const firstReport = w && typeof w.firstReportMs === 'number' ? Math.round(w.firstReportMs) : null
      return { host, firstPaint: p.firstPaint === null ? null : Math.round(p.firstPaint), domContentLoaded: p.domContentLoaded === null ? null : Math.round(p.domContentLoaded), firstReport, firstReportAtMain, shownBeforeGenericRules: firstReport !== null && p.firstPaint !== null ? Math.max(0, firstReport - Math.round(p.firstPaint)) : null, watcherMs: w ? round(w.ms) : null, watcherCalls: w ? w.calls : null, mutations: w ? w.mutations : null }
    })
    const watcherMsAllSites = round(genericRulesTiming.reduce((a, s) => a + (s.watcherMs || 0), 0))
    const idleShown = await phase(() => sleep(60000))
    const reportsAfterIdle = await main.evaluate('global.__domReports')
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(false); win.minimize(); return 1 })()`)
    const idleMinimized = await phase(() => sleep(60000))
    const reportsAtEnd = await main.evaluate('global.__domReports')

    const result = {
      mode,
      old,
      loadingSevenSites: loading,
      idleOneMinuteShown: idleShown,
      idleOneMinuteMinimized: idleMinimized,
      genericRulesTiming,
      watcherMsAllSites,
      reports: {
        whileLoading: reportsAfterLoading,
        duringIdleShown: { count: reportsAfterIdle.count - reportsAfterLoading.count, ms: round(reportsAfterIdle.ms - reportsAfterLoading.ms, 2) },
        whileMinimized: { count: reportsAtEnd.count - reportsAfterIdle.count, ms: round(reportsAtEnd.ms - reportsAfterIdle.ms, 2) }
      }
    }
    result.reports.whileLoading.ms = round(result.reports.whileLoading.ms, 2)
    console.log('RESULT ' + JSON.stringify(result))
    check('processor time and reports (info)', true, result)
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
