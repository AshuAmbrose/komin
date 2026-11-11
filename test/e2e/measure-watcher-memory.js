// What the generic hiding rules cost, and starting their watcher while pages arrive (AGENTS.md section 10.2, "Generic
// rules from the page" and "When the rules arrive"), on pages that are the same every run, so the sites' own changes (ads,
// news) don't drown it. measure-generic-cosmetics.js does it on real sites, where runs differ by more than the change.
//   - seven tabs, each a generated page like a big news site's (about 10,000 elements; about 600 classes, 500 ids and 400
//     links; a few ad slots, which a generic rule hides), from a local server in ten parts 150 ms apart, as a page arrives
//     over the network; seven host names (news1.test to news7.test, --host-resolver-rules) so they're seven sites;
//   - then a minute with the last tab shown and the others in the background, then a minute minimized;
//   - per phase: Min's processor time (seconds, % of one core, % of all cores), private memory and working set (what Task
//     Manager shows) of all of Min and of its renderers, and the pages' JavaScript heap (used and allocated, once per
//     renderer process).
// Modes:
//   on    the setting hideAdSpacesWhileLoading on: a shown page is watched from its first bytes on;
//   late  Min's default: the watcher starts once the page is parsed (DOMContentLoaded), as on master;
//   off   no generic rules (MIN_GENERIC_COSMETICS=0, read by main at start), as before 2026-11-10.
// usage: node test/e2e/measure-watcher-memory.js <on|late|off> [label]      results: results/measure-watcher-memory-<mode>[-label].json
// Alternate the modes (on, late, off, on, late, off), at least three runs each. MIN_TEST_OLD switches other changes of
// this branch back for the run (old-behaviour.js), for example MIN_TEST_OLD=scriptletsAfterStart.
const http = require('http')
const mode = process.argv[2]
if (!['on', 'late', 'off'].includes(mode)) {
  console.error('usage: node test/e2e/measure-watcher-memory.js <on|late|off> [label]')
  process.exit(2)
}
if (mode === 'off') process.env.MIN_GENERIC_COSMETICS = '0'
const label = process.argv[3] ? '-' + process.argv[3].replace(/[^a-z0-9-]/gi, '') : ''
const t = require('./harness')({ name: 'measure-watcher-memory-' + mode + label, minutes: 8, settings: { hideAdSpacesWhileLoading: mode === 'on' } })
const { PAGE, sleep, check, finish, connect, list, waitFor, launch, quit, ui } = t
const old = require('./old-behaviour')(t)

// the pages: the same every run (a fixed pseudo-random sequence per site and part)
const PORT = 8784
const SITES = 7
const PARTS = 10
function random (seed) {
  return function () {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
}
function part (site, n) {
  const r = random(site * 1000 + n + 1)
  const cls = () => 'c' + Math.floor(r() * 600)
  const link = () => '/story/' + Math.floor(r() * 400)
  let html = ''
  for (let i = 0; i < 100; i++) {
    const id = i % 2 === 0 ? ` id="s${n}-${i}"` : ''
    html += `<div class="${cls()} ${cls()}"${id}><h3 class="${cls()}"><a href="${link()}" class="${cls()}">Story ${n}.${i}</a></h3>` +
      `<p class="${cls()}">Some text <span class="${cls()}">with more</span> and a <a href="${link()}">link</a>.</p>` +
      `<ul class="${cls()}"><li>one</li><li>two</li><li class="${cls()}">three</li></ul></div>\n`
    if (i % 25 === 0) html += '<div class="ad-slot" style="height: 50px">ad slot</div>\n'
  }
  return html
}
http.createServer((req, res) => {
  const site = Number((req.headers.host || '').replace(/^news(\d+)\..*$/, '$1')) || 0
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.write(`<!doctype html><html><head><title>news ${site}</title></head><body>\n`)
  let n = 0
  const next = () => {
    if (n === PARTS) return res.end('</body></html>')
    res.write(part(site, n++))
    setTimeout(next, 150)
  }
  next()
}).listen(PORT, '127.0.0.1')

const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const CPU = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const sum = l => l.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0); return { all: sum(m), main: sum(m.filter(x => x.type === 'Browser')) } })()"
const MEMORY = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const mb = l => Math.round(l.reduce((a, x) => a + (x.memory.privateBytes || 0), 0) / 1024); const ws = l => Math.round(l.reduce((a, x) => a + (x.memory.workingSetSize || 0), 0) / 1024); return { allMB: mb(m), renderersMB: mb(m.filter(x => x.type === 'Tab')), gpuMB: mb(m.filter(x => x.type === 'GPU')), mainMB: mb(m.filter(x => x.type === 'Browser')), workingSetMB: ws(m), renderersWorkingSetMB: ws(m.filter(x => x.type === 'Tab')), processes: m.length } })()"
// each test page's renderer process, so a heap shared by two pages counts once
const PIDS = "(() => process.mainModule.require('electron').webContents.getAllWebContents().filter(w => !w.isDestroyed() && /^http:\\/\\/news\\d+\\.test/.test(w.getURL())).map(w => ({ url: w.getURL(), pid: w.getOSProcessId() })))()"
const CORES = require('os').cpus().length
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d

