// Real userscripts from GitHub, installed the way a user would (open the .user.js link, click Install) with userscripts
// off at first (so installing also turns them on), then the sites they target: Return YouTube Dislike on a video, and three
// of Mottie's GitHub scripts on a file and a folder. Needs the internet; sites change, so YouTube's result is information only.
const path = require('path')
const fs = require('fs')

const t = require('./harness')({ name: 'userscripts-real', minutes: 8 })
const CDP_PORT = t.CDP_PORT
const profile = t.profileDir
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const SCRIPTS = [
  'https://raw.githubusercontent.com/Anarios/return-youtube-dislike/main/Extensions/UserScript/Return%20Youtube%20Dislike.user.js',
  'https://raw.githubusercontent.com/Mottie/GitHub-userscripts/master/github-code-show-whitespace.user.js',
  'https://raw.githubusercontent.com/Mottie/GitHub-userscripts/master/github-toggle-expanders.user.js',
  'https://raw.githubusercontent.com/Mottie/GitHub-userscripts/master/github-image-preview.user.js'
]

async function json (url) { return (await fetch(url)).json() }
function cdp (wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const events = []
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
    if (d.method === 'Runtime.exceptionThrown') {
      const e = d.params.exceptionDetails
      events.push({ type: 'exception', text: (e.exception && e.exception.description || e.text || '').slice(0, 300), url: e.url || (e.stackTrace && e.stackTrace.callFrames[0] && e.stackTrace.callFrames[0].url) || '' })
    }
    if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) {
      events.push({ type: d.params.type, text: d.params.args.map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ').slice(0, 300) })
    }
    if (d.method === 'Network.requestWillBeSent') events.push({ type: 'request', url: d.params.request.url.slice(0, 120) })
  }
  const ready = new Promise(resolve => { ws.onopen = resolve })
  const send = async (method, params = {}) => {
    await ready
    const i = ++id
    ws.send(JSON.stringify({ id: i, method, params }))
    return new Promise(resolve => pending.set(i, resolve))
  }
  return {
    events,
    send,
    evaluate: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
      return r.result && r.result.result ? r.result.result.value : undefined
    },
    close: () => ws.close()
  }
}
async function targets () { return json(`http://127.0.0.1:${CDP_PORT}/json/list`) }
async function waitFor (fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v } catch (e) {}
    await sleep(300)
  }
  return null
}

