// What Min's tab list for extensions costs (main/extensionTabs.js, AGENTS.md section 10.9, since 2026-11-09). It only runs
// while extensions do, so with one installed (test extension extensions/tabs, which listens to every tab event):
//   - fifteen tabs opened in the background, forty switches between them 300 ms apart, ten closed (the tab work), then a
//     minute idle;
//   - Min's processor time (all of Min, and main) for each, as seconds and %; private memory and working set at the end of
//     each; the tab events the extension saw.
// Modes:
//   new  as Min is;
//   old  Min's tab list off (MIN_TEST_OLD=noExtensionTabList): extensions see the library's own list, as on master.
// usage: node test/e2e/measure-extension-tab-list.js <new|old> [label]    results: results/measure-extension-tab-list-<mode>[-label].json
// Alternate the modes (new, old, new, old), at least three runs each.
const mode = process.argv[2]
if (!['new', 'old'].includes(mode)) {
  console.error('usage: node test/e2e/measure-extension-tab-list.js <new|old> [label]')
  process.exit(2)
}
if (mode === 'old') process.env.MIN_TEST_OLD = [process.env.MIN_TEST_OLD, 'noExtensionTabList'].filter(Boolean).join(',')
const label = process.argv[3] ? '-' + process.argv[3].replace(/[^a-z0-9-]/gi, '') : ''
const t = require('./harness')({ name: 'measure-extension-tab-list-' + mode + label, minutes: 8 })
const { PAGE, sleep, check, finish, target, waitFor, launch, quit, ui } = t
const old = require('./old-behaviour')(t)
const TABS = t.extension('tabs')
const page = name => PAGE + '?' + name
const CPU = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const sum = l => l.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0); return { all: sum(m), main: sum(m.filter(x => x.type === 'Browser')) } })()"
const MEMORY = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const mb = (l, k) => Math.round(l.reduce((a, x) => a + (x.memory[k] || 0), 0) / 1024); return { allMB: mb(m, 'privateBytes'), mainMB: mb(m.filter(x => x.type === 'Browser'), 'privateBytes'), workingSetMB: mb(m, 'workingSetSize'), processes: m.length } })()"
const CORES = require('os').cpus().length
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d

;(async () => {
  try {
    const main = await launch(page('t0'))
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
    const w = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
    await w.evaluate('self.events = []; 1')
    await sleep(3000)

    const phase = async (fn) => {
      const a = await main.evaluate(CPU)
      const start = Date.now()
      await fn()
      const b = await main.evaluate(CPU)
      const wall = (Date.now() - start) / 1000
      const all = b.all - a.all
      return { allSeconds: round(all, 2), mainSeconds: round(b.main - a.main, 2), wallSeconds: round(wall), percentOfOneCore: round(all / wall * 100), percentOfAllCores: round(all / wall / CORES * 100, 2), memoryAtEnd: await main.evaluate(MEMORY) }
    }
    const idOf = name => u.evaluate(`(tabs.get().find(t => t.url === ${JSON.stringify(page(name))}) || {}).id`)
    const tabWork = await phase(async () => {
      for (let i = 1; i <= 15; i++) {
        await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'open-${i}', url: ${JSON.stringify(page('t' + i))}, active: false }); 1`)
        await sleep(300)
      }
      await sleep(2000)
      for (let i = 0; i < 40; i++) {
        const tabId = await idOf('t' + ((i * 7) % 16))
        if (tabId) await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(tabId)}); 1`)
        await sleep(300)
      }
      for (let i = 6; i <= 15; i++) {
        const tabId = await idOf('t' + i)
        if (tabId) await u.evaluate(`ipc.emit('extensions-close-tab', {}, ${JSON.stringify(tabId)}); 1`)
        await sleep(300)
      }
      await sleep(2000)
    })
    const idle = await phase(() => sleep(60000))
    const events = await w.evaluate('self.events.length')
    const seen = await w.evaluate('listTabs().then(l => l.length)')
    const result = { mode, old, tabWork, idleOneMinute: idle, extensionEvents: events, tabsTheExtensionSees: seen, tabsInMin: await u.evaluate('tabs.get().length') }
    console.log('RESULT ' + JSON.stringify(result))
    check('processor time and memory (info)', true, result)
    w.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
