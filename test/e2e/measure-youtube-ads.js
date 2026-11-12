// YouTube ads with Min's own blocker (AGENTS.md section 10.2), in a brand-new profile: three videos each opened in a new
// tab (a fresh page load, where Min's scriptlets used to arrive after YouTube's own scripts had started), then from each,
// one click to another video inside YouTube (no page load). For every video: whether an ad played and for how long,
// how long until the video itself played, and whether the page's first player data still held ads when Min's scriptlets
// ran (adPlacements in ytInitialPlayerResponse: those scriptlets remove it before YouTube reads it, if they're in time),
// and whether a scriptlet got there before the page's own scripts (trapped: ytInitialPlayerResponse is an accessor).
// Also Min's processor time over the whole run (seconds, % of one core, % of all cores) and its memory (private and working
// set) while each video plays. MIN_TEST_OLD switches changes of this branch back for the run (old-behaviour.js):
// MIN_TEST_OLD=scriptletsAfterStart is how scriptlets came before 2026-11-09.
// YouTube rations ads per visitor, so compare runs of the same build, at least two each.
// usage: node test/e2e/measure-youtube-ads.js [label]     results: results/measure-youtube-ads[-label].json and -videos.json
// Needs the internet and an unlocked screen (a covered or locked window doesn't play video).
const label = process.argv[2] ? '-' + process.argv[2].replace(/[^a-z0-9-]/gi, '') : ''
const t = require('./harness')({ name: 'measure-youtube-ads' + label, minutes: 12, settings: { enableAutoplay: true } })
const { PAGE, sleep, check, finish, connect, list, waitFor, launch, quit, ui } = t
const old = require('./old-behaviour')(t)
const CPU = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const sum = l => l.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0); return { all: sum(m), main: sum(m.filter(x => x.type === 'Browser')) } })()"
const MEMORY = "(() => { const m = process.mainModule.require('electron').app.getAppMetrics(); const mb = k => Math.round(m.reduce((a, x) => a + (x.memory[k] || 0), 0) / 1024); return { allMB: mb('privateBytes'), workingSetMB: mb('workingSetSize') } })()"
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d
const VIDEOS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
  'https://www.youtube.com/watch?v=JGwWNGJdvx8'
]
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
const STATE = `(() => { const p = document.querySelector('#movie_player'); const v = document.querySelector('video')
  return { url: location.href, ad: !!(p && p.classList.contains('ad-showing')), time: v ? v.currentTime : -1 } })()`

/* global location, document */
// runs in the page: clicks a link to another video, as a viewer would (YouTube changes video without loading a page)
function clickAnotherVideo () {
  const here = new URL(location.href).searchParams.get('v')
  const link = Array.from(document.querySelectorAll('a[href*="/watch?v="]')).find(function (a) {
    try {
      const v = new URL(a.href).searchParams.get('v')
      return v && v !== here && a.offsetParent
    } catch (e) {
      return false
    }
  })
  if (!link) return null
  link.click()
  return link.href
}

// follows a video for up to 40 s: ad shown (and roughly how long), when the video itself got past 2 s
async function watch (c) {
  const start = Date.now()
  let adSeen = false; let adSeconds = 0; let playedAfterMs = null; let last = null
  while (Date.now() - start < 40000) {
    const s = await c.evaluate(STATE)
    if (s && typeof s === 'object') {
      last = s
      if (s.ad) { adSeen = true; adSeconds += 0.5 }
      if (!s.ad && s.time > 2 && playedAfterMs === null) playedAfterMs = Date.now() - start
      if (playedAfterMs !== null) break
    }
    await sleep(500)
  }
  return { adSeen, adSecondsApprox: adSeconds, playedAfterMs, last }
}

