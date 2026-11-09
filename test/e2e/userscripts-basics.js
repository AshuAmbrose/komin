// Userscripts, the basics: run-at timing (document-start, -body, -end, -idle), iframes and @noframes, @exclude, a strict
// CSP + Trusted Types page, scripts that throw or don't parse, a legacy script, a manual (context-menu) run, live reload
// when a script is added, private tabs off and on, and turning userscripts off. Compares with userscripts-basics.expected.json.
const http = require('http')
const path = require('path')
const fs = require('fs')

const t = require('./harness')({ name: 'userscripts-basics', minutes: 6, settings: { userscriptsEnabled: true } })
const CDP_PORT = t.CDP_PORT
const PORT = 8765
const profile = t.profileDir
const scriptDir = path.join(profile, 'userscripts')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const throwing = c => ({ ...c, evaluate: async e => { const v = await c.evaluate(e); if (typeof v === 'string' && /^(EXC|ERR|TIMEOUT)/.test(v)) throw new Error(v.slice(0, 400)); return v } })
async function json (url) { return (await fetch(url)).json() }
function cdp (wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const ready = new Promise(r => { ws.onopen = r })
  return {
    evaluate: async (expression) => {
      await ready
      const i = ++id
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      const r = await new Promise(res => pending.set(i, res))
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result && r.result.result ? r.result.result.value : undefined
    },
    send: async (method, params = {}) => {
      await ready
      const i = ++id
      ws.send(JSON.stringify({ id: i, method, params }))
      return new Promise(res => pending.set(i, res))
    },
    close: () => ws.close()
  }
}

function userscript (meta, body) {
  return '// ==UserScript==\n' + meta.map(m => '// ' + m).join('\n') + '\n// ==/UserScript==\n' + body + '\n'
}

const SCRIPTS = {
  'a-start.user.js': userscript(['@name Start', '@match http://127.0.0.1/*', '@run-at document-start'],
    "var wrappedVar = 1\nwindow.__us = { order: ['start'], startHadBody: !!document.body, startReadyState: document.readyState }"),
  'b-body.user.js': userscript(['@name Body', '@match http://127.0.0.1/*', '@run-at document-body'],
    "window.__us.order.push('body'); window.__us.bodyExisted = !!document.body; window.__us.bodyReadyState = document.readyState"),
  'c-end.user.js': userscript(['@name End', '@match http://127.0.0.1/*', '@run-at document-end'],
    "window.__us.order.push('end'); window.__us.endReadyState = document.readyState"),
  'd-idle.user.js': userscript(['@name Idle', '@match http://127.0.0.1/*'],
    "window.__us.order.push('idle')"),
  'e-noframes.user.js': userscript(['@name No frames', '@match http://127.0.0.1/*', '@match http://localhost/frame*', '@noframes', '@run-at document-start'],
    'window.__us_noframes_ran = true'),
  'f-frame.user.js': userscript(['@name Frame', '@match http://localhost/frame*', '@run-at document-start'],
    'window.__us_frame = true'),
  'g-excluded.user.js': userscript(['@name Excluded', '@match http://127.0.0.1/*', '@exclude http://127.0.0.1:8765/page*'],
    'window.__us_excluded = true'),
  'h-csp.user.js': userscript(['@name CSP', '@match http://127.0.0.1/csp', '@run-at document-start'],
    'window.__us_csp = true'),
  'i-menu.user.js': userscript(['@name Menu', '@match http://127.0.0.1/*', '@run-at context-menu'],
    'window.__us_menu = (window.__us_menu || 0) + 1'),
  'j-throws.user.js': userscript(['@name Throws', '@match http://127.0.0.1/*'],
    "window.__us.order.push('throws'); throw new Error('boom')"),
  'k-syntax.user.js': userscript(['@name Syntax', '@match http://127.0.0.1/*'],
    'this is not javascript ('),
  '127.0.0.1.js': 'var legacyGlobal = 1\n'
}

