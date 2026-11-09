// Steady-state cost of extensions: the same single page with none installed, then (after a restart) with Dark Reader,
// Bitwarden and uBO Lite. Memory by process kind and CPU, from app.getAppMetrics. AGENTS.md section 10.9 has the earlier
// result (3 more processes, about 80 MB each, 0% CPU when idle).
// usage: node test/e2e/measure-extension-cost.js     results: test/e2e/results/measure-extension-cost-observed.json
const http = require('http')
const fs = require('fs')
const IDS = { darkreader: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', bitwarden: 'nngceckbapebfimnlniiiahkandclblb', ubol: 'ddkjiahejlhfcafbddmgiahcphecmpfh' }
const t = require('./harness')({ name: 'measure-extension-cost', minutes: 10, extensions: Object.values(IDS) })
const { sleep, check, finish, waitFor, target, launch, quit } = t
const PORT = 8770
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>plain</title><h1>Plain page</h1><p>Some text.</p>') }).listen(PORT, '127.0.0.1')
const PLAIN = `http://127.0.0.1:${PORT}/plain`

const metrics = main => main.evaluate(`(() => { const m = process.mainModule.require('electron').app.getAppMetrics()
  const byType = {}; m.forEach(p => { const k = p.type + (p.serviceName ? ':' + p.serviceName : ''); byType[k] = byType[k] || { n: 0, mb: 0 }; byType[k].n++; byType[k].mb += Math.round(p.memory.privateBytes / 1024) })
  return { processes: m.length, privateMB: Math.round(m.reduce((s, p) => s + p.memory.privateBytes, 0) / 1024), cpuPercent: Math.round(m.reduce((s, p) => s + p.cpu.percentCPUUsage, 0) * 10) / 10, byType } })()`)

;(async () => {
  try {
    const out = {}
    // none installed
    let main = await launch(PLAIN)
    await sleep(20000)
    await metrics(main) // the first call starts the CPU counters
    await sleep(5000)
    out.none = await metrics(main)
    // install the three
    const u = await target(t => t.url.startsWith('min://app/index.html'))
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    for (const name of Object.keys(IDS)) {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.crx(IDS[name]))}; 1`)
      out['install-' + name] = await s.evaluate("extensionPages.request('install-crx')")
    }
    await sleep(2000)
    s.close(); u.close()
    await quit(main)
    // relaunch with the same single page
    main = await launch(PLAIN)
    const u2 = await target(t => t.url.startsWith('min://app/index.html'))
    await sleep(3000)
    // the Settings tab and Dark Reader's welcome tab come back with the session; close them (as an extension would)
    await u2.evaluate("tabs.get().filter(t => !t.url.includes('/plain')).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1")
    await sleep(1000)
    out.tabsAfterRestart = await u2.evaluate('tabs.get().map(t => t.url)')
    await sleep(20000)
    await metrics(main)
    await sleep(5000)
    out.three = await metrics(main)
    out.extensionsLoaded = await main.evaluate("process.mainModule.require('electron').session.fromPartition('persist:webcontent').extensions.getAllExtensions().map(e => e.name)")
    u2.close()
    await quit(main)
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(out, null, 1))
    check('the three extensions installed and loaded', Object.keys(IDS).every(n => out['install-' + n] === IDS[n]) && out.extensionsLoaded.length >= 3, out.extensionsLoaded)
    check('cost of the three (info)', true, { processes: out.three.processes - out.none.processes, privateMB: out.three.privateMB - out.none.privateMB, cpuPercent: out.three.cpuPercent })
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
