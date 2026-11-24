// The ad blocker's network rules on requests, with Min's real lists (the harness's cached engine), without the internet:
// the names are mapped to the suite's own server with --host-resolver-rules, which records the address each request
// arrived with.
//   - tracking parameters ($removeparam, section 10.2): the engine works out the address without them (its `rewrite`),
//     which Min ignored until 2026-11-17. A page address (the lists' $removeparam=srsltid and =gad_source, Google's, on
//     every site; Min's own list lacks them) and a request from a page (||wuzhuiso.com^$removeparam=src) lose them; other
//     parameters stay; a page's own fetch() sees the address it arrived at (AdGuard's test page checks that). Min's own
//     list (removeTrackingParams: utm_source and the like) still applies. (reddit.com's
//     rules can't be tried here: Chromium only lets reddit.com load over HTTPS, and the suite's server is HTTP)
// `node test/e2e/adblock-network.js online` also tries a real HTTPS site (needs the internet): AdGuard's test site's echo
// address, fetched from its own page with a tracking parameter Min's own list removes (utm_source) and one only the lists'
// rules name (gclid): AdGuard's $removeparam test page got "Failed to fetch" there in Min (2026-11-17)
const ONLINE = process.argv.includes('online')
const http = require('http')

const PORT = 8794
const t = require('./harness')({ name: 'adblock-network' + (ONLINE ? '-online' : ''), minutes: 5 })
const { sleep, check, finish, target, launch, ui } = t

const seen = []
const server = http.createServer(function (req, res) {
  seen.push(req.headers.host.split(':')[0] + req.url)
  if (req.url.startsWith('/api')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ arrived: req.url }))
    return
  }
  if (req.url.startsWith('/pixel')) {
    res.writeHead(200, { 'content-type': 'image/gif' })
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>page</title><img src="http://wuzhuiso.com:${PORT}/pixel?src=tracker&keep=1">`)
}).listen(PORT, '127.0.0.1')

const seenFor = (host, path) => seen.filter(u => u.startsWith(host + path))

;(async () => {
  try {
    await launch(`http://127.0.0.1:${PORT}/start`, { args: ['--host-resolver-rules=MAP shop.example.org 127.0.0.1, MAP wuzhuiso.com 127.0.0.1, MAP news.example.org 127.0.0.1'] })
    const u = await ui()
    await sleep(1500)

    // a page address with tracking parameters
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'http://shop.example.org:${PORT}/item?srsltid=abc&gad_source=1&keep=1' }); 1`)
    await target(x => x.type === 'page' && x.url.startsWith(`http://shop.example.org:${PORT}/item`), 10000)
    await sleep(1500)
    const page = seenFor('shop.example.org', '/item')
    check('tracking parameters: a page address loses those the lists name, keeps the rest', page.length > 0 && page.every(x => !/srsltid=|gad_source=/.test(x)) && page.some(x => x.includes('keep=1')), page)

    // a page's fetch() of its own site: the request, and the address the page sees in the answer
    const shop = await target(x => x.type === 'page' && x.url.startsWith(`http://shop.example.org:${PORT}/item`), 10000)
    const fetched = await shop.evaluate("fetch('/api?srsltid=abc&keep=1').then(r => r.json().then(j => ({ responseURL: r.url, arrived: j.arrived })), e => ({ error: String(e) }))")
    check('tracking parameters: a page\'s fetch() arrives without them, and the page sees that address', fetched && fetched.arrived === '/api?keep=1' && /\/api\?keep=1$/.test(fetched.responseURL || ''), fetched)

    // a request from a page
    const pixel = seenFor('wuzhuiso.com', '/pixel')
    check('tracking parameters: a request from a page loses those the lists name, keeps the rest', pixel.length > 0 && pixel.every(x => !x.includes('src=')) && pixel.some(x => x.includes('keep=1')), pixel)

    // Min's own list
    await u.evaluate(`ipc.emit('addTab', {}, { url: 'http://news.example.org:${PORT}/story?utm_source=mail&id=7' }); 1`)
    await target(x => x.type === 'page' && x.url.startsWith(`http://news.example.org:${PORT}/story`), 10000)
    await sleep(1000)
    const own = seenFor('news.example.org', '/story')
    check('tracking parameters: Min\'s own list still applies (utm_source)', own.length > 0 && own.every(x => !x.includes('utm_source')) && own.some(x => x.includes('id=7')), own)
    if (ONLINE) {
      await u.evaluate("ipc.emit('addTab', {}, { url: 'https://testcases.agrd.dev/Filters/removeparam-rules/test-removeparam-rules.html' }); 1")
      const agPage = await target(x => x.type === 'page' && x.url.startsWith('https://testcases.agrd.dev/Filters/removeparam-rules/'), 20000)
      await sleep(2000)
      const probe = async query => agPage.evaluate(`fetch('/httpbin/anything/?${query}', { headers: { Accept: 'text/html' } }).then(r => r.json().then(j => ({ responseURL: r.url, args: Object.keys(j.args || {}) })), e => ({ error: String(e) }))`)
      const results = { none: await probe('keep=1'), ownList: await probe('utm_source=x&keep=1'), listsOnly: await probe('gclid=x&keep=1') }
      check('online: a real HTTPS site\'s fetch() with tracking parameters (info)', true, results)
    }
    u.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  server.close()
  finish()
})()
