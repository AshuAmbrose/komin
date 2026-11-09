// The two Performance settings in the dev build: the Settings page (trimming on and the JavaScript option off by default, the restart notice), then
// trimBackgroundTabs: off = background tabs aren't trimmed while Min is in use, but are once it's minimized; on = trimmed
// while in use. Three local pages that each hold ~80 MB, on different hosts (127.0.0.x) so each gets its own process.
const path = require('path')
const fs = require('fs')
const http = require('http')
const t = require('./harness')({ name: 'performance-settings', minutes: 15 })
const { PAGE, sleep, check, finish, target, launch, quit, ui } = t
const HOSTS = ['127.0.0.2', '127.0.0.3', '127.0.0.4']
const HEAVY_PORT = 8786
const heavyPage = `<!doctype html><title>heavy</title><body><script>
  window.blocks = []
  for (let i = 0; i < 20; i++) { const b = new Uint8Array(4 * 1024 * 1024); for (let j = 0; j < b.length; j += 4096) b[j] = (Math.random() * 255) | 0; blocks.push(b) }
  for (let i = 0; i < 3000; i++) { const d = document.createElement('p'); d.textContent = 'Paragraph ' + i; document.body.appendChild(d) }
</script></body>`
const heavyServers = HOSTS.map(host => http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(heavyPage) }).listen(HEAVY_PORT, host))
const HEAVY = HOSTS.map(host => `http://${host}:${HEAVY_PORT}/heavy`)
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const workingSets = main => main.evaluate(`(() => { const e = process.mainModule.require('electron'); const metrics = e.app.getAppMetrics(); return ${JSON.stringify(HEAVY)}.map(url => { const wc = e.webContents.getAllWebContents().find(w => w.getURL() === url); const m = wc && metrics.find(x => x.pid === wc.getOSProcessId()); return m ? Math.round(m.memory.workingSetSize / 1024) : null }) })()`)
// samples whether any Min window is focused, once a second, for ms
async function focusedShare (main, ms) {
  let yes = 0; let all = 0
  const end = Date.now() + ms
  while (Date.now() < end) {
    const f = await main.evaluate("process.mainModule.require('electron').BaseWindow.getFocusedWindow() !== null")
    all++; if (f === true) yes++
    await sleep(1000)
  }
  return yes / all
}
const SETTINGS = 'min://app/pages/settings/index.html'
// the UI's settings object isn't a global: read what main saved, and change settings through the IPC it uses
const SETTINGS_FILE = path.join(t.profileDir, 'settings.json')
const savedSetting = key => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))[key] } catch (e) { return 'unreadable' } }
const setSetting = (u, key, value) => u.evaluate(`ipc.send('settingChanged', ${JSON.stringify(key)}, ${JSON.stringify(value)}); ipc.emit('settingChanged', {}, ${JSON.stringify(key)}, ${JSON.stringify(value)}); 1`)
const select = (u, url) => u.evaluate(`ipc.emit('extensions-select-tab', {}, tabs.get().find(t => t.url === ${JSON.stringify(url)}).id); 1`)
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)

    // the Settings page
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SETTINGS)} }); 1`)
    const s = await target(t => t.url.startsWith(SETTINGS) && t.type === 'page', 15000)
    await sleep(2500)
    const page = await s.evaluate(`(() => { const t = document.getElementById('checkbox-trim-background-tabs'); const j = document.getElementById('checkbox-optimize-javascript'); const text = id => (document.querySelector('[data-string="' + id + '"]') || {}).textContent; return { trimChecked: t.checked, trimShown: !document.getElementById('section-trim-background-tabs').hidden, jsChecked: j.checked, banner: !document.getElementById('restart-required-banner').hidden, heading: text('settingsPerformanceHeading'), trimLabel: text('settingsTrimBackgroundTabsToggle'), trimText: text('settingsTrimBackgroundTabsExplanation'), jsLabel: text('settingsOptimizeJavaScriptToggle'), jsText: text('settingsOptimizeJavaScriptExplanation') } })()`)
    check('Settings: trimming on and the JavaScript option off by default, trimming shown on Windows, no restart notice', page.trimChecked === true && page.jsChecked === false && page.trimShown === true && page.banner === false, page)
    check('Settings: heading, labels and explanations are translated text', [page.heading, page.trimLabel, page.trimText, page.jsLabel, page.jsText].every(t => typeof t === 'string' && t.length > 3 && !/^settings[A-Z]/.test(t)), page)
    await s.evaluate("document.getElementById('checkbox-optimize-javascript').click(); 1")
    await sleep(800)
    const afterJs = { banner: await s.evaluate("!document.getElementById('restart-required-banner').hidden"), saved: savedSetting('optimizeJavaScriptForSize') }
    check('Settings: turning the JavaScript option on saves true and shows the restart notice', afterJs.banner === true && afterJs.saved === true, afterJs)
    await s.evaluate("document.getElementById('checkbox-optimize-javascript').click(); 1")
    await s.evaluate("document.getElementById('checkbox-trim-background-tabs').click(); 1")
    await sleep(800)
    const afterTrim = { js: savedSetting('optimizeJavaScriptForSize'), trim: savedSetting('trimBackgroundTabs') }
    check('Settings: JavaScript back off (false); trimming off saves false', afterTrim.js === false && afterTrim.trim === false, afterTrim)
    s.close()
    await u.evaluate(`ipc.emit('extensions-close-tab', {}, tabs.get().find(t => t.url.startsWith(${JSON.stringify(SETTINGS)})).id); 1`)
    await sleep(1000)

    // the order keeps Min focused through both "in use" phases: once minimized, Windows may not give focus back
    // trimming on (the default), Min in use: background tabs trimmed while focused
    await setSetting(u, 'trimBackgroundTabs', true)
    for (const url of HEAVY) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
      await sleep(4000)
    }
    await select(u, PAGE)
    await main.evaluate(`(() => { const win = ${WIN}; win.focus(); return 1 })()`)
    const loaded = await workingSets(main)
    const share1 = await focusedShare(main, 100000)
    const onInUse = await workingSets(main)
    check('trimming on, in use (focused ' + Math.round(share1 * 100) + '% of the time): background tabs trimmed', share1 > 0.97 && loaded.every(mb => mb > 60) && onInUse.every(mb => mb !== null && mb < 30), { loaded, after100s: onInUse })

    // what switching back to a trimmed tab costs: time until the tab has drawn twice, and reading all of its 80 MB
    const switchTime = async (url) => {
      const t = await target(x => x.url === url && x.type === 'page', 5000)
      await t.evaluate("window.__shown = new Promise(resolve => document.addEventListener('visibilitychange', () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))), { once: true })); 1")
      const start = await t.evaluate('performance.now()')
      await select(u, url)
      const shown = await t.evaluate('window.__shown')
      const touch = await t.evaluate('(() => { const s = performance.now(); let sum = 0; for (const b of blocks) for (let j = 0; j < b.length; j += 4096) sum += b[j]; return Math.round((performance.now() - s) * 10) / 10 })()')
      t.close()
      return { showMs: Math.round(shown - start), readAllMemoryMs: touch }
    }
    const trimmedSwitch = await switchTime(HEAVY[1])
    await select(u, PAGE)
    await sleep(1500)
    const warmSwitch = await switchTime(HEAVY[1])
    check('switching back to a trimmed tab (measured, see detail)', true, { trimmed: trimmedSwitch, justUsed: warmSwitch })

    // trimming off, Min in use: background tabs keep their memory
    await setSetting(u, 'trimBackgroundTabs', false)
    // bring the tabs' memory back, as if they'd been used
    for (const url of HEAVY) {
      await select(u, url)
      await sleep(1500)
    }
    const touched = await Promise.all(HEAVY.map(async url => { const t = await target(x => x.url === url && x.type === 'page', 5000); const r = await t.evaluate('blocks.reduce((sum, b) => { for (let j = 0; j < b.length; j += 4096) sum += b[j]; return sum }, 0) > 0'); t.close(); return r }))
    await select(u, PAGE)
    await main.evaluate(`(() => { const win = ${WIN}; win.focus(); return 1 })()`)
    const before = await workingSets(main)
    const share2 = await focusedShare(main, 100000)
    const offInUse = await workingSets(main)
    check('trimming off, in use (focused ' + Math.round(share2 * 100) + '% of the time): background tabs keep their memory', share2 > 0.97 && before.every(mb => mb > 60) && offInUse.every((mb, i) => mb > 60 && mb > before[i] * 0.7), { touched, before, after100s: offInUse })

    // trimming off, Min minimized: background tabs are trimmed at the next pass
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(false); win.minimize(); return 1 })()`)
    await sleep(70000)
    const offMinimized = await workingSets(main)
    // trimmed = under 30 MB of a 200 MB page still in RAM (what the page touches again after a trim comes back in)
    check('trimming off, minimized: background tabs trimmed within 70 s', offMinimized.every(mb => mb !== null && mb < 30), offMinimized)


    u.close()
    await quit(main)
    heavyServers.forEach(x => x.close())
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    heavyServers.forEach(x => x.close())
    finish()
  }
})()