const PAGE = `<!doctype html><html><head><title>t</title>
<script>window.__page = { head: window.__us ? window.__us.order.slice() : null }</script>
</head><body>
<iframe src="http://localhost:${PORT}/frame"></iframe>
<script>window.__page.bodyEnd = window.__us ? window.__us.order.slice() : null
document.addEventListener('DOMContentLoaded', function () { window.__page.dcl = window.__us ? window.__us.order.slice() : null })</script>
</body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/csp') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'none'; require-trusted-types-for 'script'" })
    return res.end('<!doctype html><p>csp</p>')
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(req.url.startsWith('/page') ? PAGE : '<!doctype html><p>' + req.url + '</p>')
})

const WRAP_MAIN = `(() => {
  const { ipcMain } = process.mainModule.require('electron')
  const original = ipcMain.listeners('userscripts-get')[0]
  ipcMain.removeAllListeners('userscripts-get')
  global.__usLog = []
  ipcMain.on('userscripts-get', (e, url) => {
    const t = process.hrtime.bigint()
    original(e, url)
    global.__usLog.push({ url, frameUrl: e.senderFrame && e.senderFrame.url, top: !e.senderFrame.parent, private: !e.sender.session.isPersistent(), ms: Number(process.hrtime.bigint() - t) / 1e6, scripts: e.returnValue ? e.returnValue.map(s => s.name) : null })
  })
  return 'wrapped'
})()`

const PAGE_STATE = `({
  us: window.__us || null,
  page: window.__page || null,
  noframesTop: window.__us_noframes_ran === true,
  excluded: window.__us_excluded === true,
  menu: window.__us_menu || 0,
  legacyGlobal: window.legacyGlobal,
  wrappedVarLeaked: typeof window.wrappedVar !== 'undefined',
  newScript: window.__us_new === true,
  frame: (() => { try { return null } catch (e) { return null } })()
})`

async function pageTarget (match) {
  const targets = await json(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return targets.find(t => t.type === 'page' && match(t.url))
}

;(async () => {
  fs.mkdirSync(scriptDir, { recursive: true })
  for (const [name, content] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(scriptDir, name), content)

  await new Promise(r => server.listen(PORT, '127.0.0.1', r))
  const out = {}
  const mainConnection = await t.launch(`http://127.0.0.1:${PORT}/blank`)
  try {
    let ui = null; let main = null
    for (let i = 0; i < 80 && !(ui && main); i++) {
      await sleep(500)
      try { ui = ui || (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.url.startsWith('min://app/index.html')) } catch (e) {}
      main = mainConnection
    }
    const uiPage = cdp(ui.webSocketDebuggerUrl)
    const mainProc = throwing(main)
    await sleep(2500)
    // the page given on the command line loads during startup; its document-start script must already be there
    const startupTarget = await pageTarget(u => u.endsWith('/blank'))
    const startupPage = cdp(startupTarget.webSocketDebuggerUrl)
    out.startupPage = await startupPage.evaluate('({ start: !!window.__us, order: window.__us && window.__us.order })')
    startupPage.close()
    out.wrap = await mainProc.evaluate(WRAP_MAIN)
    out.uiList = await uiPage.evaluate(`ipc.invoke('userscripts-list').then(l => l.map(s => s.name + ' @ ' + s.runAt))`)

    // 1. run-at timing, frames, exclusions, errors, legacy
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: 'http://127.0.0.1:${PORT}/page' })`)
    await sleep(2500)
    let target = await pageTarget(u => u.includes('/page'))
    let page = cdp(target.webSocketDebuggerUrl)
    out.normalTab = await page.evaluate(PAGE_STATE)
    // the iframe is cross-origin (localhost vs 127.0.0.1), so read it through its own target
    const frameTarget = (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.url.includes('localhost:' + PORT + '/frame'))
    if (frameTarget) {
      const frame = cdp(frameTarget.webSocketDebuggerUrl)
      out.iframe = await frame.evaluate(`({ frameScript: window.__us_frame === true, noframesScript: window.__us_noframes_ran === true })`)
      frame.close()
    } else {
      out.iframe = 'no separate target for the iframe'
    }

    // 2. strict CSP + Trusted Types page
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: 'http://127.0.0.1:${PORT}/csp' })`)
    await sleep(2000)
    const cspTarget = await pageTarget(u => u.endsWith('/csp'))
    const csp = cdp(cspTarget.webSocketDebuggerUrl)
    out.cspPage = await csp.evaluate(`({ cspScript: window.__us_csp === true, startScript: !!window.__us })`)
    csp.close()

    // 3. manual run of a context-menu script in the /page tab
    await page.send('Page.bringToFront')
    out.manualRun = await uiPage.evaluate(`(async () => {
      const id = tabs.get().find(t => t.url && t.url.includes('/page')).id
      await ipc.invoke('userscripts-run', { tabId: id, scriptId: 'i-menu.user.js' })
      await ipc.invoke('userscripts-run', { tabId: id, scriptId: 'i-menu.user.js' })
      return 'ran twice'
    })()`)
    out.menuCountAfterManualRun = await page.evaluate('window.__us_menu || 0')

    // 4. live reload: add a script while running
    await uiPage.evaluate(`window.__usChanges = []; ipc.on('userscripts-changed', (e, l) => window.__usChanges.push(l.length)); 'ok'`)
    fs.writeFileSync(path.join(scriptDir, 'l-new.user.js'), userscript(['@name New', '@match http://127.0.0.1/*'], 'window.__us_new = true'))
    await sleep(1500)
    out.uiChangeEvents = await uiPage.evaluate('window.__usChanges')
    await page.send('Page.reload')
    await sleep(2000)
    page.close()
    target = await pageTarget(u => u.includes('/page'))
    page = cdp(target.webSocketDebuggerUrl)
    out.afterAddingScript = await page.evaluate('({ newScript: window.__us_new === true, order: window.__us && window.__us.order })')

    // 5. private tab: off by default, on with the setting
    const before = new Set((await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).map(t => t.id))
    await uiPage.evaluate(`ipc.emit('addPrivateTab'); 'ok'`)
    await sleep(2000)
    let privTarget = (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.type === 'page' && !before.has(t.id))
    if (!privTarget) {
      out.privateTab = 'no new target after addPrivateTab'
    } else {
      let priv = cdp(privTarget.webSocketDebuggerUrl)
      await priv.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/page?private` })
      await sleep(2000)
      out.privateTabDefault = await priv.evaluate('({ ran: !!window.__us, url: location.href })')
      await uiPage.evaluate(`ipc.send('settingChanged', 'userscriptsInPrivateTabs', true); 'ok'`)
      await sleep(300)
      await priv.send('Page.reload')
      await sleep(2000)
      priv.close()
      privTarget = (await json(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.url.includes('/page?private'))
      priv = cdp(privTarget.webSocketDebuggerUrl)
      out.privateTabWithSetting = await priv.evaluate('({ ran: !!window.__us })')
      priv.close()
    }

    // 6. turning the feature off
    await uiPage.evaluate(`ipc.send('settingChanged', 'userscriptsEnabled', false); 'ok'`)
    await sleep(500)
    out.uiChangeEventsAfterOff = await uiPage.evaluate('window.__usChanges')
    await page.send('Page.reload')
    await sleep(2000)
    page.close()
    target = await pageTarget(u => u.endsWith('/page'))
    page = cdp(target.webSocketDebuggerUrl)
    out.afterTurningOff = await page.evaluate('({ ran: !!window.__us })')
    page.close()

    out.mainLog = await mainProc.evaluate('global.__usLog')
    uiPage.close(); mainProc.close()
  } catch (e) {
    out.error = String(e.stack || e)
  } finally {
    server.close()
    await sleep(1500)
    out.mainProcessOutput = t.childLog().split('\n').filter(l => /userscript|Error|error/i.test(l)).slice(0, 20)
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(out, null, 2))
    t.check('no script error', !out.error, out.error)
    t.compareToExpected(out, [/^\.mainLog\.\d+\.ms$/, /^\.mainProcessOutput/])
    t.finish()
  }
})()
