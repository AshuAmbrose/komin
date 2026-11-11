// What counting a minimized window as not in use saves when Windows leaves focus on it (main/main.js trimMemoryIfInactive,
// main/viewManager.js getTabProcessGroups; AGENTS.md section 10.4, since 2026-11-09). Windows does that when nothing else
// takes focus (a locked screen, no other window); here it's emulated, so every run sees it: BaseWindow.getFocusedWindow()
// answers Min's window while it's minimized.
//   - four tabs, each a big page (about 20,000 elements, from a local server, four host names so four processes), the last
//     one shown; test extension extensions/tabs installed (idle extensions are trimmed while Min isn't in use);
//   - the setting "trim background tabs while you use Min" off, where the difference shows in a development build. With it
//     on (the default) background tabs are trimmed either way; the whole-app trim, which this change also affects, works
//     only in the packaged app (whole-app-trim). The shown tab is never trimmed;
//   - working set (what Task Manager shows) and private memory before minimizing and after 80 s minimized: all of Min, the
//     tabs' renderers, the other renderers (the extension, the history service); processor time while minimized.
// Modes:
//   new  as Min is;
//   old  a minimized but focused window counts as in use (MIN_TEST_OLD=minimizedFocusedInUse), as on master.
// usage: node test/e2e/measure-minimized-focus.js <new|old> [label]    results: results/measure-minimized-focus-<mode>[-label].json
const http = require('http')
const mode = process.argv[2]
if (!['new', 'old'].includes(mode)) {
  console.error('usage: node test/e2e/measure-minimized-focus.js <new|old> [label]')
  process.exit(2)
}
if (mode === 'old') process.env.MIN_TEST_OLD = [process.env.MIN_TEST_OLD, 'minimizedFocusedInUse'].filter(Boolean).join(',')
const label = process.argv[3] ? '-' + process.argv[3].replace(/[^a-z0-9-]/gi, '') : ''
const t = require('./harness')({ name: 'measure-minimized-focus-' + mode + label, minutes: 8, settings: { trimBackgroundTabs: false } })
const { PAGE, sleep, check, finish, target, waitFor, launch, quit, ui, list } = t
const old = require('./old-behaviour')(t)
const TABS = t.extension('tabs')

const PORT = 8785
const BIG = '<!doctype html><title>big page</title><body>' + Array.from({ length: 2000 }, (_, i) =>
  `<div class="c${i % 300}" id="d${i}"><h3>Item ${i}</h3><p>Some text <span class="s${i % 50}">more</span> <a href="/x/${i}">a link</a></p><ul><li>one</li><li>two</li><li>three</li></ul></div>`).join('\n') + '</body>'
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(BIG)
}).listen(PORT, '127.0.0.1')
const URLS = [1, 2, 3, 4].map(n => `http://big${n}.test:${PORT}/`)

const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const CPU = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); return m.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0) })()"
// memory by group: the test pages' renderers, the UI's, the other renderers (extension, history service), all of Min
const MEMORY = `(() => { const e = process.mainModule.require('electron'); const m = e.app.getAppMetrics()
  const all = e.webContents.getAllWebContents().filter(w => !w.isDestroyed())
  const tabPids = new Set(all.filter(w => /^http:\\/\\/big\\d\\.test/.test(w.getURL())).map(w => w.getOSProcessId()))
  const uiPids = new Set(all.filter(w => w.getURL().startsWith('min://app/index.html')).map(w => w.getOSProcessId()))
  const sum = (l, k) => Math.round(l.reduce((a, x) => a + (x.memory[k] || 0), 0) / 1024)
  const group = l => ({ workingSetMB: sum(l, 'workingSetSize'), privateMB: sum(l, 'privateBytes'), processes: l.length })
  return { all: group(m), tabs: group(m.filter(x => tabPids.has(x.pid))), ui: group(m.filter(x => uiPids.has(x.pid))), otherRenderers: group(m.filter(x => x.type === 'Tab' && !tabPids.has(x.pid) && !uiPids.has(x.pid))) } })()`
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d

;(async () => {
  try {
    const main = await launch(PAGE, { args: ['--host-resolver-rules=MAP *.test 127.0.0.1', '--disable-features=CalculateNativeWinOcclusion'] })
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(TABS)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    check('test extension loaded', /^[a-p]{32}$/.test(id), id)
    s.close()
    await u.evaluate("ipc.emit('extensions-close-tab', {}, tabs.get().find(t => t.url.startsWith('min://app/pages/settings/')).id); 1")
    for (const url of URLS) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
      await waitFor(async () => (await list()).find(x => x.type === 'page' && x.url === url), 15000)
      await sleep(1500)
    }
    // past the 30 s a tab stays protected after it was last shown (viewManager.js INACTIVE_TAB_TRIM_DELAY)
    await sleep(35000)
    const before = await main.evaluate(MEMORY)

    // Windows leaves focus on the minimized window (emulated)
    await main.evaluate(`(() => { const e = process.mainModule.require('electron'); const win = ${WIN}; const original = e.BaseWindow.getFocusedWindow
      e.BaseWindow.getFocusedWindow = function () { return !win.isDestroyed() && win.isMinimized() ? win : original.call(e.BaseWindow) }
      win.minimize(); return 1 })()`)
    const cpuStart = await main.evaluate(CPU)
    await sleep(80000)
    const cpuEnd = await main.evaluate(CPU)
    const after = await main.evaluate(MEMORY)
    const state = await main.evaluate(`(() => { const e = process.mainModule.require('electron'); const win = ${WIN}; return { minimized: win.isMinimized(), focusedAsMinSees: e.BaseWindow.getFocusedWindow() === win } })()`)
    const result = { mode, old, state, beforeMinimizing: before, after80sMinimized: after, processorWhileMinimized: { seconds: round(cpuEnd - cpuStart, 2), percentOfOneCore: round((cpuEnd - cpuStart) / 80 * 100) } }
    console.log('RESULT ' + JSON.stringify(result))
    check('minimized, and Min sees its window as focused (emulated)', state.minimized && state.focusedAsMinSees, state)
    check('memory and processor time (info)', true, result)
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
