// A new user's first start: with no ad-block engine in the profile, Min downloads the full lists (EasyList, EasyPrivacy,
// Peter Lowe's, uBlock Origin's) and saves the engine, instead of falling back to the small bundled list for an hour.
// Then a restart loads the saved engine without downloading again. Needs the internet (about 6 MB).
const path = require('path')
const fs = require('fs')
const t = require('./harness')({ name: 'adblock-first-start', minutes: 6, adblockEngine: false })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit } = t
const ENGINE = path.join(t.profileDir, 'adblocker-engine-v2.bin')
const engineSize = () => { try { return fs.statSync(ENGINE).size } catch (e) { return 0 } }
// an EasyPrivacy tracker that's blocked outright (pitfall 27), and a request that isn't blocked, to tell a block from no network
const TRACKER = 'https://sb.scorecardresearch.com/b?c1=2&c2=1'
const CONTROL = 'https://www.example.com/'
const request = (page, url) => page.evaluate(`fetch(${JSON.stringify(url)}, { mode: 'no-cors', cache: 'no-store' }).then(() => 'loaded', e => 'failed: ' + e.message)`)
const fallbackMessages = log => log.split(/\r?\n/).filter(line => /bundled filter list|Session can only be received|Failed to (download|update) adblocker/i.test(line))

;(async () => {
  let main
  try {
    check('the profile starts without an ad-block engine', engineSize() === 0)
    main = await launch(PAGE)
    const started = Date.now()
    const size = await waitFor(() => engineSize() > 3000000 && engineSize(), 120000)
    check('the full lists were downloaded and the engine saved (the bundled list is never saved)', size, { bytes: engineSize(), seconds: Math.round((Date.now() - started) / 1000) })
    await sleep(1000)
    const fallbacks = fallbackMessages(t.childLog())
    check('no fallback to the bundled list, no "Session can only be received when app is ready"', fallbacks.length === 0, fallbacks.slice(0, 3))
    let page = await target(p => p.url.startsWith(PAGE) && p.type === 'page')
    check('the tracker is blocked on the first start, other requests load', page && (await request(page, TRACKER)).startsWith('failed') && (await request(page, CONTROL)) === 'loaded', page && { tracker: await request(page, TRACKER), control: await request(page, CONTROL) })
    if (page) page.close()
    await quit(main)

    // a restart uses the saved engine: no new download, blocking from the first page
    const savedAt = engineSize() ? fs.statSync(ENGINE).mtimeMs : 0
    main = await launch(PAGE)
    page = await target(p => p.url.startsWith(PAGE) && p.type === 'page')
    const blockedAtRestart = page && await waitFor(async () => (await request(page, TRACKER)).startsWith('failed'), 10000)
    check('after a restart: the tracker is blocked straight away', blockedAtRestart, page && await request(page, TRACKER))
    await sleep(5000)
    check('after a restart: the saved engine isn\'t downloaded again', savedAt > 0 && engineSize() > 0 && fs.statSync(ENGINE).mtimeMs === savedAt && fallbackMessages(t.childLog()).length === 0)
    if (page) page.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
