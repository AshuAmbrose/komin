// The Performance settings' defaults in the dev build: trimming on, the JavaScript option off (no --optimize-for-size),
// hiding ad spaces while pages load off (pages are told so as they start); ticking the JavaScript option saves true and
// shows the restart notice, and after a restart the flag is there; ticking the ad-spaces option saves true, needs no
// restart, and the next page is told at once.
const path = require('path')
const fs = require('fs')
const t = require('./harness')({ name: 'performance-defaults', minutes: 5 })
const { PAGE, sleep, check, finish, target, launch, quit, ui } = t
const SETTINGS = 'min://app/pages/settings/index.html'
const SETTINGS_FILE = path.join(t.profileDir, 'settings.json')
const savedSetting = key => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))[key] } catch (e) { return 'unreadable' } }
const flags = main => main.evaluate("process.mainModule.require('electron').app.commandLine.getSwitchValue('js-flags')")
// what main tells a page as it starts (main/filtering.js, cosmetic-filters-start), asked as the page's preload asks
const startAnswer = main => main.evaluate(`new Promise(resolve => {
  const e = process.mainModule.require('electron')
  const wc = e.webContents.getAllWebContents().find(w => w.getURL().startsWith('http'))
  const event = { sender: wc, set returnValue (v) { resolve(v) } }
  e.ipcMain.emit('cosmetic-filters-start', event, 'https://news.example.org/')
})`)
async function openSettings (u) {
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SETTINGS)} }); 1`)
  const s = await target(t => t.url.startsWith(SETTINGS) && t.type === 'page', 15000)
  await sleep(2500)
  return s
}
const boxes = s => s.evaluate("({ trim: document.getElementById('checkbox-trim-background-tabs').checked, js: document.getElementById('checkbox-optimize-javascript').checked, adSpaces: document.getElementById('checkbox-hide-ad-spaces-while-loading').checked, banner: !document.getElementById('restart-required-banner').hidden })")
;(async () => {
  let main
  try {
    const before = { trim: savedSetting('trimBackgroundTabs'), js: savedSetting('optimizeJavaScriptForSize'), adSpaces: savedSetting('hideAdSpacesWhileLoading') }
    check('the profile has none of the settings saved (defaults apply)', before.trim === undefined && before.js === undefined && before.adSpaces === undefined, before)
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    check('default: no --optimize-for-size', (await flags(main)) === '', await flags(main))
    const defaultAnswer = await startAnswer(main)
    check('default: pages are told to watch for ad spaces once they have arrived (whileLoading false)', !!defaultAnswer && defaultAnswer.whileLoading === false, defaultAnswer)
    let s = await openSettings(u)
    const first = await boxes(s)
    check('Settings: trimming ticked, JavaScript and ad-spaces options not ticked, no restart notice', first.trim === true && first.js === false && first.adSpaces === false && first.banner === false, first)
    await s.evaluate("document.getElementById('checkbox-optimize-javascript').click(); 1")
    await sleep(800)
    const ticked = { saved: savedSetting('optimizeJavaScriptForSize'), banner: (await boxes(s)).banner }
    check('ticking the JavaScript option saves true and shows the restart notice', ticked.saved === true && ticked.banner === true, ticked)
    await s.evaluate("document.getElementById('checkbox-hide-ad-spaces-while-loading').click(); 1")
    await sleep(800)
    const adSpaces = { saved: savedSetting('hideAdSpacesWhileLoading'), answer: await startAnswer(main) }
    check('ticking the ad-spaces option saves true, and the next page is told at once (no restart)', adSpaces.saved === true && !!adSpaces.answer && adSpaces.answer.whileLoading === true, adSpaces)
    s.close()
    u.close()
    await quit(main)

    main = await launch(PAGE)
    u = await ui()
    await sleep(1500)
    check('after a restart: --optimize-for-size is on', (await flags(main)) === '--optimize-for-size', await flags(main))
    s = await openSettings(u)
    const second = await boxes(s)
    check('Settings after the restart: all three ticked', second.trim === true && second.js === true && second.adSpaces === true, second)
    s.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
