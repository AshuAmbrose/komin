// What extensions see of Min's tabs (AGENTS.md section 10.9), as tab managers (OneTab, Session Buddy) rely on it:
//   - every tab of the window, in Min's order (tabs.query's index), whatever order they were opened in;
//   - a tab's index is its place in the window, also when the query matches only that tab;
//   - a tab without a loaded page (hibernated, or restored and not shown yet) is still listed, as Chrome lists a
//     discarded tab, and hibernating or waking it isn't reported as the tab closing;
//   - an extension can act on such a tab as in Chrome (tab suspenders and session managers do): muting it is kept,
//     reloading it loads it again in the background, activating it shows it, and going back in it is refused, not a crash.
//   - main/extensionTabs.js found the library internals it uses (it would turn itself off and say so in Min's log).
// electron-workarounds checks that the library alone still needs all this.
// Test extension: extensions/tabs (records every tab event).
const t = require('./harness')({ name: 'extensions-tabs', minutes: 7 })
const { PAGE, sleep, check, finish, target, waitFor, launch, quit, ui } = t
const TABS = t.extension('tabs')
const page = name => PAGE + '?' + name
// Min's order as extensions should see it: the window's task, then tasks shown in no window (after a restart Min opens a new
// task by default and keeps the old tabs in one of those)
const minOrder = u => u.evaluate("tasks.filter(task => task.selectedInWindow === windowId).concat(tasks.filter(task => !task.selectedInWindow)).flatMap(task => task.tabs.get()).filter(t => t.url.startsWith('http')).map(t => t.url)")
const urlsOf = list => (list || []).filter(x => x.url && x.url.startsWith('http')).map(x => x.url)
const idOf = (u, name) => u.evaluate(`tabs.get().find(t => t.url === ${JSON.stringify(page(name))}).id`)
const select = async (u, name) => { await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(await idOf(u, name))}); 1`); await sleep(1500) }

;(async () => {
  let main
  try {
    main = await launch(page('a'))
    let u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(TABS)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    check('test extension loaded', /^[a-p]{32}$/.test(id), id)
    s.close()
    await u.evaluate("ipc.emit('extensions-close-tab', {}, tabs.get().find(t => t.url.startsWith('min://app/pages/settings/')).id); 1")
    await select(u, 'a')
    let w = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)

    // three tabs opened in the background from tab a: Min puts each right after the current tab, so the window's
    // order (a, d, c, b) isn't the order they were opened in
    for (const name of ['b', 'c', 'd']) {
      await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'open-${name}', url: ${JSON.stringify(page(name))}, active: false }); 1`)
      await sleep(2000)
    }
    let order = await minOrder(u)
    let seen = await w.evaluate('listTabs()')
    check('the window\'s tabs, in Min\'s order', JSON.stringify(urlsOf(seen)) === JSON.stringify(order), { min: order, extension: seen })

    // the shown tab's index, asked on its own
    await select(u, 'c')
    const active = await w.evaluate('listTabs({ active: true, currentWindow: true })')
    order = await minOrder(u)
    check('the active tab\'s index is its place in the window', active.length === 1 && active[0].url === page('c') && active[0].index === order.indexOf(page('c')), { active, min: order })

    // a tab hibernated (what Min does to a tab unused for 15 minutes): still listed, not reported closed
    await select(u, 'a')
    const before = await w.evaluate('listTabs()')
    const b = before.find(x => x.url === page('b'))
    await w.evaluate('self.events = []; 1')
    await u.evaluate(`ipc.emit('hibernateTab', {}, ${JSON.stringify(await idOf(u, 'b'))}); 1`)
    await sleep(1500)
    const hibernated = await w.evaluate('listTabs()')
    const hEvents = await w.evaluate('self.events')
    const bAfter = hibernated.find(x => x.url === page('b'))
    check('hibernated: still listed, as discarded, in its place', !!b && !!bAfter && bAfter.discarded === true && JSON.stringify(urlsOf(hibernated)) === JSON.stringify(await minOrder(u)), { before: b, after: bAfter, list: hibernated })
    check('hibernated: not reported as closed', !!b && !hEvents.some(e => e.type === 'removed' && e.id === b.id), hEvents)

    // woken up again: the extension still knows which tab it is
    await w.evaluate('self.events = []; 1')
    await select(u, 'b')
    const woken = (await w.evaluate('listTabs()')).find(x => x.url === page('b'))
    const wEvents = await w.evaluate('self.events')
    const sameTab = !!b && !!woken && (woken.id === b.id || wEvents.some(e => e.type === 'replaced' && e.removed === b.id && e.added === woken.id))
    check('woken: the same tab id, or onReplaced from the old one', sameTab && woken.discarded === false && !wEvents.some(e => e.type === 'removed' && e.id === b.id), { before: b, woken, events: wEvents })
    await select(u, 'a')

    // an extension acting on a hibernated tab
    const hibernate = async name => { await u.evaluate(`ipc.emit('hibernateTab', {}, ${JSON.stringify(await idOf(u, name))}); 1`); await sleep(1500) }
    const listed = async name => (await w.evaluate('listTabs()')).find(x => x.url === page(name))
    const shown = () => u.evaluate('tabs.get(tabs.getSelected()).url')
    await hibernate('c')
    const c = await listed('c')
    await w.evaluate('self.events = []; 1')
    const muted = await w.evaluate(`chrome.tabs.update(${c && c.id}, { muted: true }).then(tab => tab && tab.mutedInfo && tab.mutedInfo.muted)`)
    await sleep(700)
    const mutedInMin = await u.evaluate(`tabs.get(${JSON.stringify(await idOf(u, 'c'))}).muted`)
    check('hibernated: muted by the extension, which Min keeps with the tab', !!c && c.discarded === true && muted === true && mutedInMin === true, { tab: c, extension: muted, min: mutedInMin })
    // the library answers a refused call with nothing and logs the error in the extension's console
    const back = await w.evaluate(`chrome.tabs.goBack(${c && c.id}).then(result => result === undefined ? 'refused' : result, e => 'refused: ' + e.message)`)
    check('hibernated: going back is refused, and Min keeps running', String(back).startsWith('refused') && (await listed('c')) !== undefined, back)
    await w.evaluate(`chrome.tabs.reload(${c && c.id}).then(() => 1)`)
    await sleep(2500)
    const cLoaded = await listed('c')
    const reloadEvents = await w.evaluate('self.events')
    check('hibernated: reloaded by the extension, it loads again in the background, as the same tab', !!c && !!cLoaded && cLoaded.discarded === false && reloadEvents.some(e => e.type === 'replaced' && e.removed === c.id && e.added === cLoaded.id) && !reloadEvents.some(e => e.type === 'removed') && (await shown()) === page('a'), { before: c, after: cLoaded, events: reloadEvents, shown: await shown() })
    await hibernate('d')
    const d = await listed('d')
    await w.evaluate(`chrome.tabs.update(${d && d.id}, { active: true }).then(() => 1)`)
    await sleep(2500)
    const dShown = await listed('d')
    check('hibernated: activated by the extension, it is shown', !!d && d.discarded === true && !!dShown && dShown.discarded === false && dShown.active === true && (await shown()) === page('d'), { before: d, after: dShown, shown: await shown() })
    await select(u, 'a')
    u.close()
    w.close()
    await quit(main)

    // after a restart only the shown tab has its page loaded: the others are listed too, as discarded
    main = await launch(page('e'))
    u = await ui()
    await sleep(3000)
    w = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
    order = await minOrder(u)
    seen = await w.evaluate('listTabs()')
    check('after a restart: every restored tab listed, in Min\'s order', order.length === 5 && JSON.stringify(urlsOf(seen)) === JSON.stringify(order), { min: order, extension: seen })
    check('after a restart: tabs not loaded yet count as discarded', seen.length > 1 && seen.filter(x => x.url !== page('e')).every(x => x.discarded === true) && seen.some(x => x.url === page('e') && !x.discarded), seen)
    // extensionTabs.js uses the library's internals: it found them all, and no update failed
    const problems = t.childLog().split('\n').filter(line => line.includes('tab list for extensions is off') || line.includes('updating the tab list for extensions failed'))
    check('Min\'s tab list found the library\'s internals it uses, and never failed', problems.length === 0, problems)
    u.close()
    w.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