;(async () => {
  try {
    // as in measure-generic-cosmetics.js: Chromium's occlusion check off, so the runs don't depend on the screen
    const main = await launch(PAGE, { args: ['--host-resolver-rules=MAP *.test 127.0.0.1', '--disable-features=CalculateNativeWinOcclusion'] })
    const u = await ui()
    await sleep(2000)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    check('screen unlocked (info)', true, { screenLocked: t.isScreenLocked(), mode })

    const pages = []
    const heaps = async () => {
      const pids = await main.evaluate(PIDS)
      const seen = new Set()
      let used = 0
      let total = 0
      for (const p of pages) {
        const owner = Array.isArray(pids) ? pids.find(x => x.url === p.url) : null
        if (!owner || seen.has(owner.pid)) continue
        seen.add(owner.pid)
        const h = await p.c.send('Runtime.getHeapUsage')
        if (h.result) {
          used += h.result.usedSize
          total += h.result.totalSize
        }
      }
      return { usedMB: round(used / 1048576), allocatedMB: round(total / 1048576), processes: seen.size }
    }
    const phase = async (fn) => {
      const a = await main.evaluate(CPU)
      const start = Date.now()
      await fn()
      const b = await main.evaluate(CPU)
      const wall = (Date.now() - start) / 1000
      const all = b.all - a.all
      return { allSeconds: round(all, 2), mainSeconds: round(b.main - a.main, 2), wallSeconds: round(wall), percentOfOneCore: round(all / wall * 100), percentOfAllCores: round(all / wall / CORES * 100, 2), memoryAtEnd: await main.evaluate(MEMORY), heapAtEnd: await heaps() }
    }

    const loading = await phase(async () => {
      for (let site = 1; site <= SITES; site++) {
        const blank = PAGE + '?news-' + site
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(blank)} }); 1`)
        const target = await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === blank), 15000)
        if (!target) continue
        const c = connect(target.webSocketDebuggerUrl)
        const url = `http://news${site}.test:${PORT}/`
        await c.send('Page.navigate', { url })
        await waitFor(async () => (await c.evaluate('location.href')) === url && (await c.evaluate('document.readyState')) === 'complete', 20000)
        await sleep(2000)
        const shown = await c.evaluate("(() => { const ads = [...document.querySelectorAll('.ad-slot')]; return { elements: document.querySelectorAll('*').length, adSlots: ads.length, adSlotsHidden: ads.filter(a => getComputedStyle(a).display === 'none').length } })()")
        pages.push({ url, c, shown })
      }
    })
    const idleShown = await phase(() => sleep(60000))
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(false); win.minimize(); return 1 })()`)
    const idleMinimized = await phase(() => sleep(60000))

    const result = { mode, old, pages: pages.map(p => Object.assign({ url: p.url }, p.shown)), loadingSevenPages: loading, idleOneMinuteShown: idleShown, idleOneMinuteMinimized: idleMinimized }
    console.log('RESULT ' + JSON.stringify(result))
    // with generic rules off nothing hides them
    const hiddenWanted = p => mode === 'off' ? p.shown.adSlotsHidden === 0 : p.shown.adSlotsHidden === p.shown.adSlots
    check(mode === 'off' ? 'the pages loaded, their ad slots shown' : 'the pages loaded and their ad slots were hidden', pages.length === SITES && pages.every(p => p.shown && p.shown.adSlots > 0 && hiddenWanted(p)), result.pages)
    check('processor time and memory (info)', true, result)
    pages.forEach(p => p.c.close())
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
