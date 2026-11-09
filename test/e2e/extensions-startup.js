// Phase 7: tabs restored at startup wait for extensions to load, so content scripts run in them without a reload.
// Eight real extensions (so loading takes a while) plus the basic test extension, whose content script marks pages;
// three tabs; two restarts.
const t = require('./harness')({ name: 'extensions-startup', minutes: 8, extensions: ['eimadpbcbfnmbkopoojfekhnkhdbieeh', 'nngceckbapebfimnlniiiahkandclblb', 'ddkjiahejlhfcafbddmgiahcphecmpfh', 'gebbhagfogifgggkldgodflihgfeippi', 'mnjggcdmjocbbbhaepdhchncahnbgone', 'fihnjjcciajhdojfnbdddfaoknhalnja', 'hlkenndednhfkekhgcdicdfddnkalmdm', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp'] })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const BASIC = t.extension('basic')
const CRX = ['eimadpbcbfnmbkopoojfekhnkhdbieeh', 'nngceckbapebfimnlniiiahkandclblb', 'ddkjiahejlhfcafbddmgiahcphecmpfh', 'gebbhagfogifgggkldgodflihgfeippi', 'mnjggcdmjocbbbhaepdhchncahnbgone', 'fihnjjcciajhdojfnbdddfaoknhalnja', 'hlkenndednhfkekhgcdicdfddnkalmdm', 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp']
  .map(id => t.crx(id))
const restored = n => PAGE + '?restored' + n
const marks = async () => {
  const result = {}
  for (const n of [1, 2, 3]) {
    const t = await target(x => x.url === restored(n) && x.type === 'page', 15000)
    result[n] = t ? await waitFor(() => t.evaluate('document.documentElement.dataset.minTestExtension || null'), 5000) : 'no tab'
    if (t) t.close()
  }
  return result
}
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(BASIC)}; 1`)
    console.log('basic', await s.evaluate("extensionPages.request('load-unpacked')"))
    for (const crx of CRX) {
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(crx)}; 1`)
      console.log('installed', await s.evaluate("extensionPages.request('install-crx').catch(e => 'ERROR ' + e.message)"))
    }
    // network filtering stays off, so that Min's ad blocker isn't swapped out (not what's tested here)
    await u.evaluate("settings.set('extensionsFilterNetwork', false); 1")
    // only the three test tabs are restored
    await u.evaluate("(() => { tabs.get().forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); return 1 })()")
    for (const n of [1, 2, 3]) {
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(restored(n))} }); 1`)
    }
    await sleep(3000)
    check('before restarting: the content script ran in every tab', Object.values(await marks()).every(m => m === 'ran'))
    // session restore saves every 30 s
    await sleep(32000)
    s.close()
    u.close()
    for (const run of [1, 2]) {
      await quit(main)
      main = await launch(PAGE + '?start' + run)
      u = await ui()
      await sleep(6000)
      // the page Min opens with loads at startup, while extensions load; restored tabs load when selected
      const first = await target(x => x.url === PAGE + '?start' + run && x.type === 'page', 15000)
      const mark = first ? await waitFor(() => first.evaluate('document.documentElement.dataset.minTestExtension || null'), 5000) : 'no tab'
      const model = await u.evaluate('tasks.map(task => task.tabs.get().map(t => t.url)).flat()')
      check('restart ' + run + ': the first page has the content script without a reload; the three tabs are restored', mark === 'ran' && [1, 2, 3].every(n => model.includes(restored(n))), { mark, model })
      if (first) first.close()
      u.close()
    }
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
