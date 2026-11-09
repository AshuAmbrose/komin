// Freezing background tabs (Page.setWebLifecycleState through webContents.debugger): does it work in Electron 45, what does it
// save in CPU, and does trimmed memory stay out? Background tabs: a busy test page (timers, animation, a worker), YouTube, a
// news site, Wikipedia. Three 60 s periods per tab: hidden (Chromium's throttling only), frozen, resumed but still hidden.
// Each period starts with a trim; CPU time and how much memory came back are read at its end.
const path = require('path')
const http = require('http')
const t = require('./harness')({ name: 'measure-freeze', minutes: 8 })
const { root, PAGE, sleep, check, finish, target, launch, quit, ui } = t
const { execFileSync } = require('child_process')
const TRIM = path.join(root, 'ext/windows/trimMemory.exe')
const BUSY_PORT = 8783
const busyServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>busy page</title><canvas id="c" width="300" height="150"></canvas><script>
    window.ticks = 0
    window.startedAt = Date.now()
    setInterval(() => { window.ticks++; let x = 0; for (let i = 0; i < 200000; i++) x += Math.sqrt(i); window.last = x }, 100)
    const ctx = document.getElementById('c').getContext('2d')
    const draw = () => { ctx.fillStyle = 'hsl(' + (Date.now() % 360) + ', 60%, 50%)'; ctx.fillRect(0, 0, 300, 150); requestAnimationFrame(draw) }
    draw()
    const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => { let x = 0; for (let i = 0; i < 300000; i++) x += i; postMessage(x) }, 200)'])))
    window.workerMessages = 0
    worker.onmessage = () => window.workerMessages++
  </script>`)
}).listen(BUSY_PORT, '127.0.0.1')
const BUSY = `http://127.0.0.1:${BUSY_PORT}/busy`
const TABS = [BUSY, 'https://www.youtube.com/', 'https://timesofindia.indiatimes.com/', 'https://en.wikipedia.org/wiki/Web_browser']
const WC = url => `process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(url)}))`
const metric = (main, url) => main.evaluate(`(() => { const wc = ${WC(url)}; if (!wc) return null; const pid = wc.getOSProcessId(); const m = process.mainModule.require('electron').app.getAppMetrics().find(x => x.pid === pid); return { pid, cpuSeconds: m.cpu.cumulativeCPUUsage, workingSetMB: Math.round(m.memory.workingSetSize / 1024 * 10) / 10 } })()`)
const setState = (main, url, state) => main.evaluate(`(async () => { const wc = ${WC(url)}; if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: ${JSON.stringify(state)} }); return 'ok' })().catch(e => 'ERROR ' + e.message)`)
async function period (main, label, action) {
  const results = {}
  for (const url of TABS) {
    if (action) results[url] = { command: await action(url) }
    const m = await metric(main, url)
    execFileSync(TRIM, ['--memory-priority', 'low', String(m.pid)])
  }
  await sleep(2000)
  const start = {}
  for (const url of TABS) start[url] = await metric(main, url)
  await sleep(60000)
  for (const url of TABS) {
    const end = await metric(main, url)
    results[url] = Object.assign(results[url] || {}, { cpuSeconds: Math.round((end.cpuSeconds - start[url].cpuSeconds) * 1000) / 1000, memoryBackMB: Math.round((end.workingSetMB - start[url].workingSetMB) * 10) / 10 })
  }
  console.log('PERIOD ' + label + ' ' + JSON.stringify(results))
  return results
}
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    for (const url of TABS) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
      await sleep(6000)
    }
    await u.evaluate("ipc.emit('extensions-select-tab', {}, tabs.get()[0].id); 1")
    await sleep(30000)
    const busy = await target(t => t.url === BUSY && t.type === 'page')
    await period(main, 'hidden', null)
    const beforeFreeze = await busy.evaluate('({ ticks, workerMessages })')
    await period(main, 'frozen', url => setState(main, url, 'frozen'))
    const whileFrozen = await busy.evaluate('({ ticks, workerMessages })').catch(e => 'no answer: ' + e.message)
    await period(main, 'resumed-hidden', url => setState(main, url, 'active'))
    const afterResume = await busy.evaluate('({ ticks, workerMessages, alive: typeof window.last === "number" })')
    console.log('BUSY PAGE counters: before freezing ' + JSON.stringify(beforeFreeze) + ', end of frozen period ' + JSON.stringify(whileFrozen) + ', end of resumed period ' + JSON.stringify(afterResume))

    // a frozen tab, selected: does it come back with its state?
    await setState(main, BUSY, 'frozen')
    await sleep(2000)
    const frozenTicks = await busy.evaluate('ticks').catch(() => 'no answer')
    const busyTab = await u.evaluate(`tabs.get().find(t => t.url === ${JSON.stringify(BUSY)}).id`)
    await setState(main, BUSY, 'active')
    await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(busyTab)}); 1`)
    await sleep(3000)
    console.log('SELECTED after freezing: ' + JSON.stringify({ frozenTicks, ticksNow: await busy.evaluate('ticks'), sameStart: await busy.evaluate('window.startedAt') }))
    u.close()
    await quit(main)
    busyServer.close()
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    busyServer.close()
    finish()
  }
})()
