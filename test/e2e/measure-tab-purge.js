// Do background tabs give memory back when asked? Ten real sites open; for every background page and cross-site frame:
// (1) all alive, (2) after a forced garbage collection, (3) after a "critical memory pressure" signal, (4) 90 s later.
// It found 4% (AGENTS.md section 10.4, "Measured and rejected"): kept so the measurement can be repeated, not redone.
const fs = require('fs')

const t = require('./harness')({ name: 'measure-tab-purge', minutes: 15 })
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
  const ready = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const send = async (method, params = {}) => {
    await ready
    const i = ++id
    ws.send(JSON.stringify({ id: i, method, params }))
    return new Promise(res => pending.set(i, res))
  }
  return {
    send,
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result && r.result.result ? r.result.result.value : undefined
    },
    close: () => ws.close()
  }
}

const SNAPSHOT = `(() => {
  const { app, webContents } = process.mainModule.require('electron')
  const pages = webContents.getAllWebContents().filter(wc => !wc.isDestroyed()).map(wc => ({ pid: wc.getOSProcessId(), url: wc.getURL() }))
  const metrics = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, priv: m.memory.privateBytes, ws: m.memory.workingSetSize }))
  return { pages, metrics }
})()`

function site (url) {
  if (url.startsWith('min://app/index.html')) return 'Min UI'
  if (url.includes('placesService')) return 'History service'
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + (u.pathname.startsWith('/results') ? ' (search)' : '') } catch (e) { return url.slice(0, 40) }
}

function groups (snap) {
  const byPid = {}
  snap.pages.forEach(p => { byPid[p.pid] = (byPid[p.pid] || []).concat(site(p.url)) })
  const g = {}
  snap.metrics.forEach(m => {
    const label = m.type === 'Tab' ? (byPid[m.pid] ? [...new Set(byPid[m.pid])].join(' + ') : 'other renderers (frames, cache)') : m.type
    g[label] = (g[label] || 0) + Math.round(m.priv / 1024)
  })
  return g
}

async function backgroundTargets () {
  return (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).filter(t =>
    (t.type === 'page' || t.type === 'iframe') && /^https?:/.test(t.url) && !t.url.startsWith('https://example.com') && t.webSocketDebuggerUrl)
}

async function forEachTarget (commands) {
  const targets = await backgroundTargets()
  let ok = 0
  const errors = new Set()
  for (const t of targets) {
    try {
      const c = cdp(t.webSocketDebuggerUrl)
      for (const [method, params] of commands) {
        const r = await c.send(method, params)
        if (r.error) errors.add(method + ': ' + r.error.message)
      }
      c.close()
      ok++
    } catch (e) { errors.add(e.message) }
  }
  return { targets: targets.length, ok, errors: [...errors] }
}

;(async () => {
  const mainConnection = await t.launch('https://example.com/')
  const out = { steps: {} }
  try {
    let ui = null; let main = null
    for (let i = 0; i < 80 && !(ui && main); i++) {
      await sleep(500)
      try { ui = ui || (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.url.startsWith('min://app/index.html')) } catch (e) {}
      main = mainConnection
    }
    const uiPage = cdp(ui.webSocketDebuggerUrl)
    const mainProc = { ...main, evaluate: async e => { const v = await main.evaluate(e); if (typeof v === 'string' && /^(EXC|ERR|TIMEOUT)/.test(v)) throw new Error(v.slice(0, 300)); return v } }
    await sleep(4000)
    for (const url of SITES) {
      await uiPage.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} })`)
      await sleep(7000)
    }
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: 'https://example.com/' })`)
    console.log('10 tabs open in the background; settling 60 s...')
    await sleep(60000)

    out.steps['1 alive'] = groups(await mainProc.evaluate(SNAPSHOT))

    out.gc = await forEachTarget([['HeapProfiler.collectGarbage', {}]])
    await sleep(10000)
    out.steps['2 after garbage collection'] = groups(await mainProc.evaluate(SNAPSHOT))

    out.pressure = await forEachTarget([['Memory.simulatePressureNotification', { level: 'critical' }], ['HeapProfiler.collectGarbage', {}]])
    await sleep(15000)
    out.steps['3 after memory-pressure signal'] = groups(await mainProc.evaluate(SNAPSHOT))

    await sleep(90000)
    out.steps['4 90 s later'] = groups(await mainProc.evaluate(SNAPSHOT))

    uiPage.close(); mainProc.close()
  } catch (e) {
    out.error = e.message
  } finally {
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(out, null, 1))
    t.finish()
    console.log(JSON.stringify({ error: out.error, gc: out.gc, pressure: out.pressure }))
  }
})()
