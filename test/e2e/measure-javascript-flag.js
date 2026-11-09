// --optimize-for-size on vs off (the optimizeJavaScriptForSize setting, read at startup), four rounds: on, off, on, off.
// usage: node test/e2e/measure-javascript-flag.js [rounds]   (default 4; 2 for a quick check: on, off)
// Each round: private memory of four real sites and of Min's UI and main process; a local JavaScript test (median of 3);
// Speedometer 3.1 (window kept on top, since a covered window doesn't draw).
const path = require('path')
const fs = require('fs')
const http = require('http')
const t = require('./harness')({ name: 'measure-javascript-flag', minutes: 45 })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const BENCH_PORT = 8785
const benchServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>js test</title><div id="host"></div><script>
    function time (fn) { const start = performance.now(); fn(); return performance.now() - start }
    window.runTests = function () {
      const results = {}
      results.objects = time(() => { const list = []; for (let i = 0; i < 2000000; i++) list.push({ id: i, name: 'n' + (i % 100), value: i * 2 }); let sum = 0; for (const o of list) sum += o.value; window.sink = sum })
      results.json = time(() => { const data = Array.from({ length: 60000 }, (x, i) => ({ id: i, title: 'Item ' + i, tags: ['a', 'b', 'c'], nested: { x: i, y: [i, i + 1] } })); for (let r = 0; r < 5; r++) window.sink = JSON.parse(JSON.stringify(data)).length })
      results.sort = time(() => { const numbers = Array.from({ length: 1000000 }, () => Math.random()); numbers.sort((a, b) => a - b); window.sink = numbers[0] })
      results.text = time(() => { let parts = []; for (let i = 0; i < 200000; i++) parts.push('word' + i + ' '); const text = parts.join(''); window.sink = text.replace(/word(\\d+)/g, (m, n) => n % 2 ? 'odd' : 'even').length })
      results.dom = time(() => { const host = document.getElementById('host'); for (let i = 0; i < 10000; i++) { const d = document.createElement('div'); d.className = 'row r' + i; d.textContent = 'Row ' + i; host.appendChild(d) } window.sink = host.querySelectorAll('.row').length; host.textContent = '' })
      results.total = Object.values(results).reduce((a, b) => a + b, 0)
      return results
    }
  </script>`)
}).listen(BENCH_PORT, '127.0.0.1')
const BENCH = `http://127.0.0.1:${BENCH_PORT}/bench`
const SITES = ['https://www.youtube.com/', 'https://github.com/minbrowser/min', 'https://en.wikipedia.org/wiki/Web_browser', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript']
const SPEEDOMETER = 'https://browserbench.org/Speedometer3.1/?startAutomatically=true'
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const MEMORY = `(() => { const e = process.mainModule.require('electron'); const owners = {}; e.webContents.getAllWebContents().forEach(wc => { owners[wc.getOSProcessId()] = wc.getURL() }); return e.app.getAppMetrics().map(m => ({ owner: m.type === 'Browser' ? 'main' : (owners[m.pid] || m.type), privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })) })()`
const SETTINGS_FILE = path.join(t.profileDir, 'settings.json')
function setSettingInFile (key, value) {
  let list = {}
  try { list = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } catch (e) {}
  list[key] = value
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(list))
}
const median = list =>list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)]
;(async () => {
  let main
  const rounds = []
  try {
    for (const [index, on] of [true, false, true, false, true, false].slice(0, Number(process.argv[2]) || 4).entries()) {
      // the flag is read at startup; the UI's settings object isn't a global, so the file is changed while Min is closed
      setSettingInFile('optimizeJavaScriptForSize', on)
      main = await launch(PAGE)
      const u = await ui()
      await sleep(2000)
      const flags = await main.evaluate("process.mainModule.require('electron').app.commandLine.getSwitchValue('js-flags')")
      await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
      for (const url of SITES) {
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
        await sleep(6000)
      }
      await sleep(25000)
      const memory = await main.evaluate(MEMORY)
      const siteMemory = SITES.map(site => (memory.find(m => m.owner.startsWith(site)) || {}).privateMB)
      const uiMemory = (memory.find(m => m.owner.startsWith('min://app/index.html')) || {}).privateMB
      const mainMemory = (memory.find(m => m.owner === 'main') || {}).privateMB

      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(BENCH)} }); 1`)
      const bench = await target(t => t.url === BENCH && t.type === 'page', 15000)
      await sleep(2000)
      const runs = []
      for (let i = 0; i < 3; i++) runs.push(await bench.evaluate('runTests()'))
      const js = Object.fromEntries(Object.keys(runs[0]).map(k => [k, Math.round(median(runs.map(r => r[k])))]))

      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SPEEDOMETER)} }); 1`)
      const sp = await target(t => t.url.startsWith('https://browserbench.org/Speedometer3.1') && t.type === 'page', 20000)
      const score = sp && await waitFor(async () => {
        const text = await sp.evaluate("(() => { const el = document.querySelector('#result-number'); return el && el.textContent.trim() ? el.textContent.trim() : null })()")
        if (text === 'Error') return 'Error'
        return typeof text === 'string' && /^[0-9.]+$/.test(text) ? Number(text) : null
      }, 360000)
      const round = { round: index + 1, optimizeForSize: on, flags, siteMemory, uiMemory, mainMemory, js, speedometer: score || 'no result' }
      console.log('ROUND ' + JSON.stringify(round))
      rounds.push(round)
      u.close()
      await quit(main)
    }
    fs.writeFileSync(t.output('rounds.json'), JSON.stringify(rounds, null, 2))
    benchServer.close()
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    benchServer.close()
    finish()
  }
})()
