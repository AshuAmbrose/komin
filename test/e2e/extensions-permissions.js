// What an extension may know and do without the permission for it (main/extensionPermissions.js, AGENTS.md section 10.9).
// The extension library answers every extension whatever it asks; Chrome ties these to permissions:
//   - a tab's address, title and icon: only with "tabs", access to that site, or activeTab after the user used the
//     extension on that tab (until the tab goes to another site);
//   - cookies: the "cookies" permission and access to the cookie's site; webNavigation: its permission;
//   - APIs whose permission an extension never declared aren't there at all;
//   - optional permissions: only what the manifest declares can be asked for, the user's yes is kept across a restart
//     (in extensions.json), and removing one takes it away again;
//   - a website's own service worker gets nothing of the extension library's bridge to main.
// Test extensions: extensions/unprivileged (no "tabs"; access to pages named "allowed…" only; activeTab; cookies and
// webNavigation optional, never granted) and extensions/cookies-limited (cookies, with access to 127.0.0.1 only).
// electron-workarounds checks that the library alone still gives all of it away.
// `node test/e2e/extensions-permissions.js posing` (not part of the regression run) switches off only Min's check of who
// is asking, in main.build.js for that run, and expects the opposite of the "can't pose" check: an extension without
// the cookies permission gets cookies by naming an extension that has it. It shows that check is still needed.
const fs = require('fs')
const http = require('http')
const path = require('path')
const POSING = process.argv[2] === 'posing'
const t = require('./harness')({ name: 'extensions-permissions' + (POSING ? '-posing' : ''), minutes: 9 })
if (POSING) {
  t.patchFile('main.build.js', function (text) {
    const code = 'if (!extensionMessageSenderIs(event, extensionId)) {'
    if (!text.includes(code)) throw new Error('extensions-permissions: the check to switch off has moved: ' + code)
    return text.replace(code, 'if (false) {')
  })
}
const { PAGE, sleep, check, finish, target, waitFor, launch, quit, ui } = t
const UNPRIVILEGED = t.extension('unprivileged')
const COOKIES = t.extension('cookies-limited')
const page = name => PAGE + '?' + name
// another site: host permissions and cookies go by host name
const ELSEWHERE = PAGE.replace('127.0.0.1', 'localhost')
const workerOf = id => target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
const tabOf = url => target(x => x.type === 'page' && x.url === url, 15000)
const idOf = (u, url) => u.evaluate(`tabs.get().find(t => t.url === ${JSON.stringify(url)}).id`)
const select = async (u, url) => { await u.evaluate(`ipc.emit('extensions-select-tab', {}, ${JSON.stringify(await idOf(u, url))}); 1`); await sleep(1500) }
// a website with a service worker of its own (the extension library's preload starts in every service worker)
const SITE = 'http://127.0.0.1:8783'
http.createServer((req, res) => {
  if (req.url === '/sw.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('self.addEventListener("install", () => self.skipWaiting())')
  } else {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>site with a worker</title><script>navigator.serviceWorker.register("/sw.js")</script>')
  }
}).listen(8783, '127.0.0.1')
const startWorker = (main, id) => main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.startWorkerForScope('chrome-extension://${id}/').then(() => 1, e => String(e))`)
const savedGrants = id => { try { return JSON.parse(fs.readFileSync(path.join(t.profileDir, 'extensions.json'), 'utf8')).extensions[id].granted || null } catch (e) { return 'unreadable: ' + e.message } }
const open = async (u, url) => { await u.evaluate(`ipc.emit('extensions-open-tab', {}, { requestId: 'open-' + Date.now(), url: ${JSON.stringify(url)}, active: false }); 1`); await sleep(2000) }

;(async () => {
  let main
  try {
    main = await launch(page('allowed-start'))
    const u = await ui()
    await sleep(1500)
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(UNPRIVILEGED)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(COOKIES)}; 1`)
    const cookiesId = await s.evaluate("extensionPages.request('load-unpacked')")
    check('test extensions loaded', /^[a-p]{32}$/.test(id) && /^[a-p]{32}$/.test(cookiesId), { id, cookiesId })
    s.close()
    await u.evaluate("ipc.emit('extensions-close-tab', {}, tabs.get().find(t => t.url.startsWith('min://app/pages/settings/')).id); 1")
    await select(u, page('allowed-start'))
    const w = await workerOf(id)
    await w.evaluate('self.events = []; 1')

    // two more tabs: a page the extension has no access to, and one on another site
    await open(u, page('private-news'))
    await open(u, ELSEWHERE + '?elsewhere')

    const apis = await w.evaluate('apis()')
    check('APIs whose permission it never declared aren\'t there; optional ones are', apis.tabs === 'object' && apis.notifications === 'undefined' && apis.contextMenus === 'undefined' && apis.cookies === 'object' && apis.webNavigation === 'object', apis)

    const seen = await w.evaluate('listTabs()')
    const withAddress = seen.filter(x => x.url !== undefined || x.title !== undefined || x.favIconUrl !== undefined)
    check('no "tabs" permission: every tab is listed, with its address and title only where the extension has access', seen.length === 3 && withAddress.length === 1 && withAddress[0].url === page('allowed-start') && /allowed-start/.test(withAddress[0].title), seen)

    const byAddress = await w.evaluate("listTabs({ url: '*://*/*' })")
    check('a query by address finds only the tabs it may see', byAddress.length === 1 && byAddress[0].url === page('allowed-start'), byAddress)

    let events = await w.evaluate('self.events')
    const tabEvents = events.filter(e => e.type === 'created' || e.type === 'updated')
    check('tab events for other tabs carry no address or title', tabEvents.some(e => e.type === 'created') && tabEvents.every(e => e.url === undefined && e.title === undefined && !(e.change && ('url' in e.change || 'title' in e.change || 'favIconUrl' in e.change))), tabEvents)

    // cookies and navigations: declared as optional, never granted
    const privateTab = await tabOf(page('private-news'))
    await privateTab.evaluate("document.cookie = 'secret=1; path=/'; 1")
    await sleep(500)
    const cookies = await w.evaluate('readCookies()')
    events = await w.evaluate('self.events')
    check('cookies without the permission: refused, and no cookie events', typeof cookies === 'string' && cookies.startsWith('refused') && !events.some(e => e.type === 'cookie'), { cookies, events: events.filter(e => e.type === 'cookie') })
    check('navigations without the permission: no events', !events.some(e => e.type === 'navigation'), events.filter(e => e.type === 'navigation'))

    // activeTab: the user clicks the extension's button on a tab it has no access to
    await select(u, page('private-news'))
    await w.evaluate('self.events = []; 1')
    const captureBefore = await w.evaluate('capture()')
    await u.evaluate(`ipc.invoke('extensions-toolbar-click', { id: ${JSON.stringify(id)}, anchorRect: { x: 0, y: 0, width: 10, height: 10 } }).then(() => 1)`)
    await sleep(1000)
    events = await w.evaluate('self.events')
    const afterClick = await w.evaluate('listTabs({ active: true, currentWindow: true })')
    check('activeTab: after its button is clicked on a tab, it gets that tab\'s address', events.some(e => e.type === 'clicked' && e.url === page('private-news')) && afterClick.length === 1 && afterClick[0].url === page('private-news'), { events, afterClick })
    const captureAfterClick = await w.evaluate('capture()')
    await privateTab.send('Page.navigate', { url: ELSEWHERE + '?moved' })
    await sleep(2000)
    const afterMoving = await w.evaluate('listTabs({ active: true, currentWindow: true })')
    check('activeTab: gone once the tab goes to another site', afterMoving.length === 1 && afterMoving[0].url === undefined && afterMoving[0].title === undefined, afterMoving)
    const captureAfterMoving = await w.evaluate('capture()')
    check('activeTab: a picture of the shown tab only between the click and the tab leaving the site', String(captureBefore).startsWith('refused') && String(captureAfterClick).startsWith('picture') && String(captureAfterMoving).startsWith('refused'), { before: captureBefore, afterClick: captureAfterClick, afterMoving: captureAfterMoving })
    privateTab.close()

    // the cookies permission with access to one site: that site's cookies only
    await main.evaluate(`process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.startWorkerForScope('chrome-extension://${cookiesId}/').then(() => 1, e => String(e))`)
    const cw = await workerOf(cookiesId)
    await cw.evaluate('self.changes = []; 1')
    const startTab = await tabOf(page('allowed-start'))
    await startTab.evaluate("document.cookie = 'here=1; path=/'; 1")
    const elsewhereTab = await tabOf(ELSEWHERE + '?elsewhere')
    // kept across a restart, for the optional permissions below
    await elsewhereTab.evaluate("document.cookie = 'there=1; path=/; max-age=3600'; 1")
    await sleep(1000)
    const own = await cw.evaluate('readCookies()')
    const changes = await cw.evaluate('self.changes')
    const refused = await cw.evaluate(`getCookie(${JSON.stringify(ELSEWHERE)}, 'there')`)
    const allowed = await cw.evaluate(`getCookie(${JSON.stringify(PAGE)}, 'here')`)
    check('cookies with access to one site: only that site\'s cookies are listed', Array.isArray(own) && own.includes('127.0.0.1 here=1') && own.includes('127.0.0.1 secret=1') && !own.some(c => c.startsWith('localhost')), own)
    check('cookies with access to one site: another site\'s cookie is refused, its own is read', typeof refused === 'string' && refused.startsWith('refused') && allowed === '1', { refused, allowed })
    check('cookies with access to one site: only that site\'s cookie changes are reported', changes.includes('127.0.0.1 here') && !changes.some(c => c.startsWith('localhost')), changes)
    // the library's bridge to main takes the extension's id as an argument and stays within reach of extensions' code:
    // the unprivileged extension asks for cookies in the name of the one that may read 127.0.0.1's
    const posing = await w.evaluate(`readCookiesAs(${JSON.stringify(cookiesId)})`)
    if (POSING) {
      check('still needed: without Min\'s check of who is asking, an extension gets another one\'s cookies by naming it', Array.isArray(posing) && posing.includes('secret=1'), posing)
    } else {
      check('an extension can\'t pose as another one to main', posing === 'refused', posing)
    }
    startTab.close()
    elsewhereTab.close()

    // a website's own service worker: the library's preload starts there too
    await open(u, SITE + '/')
    const siteWorker = await target(x => x.type === 'service_worker' && x.url === SITE + '/sw.js', 15000)
    const inSiteWorker = siteWorker ? await siteWorker.evaluate(`(async () => {
      const bridge = globalThis.electron
      const out = { electron: typeof bridge, chrome: typeof globalThis.chrome }
      if (bridge && typeof bridge.invokeExtension === 'function') {
        out.cookies = await bridge.invokeExtension(${JSON.stringify(cookiesId)}, 'cookies.getAll', {}, {}).then(list => Array.isArray(list) ? list.length + ' cookies' : String(list), e => 'refused: ' + e.message)
      }
      return out
    })()`) : 'no worker'
    // (the library's bridge is there too; what counts is that naming an extension gets it nothing)
    check('a website\'s service worker can\'t reach the extension APIs', inSiteWorker && inSiteWorker !== 'no worker' && (inSiteWorker.cookies === undefined || inSiteWorker.cookies === 'undefined'), inSiteWorker)
    if (siteWorker) siteWorker.close()

    // optional permissions. The harness answers Min's prompt with its first button, "Allow"
    const dialogsBefore = await main.evaluate('__dialogs.length')
    const undeclared = await w.evaluate("requestPermissions({ origins: ['https://example.com/*'] })")
    const undeclaredPermission = await w.evaluate("requestPermissions({ permissions: ['history'] })")
    check('optional permissions: what the manifest doesn\'t declare is refused without asking the user', undeclared !== true && undeclaredPermission !== true && (await main.evaluate('__dialogs.length')) === dialogsBefore, { undeclared, undeclaredPermission, prompts: (await main.evaluate('__dialogs.length')) - dialogsBefore })
    const wanted = "{ permissions: ['cookies'], origins: ['http://localhost/*'] }"
    await w.evaluate('self.permissionEvents = []; 1')
    const granted = await w.evaluate(`requestPermissions(${wanted})`)
    await sleep(500)
    const prompt = (await main.evaluate('__dialogs.slice(-1)[0]')) || {}
    const cookiesNow = await w.evaluate('readCookies()')
    const tabsNow = (await w.evaluate('listTabs()')).filter(x => x.url && x.url.startsWith(ELSEWHERE))
    check('optional permissions: granted through Min\'s prompt, they work at once', granted === true && (await main.evaluate('__dialogs.length')) === dialogsBefore + 1 && Array.isArray(cookiesNow) && cookiesNow.includes('there=1') && !cookiesNow.includes('secret=1') && tabsNow.length > 0, { granted, prompt, cookies: cookiesNow, localhostTabs: tabsNow.length })
    const addedEvents = await w.evaluate('self.permissionEvents')
    check('optional permissions: the extension is told (permissions.onAdded)', addedEvents.some(e => e.type === 'added' && e.added && (e.added.permissions || []).includes('cookies')), addedEvents)
    check('optional permissions: saved in extensions.json', JSON.stringify(savedGrants(id)) === JSON.stringify({ permissions: ['cookies'], origins: ['http://localhost/*'] }), savedGrants(id))

    // extensionPermissions.js uses the library's internals: it found them all
    const problems = t.childLog().split('\n').filter(line => line.includes('isn\'t checking extensions\' permissions'))
    check('Min found the library\'s internals it checks permissions through', problems.length === 0, problems)
    w.close()
    cw.close()
    u.close()
    await quit(main)

    // after a restart the user's yes still counts
    main = await launch(page('allowed-start'))
    const u2 = await ui()
    await sleep(3000)
    await startWorker(main, id)
    const w2 = await workerOf(id)
    const stillHas = await w2.evaluate(`hasPermissions(${wanted})`)
    const cookiesAfterRestart = await w2.evaluate('readCookies()')
    check('optional permissions: kept after a restart', stillHas === true && Array.isArray(cookiesAfterRestart) && cookiesAfterRestart.includes('there=1'), { has: stillHas, cookies: cookiesAfterRestart })
    await w2.evaluate('self.permissionEvents = []; 1')
    const removed = await w2.evaluate(`removePermissions(${wanted})`)
    await sleep(500)
    const hasAfterRemoving = await w2.evaluate(`hasPermissions(${wanted})`)
    const cookiesAfterRemoving = await w2.evaluate('readCookies()')
    const removedEvents = await w2.evaluate('self.permissionEvents')
    check('optional permissions: removed by the extension, they are gone, also from extensions.json', removed === true && hasAfterRemoving === false && cookiesAfterRemoving === 'refused' && savedGrants(id) === null && removedEvents.some(e => e.type === 'removed'), { removed, has: hasAfterRemoving, cookies: cookiesAfterRemoving, saved: savedGrants(id), events: removedEvents })
    w2.close()
    u2.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
