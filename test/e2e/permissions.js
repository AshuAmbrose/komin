// What websites get from Min's permission manager (main/permissionManager.js, section 10.3) where web-platform-tests
// showed Min differs from the standard and from Chrome (2026-11-14):
//   - notifications on a page that isn't secure (http: on a real host name): the standard says "denied" without asking,
//     and Chrome does that; Min showed its permission bar, and a saved "allow" for the host name (saved for its https:
//     pages, say: Min keys permissions by host name) counted for http: too
//   - on a secure page (localhost counts, as in Chrome) the bar still asks
// The insecure host names are mapped to the suite's own server with --host-resolver-rules, so nothing leaves the computer.
const http = require('http')

const PORT = 8792
const INSECURE = `http://insecure.test:${PORT}`
const INSECURE_ALLOWED = `http://allowed.test:${PORT}` // the user allowed notifications for allowed.test (its https: pages)
const SECURE = `http://localhost:${PORT}` // localhost is a secure context

const t = require('./harness')({
  name: 'permissions',
  minutes: 6,
  settings: { sitePermissions: { 'allowed.test': { notifications: 'allow' } } }
})
const { sleep, check, finish, target, waitFor, launch, ui } = t

// a page that asks for notifications at once and puts the answer in its title
const ASK = `<!doctype html><title>waiting</title><script>
document.title = 'permission:' + Notification.permission
Notification.requestPermission().then(function (answer) { document.title = 'answer:' + answer })
</script>`
const server = http.createServer(function (req, res) {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(req.url.startsWith('/ask') ? ASK : '<!doctype html><title>start</title>')
}).listen(PORT, '127.0.0.1')

const pageTarget = (prefix, ms = 10000) => target(x => x.type === 'page' && x.url.startsWith(prefix), ms)
const openTab = (u, url) => u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
const closeTabsStartingWith = (u, prefix) => u.evaluate(`tabs.get().filter(t => t.url.startsWith(${JSON.stringify(prefix)})).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1`)
// the permission bar (shown for the selected tab) and the waiting-request icons on tabs
const promptShown = u => u.evaluate("(() => { const bar = document.getElementById('permission-request-bar'); return { bar: bar && !bar.hidden ? bar.innerText.trim().slice(0, 200) : null, icons: document.querySelectorAll('.permission-request-icon').length } })()")

async function ask (u, origin) {
  await openTab(u, origin + '/ask')
  const page = await pageTarget(origin + '/ask')
  // the answer, or null while the request waits for the user
  const answer = await waitFor(async () => { const v = await page.evaluate('document.title'); return v.startsWith('answer:') ? v.slice(7) : null }, 5000)
  const before = await page.evaluate('document.title')
  const prompt = await promptShown(u)
  page.close()
  await closeTabsStartingWith(u, origin)
  await sleep(500)
  return { answer, title: before, prompt }
}

;(async () => {
  try {
    await launch(SECURE + '/start', { args: ['--host-resolver-rules=MAP insecure.test 127.0.0.1, MAP allowed.test 127.0.0.1'] })
    const u = await ui()
    await sleep(1500)

    const insecure = await ask(u, INSECURE)
    check('notifications: an http: page gets "denied" without Min\'s permission bar', insecure.answer === 'denied' && !insecure.prompt.bar && insecure.prompt.icons === 0, insecure)

    const allowed = await ask(u, INSECURE_ALLOWED)
    check('notifications: a saved "allow" for the host name doesn\'t count on its http: pages', allowed.answer === 'denied' && !allowed.title.includes('permission:granted'), allowed)

    const secure = await ask(u, SECURE)
    check('notifications: a secure page (localhost) still gets the permission bar', secure.answer === null && (Boolean(secure.prompt.bar) || secure.prompt.icons > 0), secure)

    u.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  server.close()
  finish()
})()
