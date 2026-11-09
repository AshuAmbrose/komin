// What Min's own code holds: with eight tabs open, each process's private memory, a breakdown for the UI renderer and the
// main process (JS heap, Blink, external buffers), and a heap snapshot of each, summarized by heap-summary.js.
// usage: node test/e2e/measure-memory.js [label]    snapshots go to test/e2e/results/measure-memory-<label>/ (default label: before)
const path = require('path')
const fs = require('fs')
const t = require('./harness')({ name: 'measure-memory', minutes: 8 })
const { PAGE, sleep, check, finish, list, launch, quit, ui } = t
const label = process.argv[2] || 'before'
const outDir = t.output(label)
fs.mkdirSync(outDir, { recursive: true })
const TABS = ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_browser', 'https://github.com/minbrowser/min', 'https://www.youtube.com/', 'https://news.ycombinator.com/', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', PAGE + '?a', PAGE + '?b']
// a heap snapshot over the DevTools protocol, written to a file
async function snapshot (wsUrl, file) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const out = fs.createWriteStream(file)
  let id = 0
  const done = new Promise(resolve => {
    ws.onmessage = m => {
      const d = JSON.parse(m.data)
      if (d.method === 'HeapProfiler.addHeapSnapshotChunk') out.write(d.params.chunk)
      if (d.id === 3) resolve()
    }
  })
  ws.send(JSON.stringify({ id: ++id, method: 'HeapProfiler.enable' }))
  ws.send(JSON.stringify({ id: ++id, method: 'HeapProfiler.collectGarbage' }))
  ws.send(JSON.stringify({ id: ++id, method: 'HeapProfiler.takeHeapSnapshot', params: { reportProgress: false } }))
  await Promise.race([done, sleep(120000)])
  await new Promise(resolve => out.end(resolve))
  ws.close()
}
const METRICS = `(() => { const e = process.mainModule.require('electron'); const owners = {}; e.webContents.getAllWebContents().forEach(wc => { owners[wc.getOSProcessId()] = wc.getURL().slice(0, 50) }); return e.app.getAppMetrics().map(m => ({ type: m.type + (m.name ? ':' + m.name : ''), owner: owners[m.pid] || '', privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })) })()`
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    for (const url of TABS) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
      await sleep(4000)
    }
    // visit each tab once (previews are captured when tabs are shown), then settle
    const ids = await u.evaluate('tabs.get().map(t => t.id)')
    for (const id of ids) {
      await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(id)}); 1`)
      await sleep(1500)
    }
    await sleep(10000)
    const metrics = await main.evaluate(METRICS)
    console.log('METRICS ' + JSON.stringify(metrics))
    const uiInfo = await u.evaluate(`(async () => {
      const heap = process.getHeapStatistics()
      const blink = process.getBlinkMemoryInfo()
      const mem = await process.getProcessMemoryInfo()
      const previews = tasks.map(task => task.tabs.get().map(t => (t.previewImage || '').length)).flat()
      return {
        privateKB: mem.private, residentSetKB: mem.residentSet,
        jsHeapUsedMB: Math.round(heap.usedHeapSize / 1024), jsHeapTotalMB: Math.round(heap.totalHeapSize / 1024),
        blinkAllocatedMB: Math.round(blink.allocated / 1024), blinkTotalMB: Math.round(blink.total / 1024),
        domElements: document.getElementsByTagName('*').length,
        previews: previews.length, previewChars: previews.reduce((a, b) => a + b, 0),
        localizationChars: typeof languages === 'object' ? JSON.stringify(languages).length : 'none',
        languageCount: typeof languages === 'object' ? Object.keys(languages).length : 0
      }
    })()`)
    console.log('UI ' + JSON.stringify(uiInfo))
    const mainInfo = await main.evaluate(`(() => { const v8 = process.mainModule.require('v8'); const m = process.memoryUsage(); const mb = n => Math.round(n / 1048576); return { rss: mb(m.rss), heapTotal: mb(m.heapTotal), heapUsed: mb(m.heapUsed), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers), spaces: v8.getHeapSpaceStatistics().map(s => s.space_name + ' ' + mb(s.space_used_size)).join(', ') } })()`)
    console.log('MAIN ' + JSON.stringify(mainInfo))

    const uiTarget = (await list()).find(t => t.url.startsWith('min://app/index.html'))
    await snapshot(uiTarget.webSocketDebuggerUrl, path.join(outDir, 'ui.heapsnapshot'))
    const mainTarget = (await list(t.INSPECT_PORT))[0]
    // the watchdog's main connection stays open; a second inspector session is allowed
    await snapshot(mainTarget.webSocketDebuggerUrl, path.join(outDir, 'main.heapsnapshot'))
    console.log('SNAPSHOTS ' + outDir)
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