;(async () => {

  const out = { installs: [], pages: {} }
  await t.launch('about:blank')
  try {
    const ui = await waitFor(async () => (await targets()).find(t => t.url.startsWith('min://app/index.html')), 40000)
    const uiPage = cdp(ui.webSocketDebuggerUrl)
    await waitFor(() => uiPage.evaluate('typeof ipc === "object" && typeof tabs === "object"'))

    // install each script the way a user would: open the .user.js link, then click Install
    for (const url of SCRIPTS) {
      const result = { url: decodeURIComponent(url.split('/').pop()) }
      await uiPage.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 'ok'`)
      const installTarget = await waitFor(async () => (await targets()).find(t => t.url.startsWith('min://app/pages/userscriptInstall/') && t.url.includes(encodeURIComponent(url))))
      if (!installTarget) { result.error = 'install page did not open'; out.installs.push(result); continue }
      const install = cdp(installTarget.webSocketDebuggerUrl)
      await waitFor(() => install.evaluate(`!document.getElementById('details').hidden || document.getElementById('status').textContent.startsWith("Couldn't")`))
      result.page = await install.evaluate(`({ name: document.getElementById('script-name').textContent, meta: document.getElementById('script-meta').textContent, warnings: Array.from(document.querySelectorAll('#warnings > li')).map(li => li.textContent), permissions: document.getElementById('permissions').innerText.split('\\n'), status: document.getElementById('status').hidden ? '' : document.getElementById('status').textContent })`)
      await install.evaluate(`document.getElementById('install-button').click(); 'clicked'`)
      await waitFor(() => install.evaluate(`!document.getElementById('install-button').disabled || document.getElementById('install-button').hidden`), 60000)
      result.status = await install.evaluate(`document.getElementById('status').textContent`)
      await install.evaluate(`document.getElementById('cancel-button').click(); 'left'`)
      install.close()
      out.installs.push(result)
      await sleep(500)
    }

    // open a page in a new tab and collect what userscripts did there
    async function visit (name, url, checks, wait = 8000) {
      await uiPage.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 'ok'`)
      const target = await waitFor(async () => (await targets()).find(t => t.type === 'page' && t.url.startsWith(url.split('#')[0].split('?')[0])))
      const page = cdp(target.webSocketDebuggerUrl)
      await page.send('Runtime.enable')
      await page.send('Network.enable')
      await page.send('Page.reload')
      await sleep(wait)
      const result = {}
      result.checks = await page.evaluate(checks).catch(e => 'check failed: ' + e.message)
      result.menuCommands = await uiPage.evaluate(`(async () => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(url.split('?')[0])})); return tab ? (await ipc.invoke('userscripts-menu-commands', tab.id)).map(c => c.caption + ' / ' + c.scriptName) : 'no tab' })()`)
      result.userscriptErrors = page.events.filter(e => e.type !== 'request' && /userscript|Return YouTube|GitHub|GM_|GM\./i.test(e.text + ' ' + (e.url || '')))
      result.allErrors = page.events.filter(e => e.type === 'exception').length
      result.interestingRequests = page.events.filter(e => e.type === 'request' && /returnyoutubedislike/.test(e.url)).map(e => e.url).slice(0, 3)
      out.pages[name] = result
      page.close()
    }

    out.list = await uiPage.evaluate(`ipc.invoke('userscripts-list').then(l => l.map(s => s.name))`)
    await visit('youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw', `({
      dislikeText: (document.querySelector('#top-level-buttons-computed dislike-button-view-model, #segmented-dislike-button, ytd-segmented-like-dislike-button-renderer') || {}).innerText || null,
      rydStyle: Array.from(document.querySelectorAll('style')).some(s => /ryd-tooltip/.test(s.textContent))
    })`, 15000)
    await visit('githubFile', 'https://github.com/electron/electron/blob/main/README.md?plain=1', `({
      whitespaceButton: !!document.querySelector('.ghcsw-toggle, .ghcsw-toggle-whitespace, [class*="ghcsw"]'),
      styles: Array.from(document.querySelectorAll('style')).filter(s => /ghcsw|ghip|ghtx/.test(s.textContent)).length
    })`, 10000)
    await visit('githubTree', 'https://github.com/electron/electron/tree/main/docs/images', `({
      imagePreviewButton: !!document.querySelector('[class*="ghip"]'),
      styles: Array.from(document.querySelectorAll('style')).filter(s => /ghip/.test(s.textContent)).length
    })`, 10000)

    // Settings list as the user sees it
    await uiPage.evaluate(`ipc.emit('addTab', {}, { url: 'min://app/pages/settings/index.html' }); 'ok'`)
    const settingsTarget = await waitFor(async () => (await targets()).find(t => t.url.startsWith('min://app/pages/settings/')))
    const settingsPage = cdp(settingsTarget.webSocketDebuggerUrl)
    await sleep(2000)
    out.settingsList = await settingsPage.evaluate(`Array.from(document.querySelectorAll('.userscript-item')).map(i => i.innerText.replace(/\\s+/g, ' ').trim())`)
    settingsPage.close()
    uiPage.close()
  } catch (e) {
    out.error = String(e.stack || e)
  } finally {
    out.scriptFiles = fs.existsSync(path.join(profile, 'userscripts')) ? fs.readdirSync(path.join(profile, 'userscripts')) : []
    out.mainProcessOutput = t.childLog().split('\n').filter(l => /userscript/i.test(l)).slice(0, 30)
    fs.writeFileSync(t.output('observed.json'), JSON.stringify(out, null, 2))
    const { check } = t
    check('no script error', !out.error, out.error)
    check('all four scripts installed from their links', out.installs.length === 4 && out.installs.every(i => !i.error && /^Installed/.test(i.status || '')), out.installs.map(i => i.url + ': ' + (i.error || i.status)))
    check('installing turned userscripts on, and Min lists the four', JSON.stringify(out.list) === JSON.stringify(['GitHub Code Show Whitespace', 'GitHub Image Preview', 'GitHub Toggle Expanders', 'Return YouTube Dislike']), out.list)
    check('the four script files are in the profile', out.scriptFiles.length === 4, out.scriptFiles)
    check('Settings lists the four, from raw.githubusercontent.com', (out.settingsList || []).length === 4 && out.settingsList.every(i => i.includes('From raw.githubusercontent.com')), out.settingsList)
    const page = name => out.pages[name] || {}
    // the tab's menu commands, or [] when the tab wasn't found ('no tab': the page didn't load, a network failure)
    const commands = name => Array.isArray(page(name).menuCommands) ? page(name).menuCommands : []
    check('GitHub file page: the scripts added their styles', (page('githubFile').checks || {}).styles >= 1, page('githubFile').checks)
    check('GitHub file page: the whitespace script\'s menu command is offered', commands('githubFile').some(c => c.startsWith('Set GitHub Code White Space')), page('githubFile').menuCommands)
    check('GitHub folder page: the scripts added their styles', (page('githubTree').checks || {}).styles >= 1, page('githubTree').checks)
    check('no userscript errors on the pages', Object.values(out.pages).every(p => (p.userscriptErrors || []).length === 0), Object.fromEntries(Object.entries(out.pages).map(([k, p]) => [k, p.userscriptErrors])))
    check('YouTube with Return YouTube Dislike (info)', true, page('youtube').checks)
    t.finish()
  }
})()
