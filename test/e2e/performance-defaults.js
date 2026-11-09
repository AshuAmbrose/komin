// The Performance settings' defaults in the dev build: trimming on, the JavaScript option off (no --optimize-for-size);
// ticking the JavaScript option saves true and shows the restart notice, and after a restart the flag is there.
const path = require('path')
const fs = require('fs')
const t = require('./harness')({ name: 'performance-defaults', minutes: 5 })
const { PAGE, sleep, check, finish, target, launch, quit, ui } = t
const SETTINGS = 'min://app/pages/settings/index.html'
const SETTINGS_FILE = path.join(t.profileDir, 'settings.json')
const savedSetting = key => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))[key] } catch (e) { return 'unreadable' } }
const flags = main => main.evaluate("process.mainModule.require('electron').app.commandLine.getSwitchValue('js-flags')")
async function openSettings (u) {
  await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SETTINGS)} }); 1`)
  const s = await target(t => t.url.startsWith(SETTINGS) && t.type === 'page', 15000)
  await sleep(2500)
  return s
}
const boxes = s => s.evaluate("({ trim: document.getElementById('checkbox-trim-background-tabs').checked, js: document.getElementById('checkbox-optimize-javascript').checked, banner: !document.getElementById('restart-required-banner').hidden })")
;(async () => {
  let main
  try {
    const before = { trim: savedSetting('trimBackgroundTabs'), js: savedSetting('optimizeJavaScriptForSize') }
    check('the profile has neither setting saved (defaults apply)', before.trim === undefined && before.js === undefined, before)
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    check('default: no --optimize-for-size', (await flags(main)) === '', await flags(main))
    let s = await openSettings(u)
    const first = await boxes(s)
    check('Settings: trimming ticked, JavaScript option not ticked, no restart notice', first.trim === true && first.js === false && first.banner === false, first)
    await s.evaluate("document.getElementById('checkbox-optimize-javascript').click(); 1")
    await sleep(800)
    const ticked = { saved: savedSetting('optimizeJavaScriptForSize'), banner: (await boxes(s)).banner }
    check('ticking the JavaScript option saves true and shows the restart notice', ticked.saved === true && ticked.banner === true, ticked)
    s.close()
    u.close()
    await quit(main)

    main = await launch(PAGE)
    u = await ui()
    await sleep(1500)
    check('after a restart: --optimize-for-size is on', (await flags(main)) === '--optimize-for-size', await flags(main))
    s = await openSettings(u)
    const second = await boxes(s)
    check('Settings after the restart: both ticked', second.trim === true && second.js === true, second)
    s.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