;(async () => {
  const results = []
  try {
    const main = await launch(PAGE)
    const u = await ui()
    await sleep(2000)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    check('screen unlocked (info)', true, { screenLocked: t.isScreenLocked() })
    // how long the page waits for main's answer as it starts (page-start: the scriptlets and its userscripts); whether they came
    // in time shows as firstPlayerData.trapped
    await main.evaluate(`(() => { const ipc = process.mainModule.require('electron').ipcMain; global.__scriptletsHanded = []
      for (const fn of ipc.listeners('page-start')) { ipc.removeListener('page-start', fn)
        ipc.on('page-start', function (event, url) { const start = Date.now(); fn(event, url); __scriptletsHanded.push({ url: String(url).slice(0, 60), mainMs: Date.now() - start }) }) }
      return ipc.listeners('page-start').length })()`)
    const cpuStart = await main.evaluate(CPU)
    const wallStart = Date.now()
    const memoryWhilePlaying = []
    for (const url of VIDEOS) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
      const target = await waitFor(async () => (await list()).find(x => x.url.startsWith(url) && x.type === 'page'), 20000)
      if (!target) {
        results.push({ url, error: 'tab not found' })
        continue
      }
      const c = connect(target.webSocketDebuggerUrl)
      // the page's first player data, read as soon as the page has it
      const firstData = await waitFor(() => c.evaluate('window.ytInitialPlayerResponse ? { adPlacements: Array.isArray(ytInitialPlayerResponse.adPlacements) && ytInitialPlayerResponse.adPlacements.length > 0, playerAds: !!ytInitialPlayerResponse.playerAds, trapped: typeof (Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse") || {}).get === "function" } : null'), 15000)
      const fresh = await watch(c)
      memoryWhilePlaying.push(await main.evaluate(MEMORY))
      // one click to another video, inside YouTube
      const next = await c.evaluate('(' + clickAnotherVideo.toString() + ')()')
      await sleep(1500)
      const inApp = next ? await watch(c) : { error: 'no other video to click' }
      const navigated = await c.evaluate('location.href')
      c.close()
      const entry = { url, firstPlayerData: firstData, fresh, inApp: Object.assign({ clicked: next, nowAt: navigated, reloaded: false }, inApp) }
      console.log('VIDEO ' + JSON.stringify(entry))
      results.push(entry)
      const tabId = await u.evaluate("(tabs.get().find(x => x.url.includes('youtube.com')) || {}).id")
      if (tabId) await u.evaluate(`ipc.emit('extensions-close-tab', {}, ${JSON.stringify(tabId)}); 1`)
      await sleep(1000)
    }
    const fresh = results.filter(r => r.fresh)
    const inApp = results.filter(r => r.inApp && !r.inApp.error)
    check('fresh tabs: videos that showed an ad (info)', true, { ads: fresh.filter(r => r.fresh.adSeen).length + ' of ' + fresh.length, adDataReachedPlayer: fresh.filter(r => r.firstPlayerData && r.firstPlayerData.adPlacements).length + ' of ' + fresh.length })
    check('in-app clicks: videos that showed an ad (info)', true, { ads: inApp.filter(r => r.inApp.adSeen).length + ' of ' + inApp.length })
    check('every video played (info)', true, results.map(r => [r.fresh && r.fresh.playedAfterMs, r.inApp && r.inApp.playedAfterMs]))
    check('scriptlets handed to pages as they started (info)', true, await main.evaluate('global.__scriptletsHanded || null'))
    const cpuEnd = await main.evaluate(CPU)
    const wall = (Date.now() - wallStart) / 1000
    const cores = require('os').cpus().length
    check('processor time and memory (info)', true, { old, allSeconds: round(cpuEnd.all - cpuStart.all), mainSeconds: round(cpuEnd.main - cpuStart.main, 2), wallSeconds: round(wall), percentOfOneCore: round((cpuEnd.all - cpuStart.all) / wall * 100), percentOfAllCores: round((cpuEnd.all - cpuStart.all) / wall / cores * 100, 2), memoryWhilePlaying, adSeconds: results.reduce((a, r) => a + ((r.fresh && r.fresh.adSecondsApprox) || 0) + ((r.inApp && r.inApp.adSecondsApprox) || 0), 0) })
    require('fs').writeFileSync(t.output('videos.json'), JSON.stringify(results, null, 2))
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
