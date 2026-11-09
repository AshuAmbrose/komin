// Do YouTube extensions do their job in Min? Return YouTube Dislike should put a dislike count on the video page, and
// SponsorBlock its own button in the player. Screenshots of the page beside the results.
// usage: node test/e2e/extensions-youtube.js [noblock]    noblock: with Min's ad blocking off
const t = require('./harness')({ name: 'extensions-youtube', minutes: 8, extensions: ['gebbhagfogifgggkldgodflihgfeippi', 'mnjggcdmjocbbbhaepdhchncahnbgone'] })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const RYD = t.crx('gebbhagfogifgggkldgodflihgfeippi')
const SPONSORBLOCK = t.crx('mnjggcdmjocbbbhaepdhchncahnbgone')
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    await main.evaluate(`(() => { const electron = process.mainModule.require('electron'); global.__ytLogs = []; electron.app.on('web-contents-created', (e, wc) => wc.on('console-message', (event) => { if (/youtube/.test(wc.getURL()) && global.__ytLogs.length < 200) global.__ytLogs.push(String(event.level) + ' ' + String(event.message).slice(0, 300) + ' @' + String(event.sourceId).slice(0, 90)) })); return 1 })()`)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    for (const crx of [RYD, SPONSORBLOCK]) {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx)}; 1`)
      console.log('installed', await s.evaluate("extensionPages.request('install-crx').catch(e => 'ERROR ' + e.message)"))
    }
    await sleep(4000)
    const workers = await main.evaluate("Object.values(process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.getAllRunning()).map(w => w.scope)")
    check('both workers run', workers.some(w => w.includes('gebbhagfogifgggkldgodflihgfeippi')) && workers.some(w => w.includes('mnjggcdmjocbbbhaepdhchncahnbgone')), workers)
    if (process.argv[2] === 'noblock') {
      // the UI's settings module isn't a global (pitfall 40): main saves the setting and tells the windows
      await u.evaluate("ipc.send('settingChanged', 'filtering', { blockingLevel: 0, contentTypes: [], exceptionDomains: [] }); ipc.emit('settingChanged', {}, 'filtering', { blockingLevel: 0, contentTypes: [], exceptionDomains: [] }); 1")
      await sleep(1000)
      console.log('ad blocking off')
    }
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(VIDEO)} }); 1`)
    const yt = await target(t => t.url.startsWith(VIDEO) && t.type === 'page', 20000)
    await sleep(15000)
    const state = yt && await yt.evaluate(`(() => {
      const likes = document.querySelector('segmented-like-dislike-button-view-model, #segmented-like-dislike-button, ytd-segmented-like-dislike-button-renderer')
      return {
        likeArea: likes ? likes.innerText.replace(/\\s+/g, ' ').slice(0, 80) : 'not found',
        sponsorBlockButton: !!document.querySelector('#startSegmentButton, .playerButton, #sponsorBlockPopupContainer, [id^="sponsorblock"]'),
        title: document.title
      }
    })()`)
    console.log(JSON.stringify(state))
    await main.evaluate(`(async () => { const electron = process.mainModule.require('electron'); const wc = electron.webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(VIDEO)})); const image = await wc.capturePage(); process.mainModule.require('fs').writeFileSync(${JSON.stringify(t.output('page.png'))}, image.toPNG()); return 1 })()`)
    check('Return YouTube Dislike shows a dislike count', state && /\d.*\d/.test(state.likeArea), state)
    check('SponsorBlock adds its player button', state && state.sponsorBlockButton, state)
    const logs = await main.evaluate('global.__ytLogs')
    console.log(logs.filter(l => /Unsafe|chrome-extension|Error/i.test(l)).slice(0, 20).join('\n'))
    s.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
