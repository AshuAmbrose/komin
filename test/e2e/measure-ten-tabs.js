// What background tabs cost and what each low-resource step gets back: ten real sites open, then memory and CPU per process
// (1) with all tabs alive, (2) after trimming the background tabs (trimMemory.exe), (3) after hibernating them. Results in
// test/e2e/results/measure-ten-tabs-observed.json (AGENTS.md section 10.4 has the numbers from earlier runs).
const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// Min trims background tabs by itself (30 s after they're left, and whenever no Min window is focused): this run turns
// that setting off so step 1 measures untrimmed tabs, and it needs the screen unlocked (a locked screen leaves no window
// focused, and the 60 s pass trims anyway). Check 'focused' in the results.
const t = require('./harness')({ name: 'measure-ten-tabs', minutes: 15, settings: { trimBackgroundTabs: false } })
const root = t.root
const CDP_PORT = t.CDP_PORT
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SITES = [
  'https://www.youtube.com/',
  'https://www.youtube.com/results?search_query=lofi+music',
  'https://timesofindia.indiatimes.com/',
  'https://www.ndtv.com/',
  'https://www.reddit.com/',
  'https://web.whatsapp.com/',
  'https://discord.com/app',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://github.com/electron/electron',
  'https://www.bbc.com/news'
]

async function json (url) { return (await fetch(url)).json() }

function cdp (wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const ready = new Promise(r => { ws.onopen = r })
  const evaluate = async (expression) => {
    await ready
    const i = ++id
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }))
    const r = await new Promise(res => pending.set(i, res))
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  return { evaluate, close: () => ws.close() }
}

// runs in the main process (through the Node inspector): per-process metrics plus which pages live in which process
const SNAPSHOT = `(() => {
  const { app, webContents } = process.mainModule.require('electron')
  const pages = webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).map(wc => ({ pid: wc.getOSProcessId(), url: wc.getURL() }))
  const metrics = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize, priv: m.memory.privateBytes }))
  return { pages, metrics }
})()`

function siteName (url) {
  if (!url) return '?'
  if (url.startsWith('min://app/index.html')) return 'Min UI'
  if (url.includes('placesService')) return 'History service'
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname.startsWith('/results') ? ' (search)' : '') } catch (e) { return url.slice(0, 40) }
}

function summarize (snap, selectedUrl) {
  const byPid = {}
  for (const p of snap.pages) { (byPid[p.pid] = byPid[p.pid] || []).push(p.url) }
  const rows = snap.metrics.map(m => {
    const urls = byPid[m.pid] || []
    let label = m.type === 'Tab' ? (urls.length ? [...new Set(urls.map(siteName))].join(' + ') : 'cross-site frames (ads, embeds)') : m.type
    if (m.type === 'Tab' && urls.length === 0) label = 'cross-site frames (ads, embeds)'
    return { pid: m.pid, type: m.type, label, privMB: Math.round(m.priv / 1024), wsMB: Math.round(m.ws / 1024), cpu: Math.round(m.cpu * 10) / 10 }
  })
  const total = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0)
  return { rows: rows.sort((a, b) => b.privMB - a.privMB), totalPrivMB: total('privMB'), totalWsMB: total('wsMB'), totalCpu: Math.round(total('cpu') * 10) / 10, processes: rows.length }
}

;(async () => {
  const mainConnection = await t.launch('https://example.com/')
  const results = {}
  try {
    let ui = null
    let main = null
    for (let i = 0; i < 80 && !(ui && main); i++) {
      await sleep(500)
      try { ui = ui || (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.url.startsWith('min://app/index.html')) } catch (e) {}
      main = mainConnection
    }
    if (!ui || !main) throw new Error('could not connect (ui: ' + !!ui + ', main: ' + !!main + ')')
    const uiPage = cdp(ui.webSocketDebuggerUrl)
    const mainProc = { ...main, evaluate: async e => { const v = await main.evaluate(e); if (typeof v === 'string' && /^(EXC|ERR|TIMEOUT)/.test(v)) throw new Error(v.slice(0, 300)); return v } }
    await sleep(4000)

    console.log('opening 10 tabs...')
    for (const url of SITES) {
      await uiPage.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} })`)
      await sleep(7000)
    }
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: 'https://example.com/' })`)
    console.log('all opened; letting pages settle for 45 s...')
    await sleep(45000)

    // 1) everything alive, measured over 60 s of idle
    await mainProc.evaluate(SNAPSHOT)
    await sleep(60000)
    results.alive = summarize(await mainProc.evaluate(SNAPSHOT))
    results.focused = await mainProc.evaluate("process.mainModule.require('electron').BaseWindow.getFocusedWindow() !== null")
    results.screenLocked = t.isScreenLocked()
    console.log('alive:', results.alive.totalPrivMB, 'MB private,', results.alive.totalWsMB, 'MB in RAM,', results.alive.totalCpu, '% CPU,', results.alive.processes, 'processes')

    // 2) trim the background tabs' working sets, the way viewManager.trimInactiveTabsNow does
    const snap = await mainProc.evaluate(SNAPSHOT)
    const bgPids = [...new Set(snap.pages.filter(p => /^https?:/.test(p.url) && !p.url.startsWith('https://example.com')).map(p => String(p.pid)))]
    execFileSync(path.join(root, 'ext/windows/trimMemory.exe'), bgPids, { windowsHide: true })
    await sleep(5000)
    results.trimmed = summarize(await mainProc.evaluate(SNAPSHOT))
    console.log('trimmed:', results.trimmed.totalPrivMB, 'MB private,', results.trimmed.totalWsMB, 'MB in RAM')

    // 3) hibernate every background tab (same message checkSmartHibernation sends), then measure 60 s idle
    const hibernated = await uiPage.evaluate(`(() => { const sel = tabs.getSelected(); const ids = tabs.get().filter(t => t.id !== sel).map(t => t.id); ids.forEach(id => ipc.emit('hibernateTab', {}, id)); return ids.length })()`)
    await sleep(15000)
    await mainProc.evaluate(SNAPSHOT)
    await sleep(60000)
    results.hibernated = summarize(await mainProc.evaluate(SNAPSHOT))
    results.hibernatedTabCount = hibernated
    console.log('hibernated:', results.hibernated.totalPrivMB, 'MB private,', results.hibernated.totalWsMB, 'MB in RAM,', results.hibernated.totalCpu, '% CPU,', results.hibernated.processes, 'processes')

    uiPage.close(); mainProc.close()
  } catch (e) {
    console.log('error:', e.message)
  } finally {
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(results, null, 1))
    t.finish()
  }
})()
