// AdGuard's filtering test cases (https://testcases.agrd.dev), run in Min with Min's own ad blocker: which kinds of filter
// rules Min's engine (Ghostery's, with uBlock Origin's lists) handles. Each group has a page of QUnit tests and a filter
// list of its own; as AdGuard's instructions say, every other list is off. For each group the script builds an engine from
// that list alone, with the same library and settings Min uses (ElectronBlocker.fromLists, which also brings the
// scriptlets' code), puts it where Min keeps its saved engine, starts Min, opens the page and reads every test's result.
// usage: node test/e2e/measure-adguard-testcases.js [part of a group's title or page ...]   (all groups by default)
// Writes results/measure-adguard-testcases.json (a check per group) and -groups.json (every test's result). The rule
// lists mix AdGuard's own syntax (#%#//scriptlet, #$#), uBlock Origin's (##+js) and Adblock Plus's; Min's engine reads
// uBlock Origin's. `adguardChrome` says whether AdGuard's own Chrome extension (MV2) is meant to pass the group:
// groups only AdGuard's desktop apps support (rewriting HTML, $replace and the like) are expected to fail.
// Needs the internet. The groups are as listed on 2026-11-14; the site can change.
const fs = require('fs')
const path = require('path')
const { ElectronBlocker } = require('@ghostery/adblocker-electron')

const SITE = 'https://testcases.agrd.dev/'
// [title, test page, its filter list, AdGuard's Chrome extension supports it: yes/no]
const GROUPS = [
  ['Element hiding rules', 'Filters/element-hiding-rules/test-element-hiding-rules.html', 'Filters/element-hiding-rules/test-element-hiding-rules.txt', 'yes'],
  ['Generic hide rules', 'Filters/generichide-rules/generichide-rules.html', 'Filters/generichide-rules/generichide-rules.txt', 'yes'],
  ['CSS rules', 'Filters/css-rules/css-rules.html', 'Filters/css-rules/css-rules.txt', 'yes'],
  ['Extended CSS rules', 'Filters/extended-css-rules/test-extended-css-rules.html', 'Filters/extended-css-rules/test-extended-css-rules.txt', 'yes'],
  ['Extended CSS rules injection into iframe created with js', 'Filters/extended-css-rules/extended-css-iframejs-injection/extended-css-iframejs-injection.html', 'Filters/extended-css-rules/extended-css-iframejs-injection/extended-css-iframejs-injection.txt', 'yes'],
  ['$important rules', 'Filters/important-rules/test-important-rules.html', 'Filters/important-rules/test-important-rules.txt', 'yes'],
  ['$important rule vs $urlblock exception', 'Filters/important-rules/important-vs-urlblock/test-important-vs-urlblock.html', 'Filters/important-rules/important-vs-urlblock/test-important-vs-urlblock.txt', 'yes'],
  ['$replace rules', 'Filters/replace-rules/test-replace-rules.html', 'Filters/replace-rules/test-replace-rules.txt', 'no'],
  ['$replace rule vs $generichide exception', 'Filters/replace-rules/replace-vs-generichide-rule/replace-vs-generichide-rule.html', 'Filters/replace-rules/replace-vs-generichide-rule/replace-vs-generichide-rule.txt', 'no'],
  ['$replace rule vs $content exception', 'Filters/replace-rules/replace-vs-content-rule/replace-vs-content-rule.html', 'Filters/replace-rules/replace-vs-content-rule/replace-vs-content-rule.txt', 'no'],
  ['$replace rule vs $elemhide exception', 'Filters/replace-rules/replace-vs-elemhide-rule/replace-vs-elemhide-rule.html', 'Filters/replace-rules/replace-vs-elemhide-rule/replace-vs-elemhide-rule.txt', 'no'],
  ['$csp rules', 'Filters/csp-rules/test-csp-rules.html', 'Filters/csp-rules/test-csp-rules.txt', 'yes'],
  ['$csp global exception test', 'Filters/csp-rules/csp-global-exception/csp-global-exception.html', 'Filters/csp-rules/csp-global-exception/csp-global-exception.txt', 'yes'],
  ['Websocket blocking', 'Filters/websockets/test-websockets.html', 'Filters/websockets/test-websockets.txt', 'yes'],
  ['Content (HTML filtering) rules', 'Filters/content-rules/test-content-rules.html', 'Filters/content-rules/test-content-rules.txt', 'no'],
  ['$content modifier tests', 'Filters/content-rules/content-modifier-test/content-modifier-test.html', 'Filters/content-rules/content-modifier-test/content-modifier-test.txt', 'no'],
  ['Script rules', 'Filters/script-rules/test-script-rules.html', 'Filters/script-rules/test-script-rules.txt', 'yes'],
  ['Script rules test for Firefox AMO', 'Filters/script-rules/test-script-firefox/test-script-firefox.html', 'Filters/script-rules/test-script-firefox/test-script-firefox.txt', 'no'],
  ['Scriptlet rules', 'Filters/scriptlet-rules/test-scriptlet-rules.html', 'Filters/scriptlet-rules/test-scriptlet-rules.txt', 'yes'],
  ['Popup blocker', 'PopupBlocker/test-popup-blocker.html', 'PopupBlocker/test-popup-blocker-rules.txt', 'yes'],
  ['Popup blocker event recovery', 'PopupBlocker/test-event-recovery.html', '', 'yes'],
  ['$badfilter rules', 'Filters/badfilter-rules/test-badfilter-rules.html', 'Filters/badfilter-rules/test-badfilter-rules.txt', 'yes'],
  ['$network rules', 'Filters/network-rules/test-network-rules.html', 'Filters/network-rules/test-network-rules.txt', 'no'],
  ['$redirect rules', 'Filters/redirect-rules/test-redirect-rules.html', 'Filters/redirect-rules/test-redirect-rules.txt', 'yes'],
  ['$redirect resources security test', 'Filters/redirect-security/test-redirect-security.html', 'Filters/redirect-security/test-redirect-security.txt', 'yes'],
  ['$jsinject rules test', 'Filters/script-rules/jsinject-rules/test-jsinject-rules.html', 'Filters/script-rules/jsinject-rules/test-jsinject-rules.txt', 'yes'],
  ['$removeparam rules', 'Filters/removeparam-rules/test-removeparam-rules.html', 'Filters/removeparam-rules/test-removeparam-rules.txt', 'yes'],
  ['$specifichide rules', 'Filters/specifichide-rules/test-specifichide-rules.html', 'Filters/specifichide-rules/test-specifichide-rules.txt', 'yes'],
  ['$denyallow rules', 'Filters/denyallow-rules/test-denyallow-rules.html', 'Filters/denyallow-rules/test-denyallow-rules.txt', 'yes'],
  ['$removeheader rules', 'Filters/removeheader-rules/test-removeheader-rules.html', 'Filters/removeheader-rules/test-removeheader-rules.txt', 'yes'],
  ['$ping, $websocket, $xmlhttprequest rules', 'Filters/blocking-request-rules/test-blocking-request-rules.html', 'Filters/blocking-request-rules/test-blocking-request-rules.txt', 'yes'],
  ['Test $subdocument rules for Safari 15+', 'Filters/subdocument-rules/test-subdocument-rules.html', 'Filters/subdocument-rules/test-subdocument-rules.txt', 'no'],
  ['Non-basic $path modifier', 'Filters/nonbasic-path-modifier/test-nonbasic-path-modifier.html', 'Filters/nonbasic-path-modifier/test-nonbasic-path-modifier.txt', 'yes'],
  ['Advanced $domain modifier', 'Filters/advanced-domain-modifier/test-advanced-domain-modifier.html', 'Filters/advanced-domain-modifier/test-advanced-domain-modifier.txt', 'yes'],
  ['$jsonprune modifier tests', 'Filters/jsonprune-rules/test-jsonprune-rules.html', 'Filters/jsonprune-rules/test-jsonprune-rules.txt', 'no'],
  ['$hls modifier tests', 'Filters/hls-rules/test-hls-rules.html', 'Filters/hls-rules/test-hls-rules.txt', 'no'],
  ['$method modifier tests', 'Filters/method-rules/test-method-rules.html', 'Filters/method-rules/test-method-rules.txt', 'yes'],
  ['$to modifier tests', 'Filters/to-rules/test-to-rules.html', 'Filters/to-rules/test-to-rules.txt', 'yes'],
  ['$cookie modifier tests', 'Filters/cookie-rules/test-cookie-rules.html', 'Filters/cookie-rules/test-cookie-rules.txt', 'yes'],
  ['$match-case modifier tests', 'Filters/match-case-rules/test-match-case-rules.html', 'Filters/match-case-rules/test-match-case-rules.txt', 'yes'],
  ['Scriptlet allowlist specific rules', 'Filters/scriptlet-rules/allowlist-specific/test-scriptlet-allowlist-specific-rules.html', 'Filters/scriptlet-rules/allowlist-specific/test-scriptlet-allowlist-specific-rules.txt', 'yes'],
  ['Scriptlet allowlist general rules', 'Filters/scriptlet-rules/allowlist-general/test-scriptlet-allowlist-general-rules.html', 'Filters/scriptlet-rules/allowlist-general/test-scriptlet-allowlist-general-rules.txt', 'yes'],
  ['$urltransform rules test', 'Filters/urltransform-rules/test-urltransform-rules.html', 'Filters/urltransform-rules/test-urltransform-rules.txt', 'yes'],
  ['$permissions rules test', 'Filters/permissions-rules/test-permissions-rules.html', 'Filters/permissions-rules/test-permissions-rules.txt', 'yes'],
  ['Strict party modifiers tests', 'Filters/strict-party-rules/test-strict-party-rules.html', 'Filters/strict-party-rules/test-strict-party-rules.txt', 'no'],
  // left out: 'JS and Scriptlet rules: CSP and Trusted Types tests' (checked by hand in DevTools, no QUnit results) and the
  // four userscript groups (they need AdGuard's test userscripts, not a filter list: measure-adguard-userscripts.js)
  ['Injection speed tests', 'Filters/injection-speed/index.html', 'Filters/injection-speed/test-injection-speed.txt', 'yes'],
  ['$permissions rules test for MV3', 'Filters/permissions-rules-mv3/test-permissions-rules-mv3.html', 'Filters/permissions-rules-mv3/test-permissions-rules-mv3.txt', 'no'],
  ['$header rules', 'Filters/header-rules/test-header-rules.html', 'Filters/header-rules/test-header-rules.txt', 'yes'],
  ['CSP reports tests', 'Filters/csp-reports/test-csp-reports.html', 'Filters/csp-reports/test-csp-reports.txt', 'yes'],
  ['Generic CSS injection into iframes of different sizes', 'Filters/generic-css-iframe-size/generic-css-iframe-size.html', 'Filters/generic-css-iframe-size/generic-css-iframe-size.txt', 'no'],
  ['$stealth rules: canvas fingerprinting protection', 'Filters/stealth-rules/test-stealth-rules.html', 'Filters/stealth-rules/test-stealth-rules.txt', 'yes']
].map(([title, page, rules, adguardChrome]) => ({ title, page: SITE + page, rules: rules ? SITE + rules : '', adguardChrome }))

const wanted = process.argv.slice(2)
const groups = wanted.length ? GROUPS.filter(g => wanted.some(w => g.title.toLowerCase().includes(w.toLowerCase()) || g.page.includes(w))) : GROUPS
// no engine from the harness's cache: each group brings its own
// MIN_TEST_OLD (old-behaviour.js, for example noPopupRules,noFrameHiding,noProceduralRules) for a comparison: results of
// their own (measure-adguard-testcases-old-groups.json)
const t = require('./harness')({ name: 'measure-adguard-testcases' + (process.env.MIN_TEST_OLD ? '-old' : ''), minutes: 10 + groups.length * 1.5, adblockEngine: false, keepEngine: false })
const switchedOff = require('./old-behaviour')(t)
const { sleep, check, finish, target, waitFor, launch, quit, ui } = t
const { getAdblockExtraRules } = require(path.join(t.root, 'js/util/adblockExtraRules.js'))

// the scriptlets' code (resources.json) is the same for every group: fetched once
const fetched = new Map()
const cachedFetch = function (url) {
  if (!fetched.has(url)) {
    fetched.set(url, fetch(url).then(response => response.text()))
  }
  return fetched.get(url).then(text => ({ text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text)), ok: true, status: 200 }))
}

// AdGuard's pop-up page has no QUnit: each button arms a trick that opens http://evilsite.com/ on the next click on the
// page, and the group's list says ||evilsite.com^$popup. Each button is clicked for real (the DevTools protocol), then the
// page; a trick passes when no tab reaches evilsite.com (mapped to this computer, so nothing loads from the internet).
// The page's second set of buttons ("shouldn't be blocked") tests AdGuard's own guessing of a person's click, which a
// list rule doesn't do (uBlock Origin blocks those too): recorded, not counted.
const POPUP_PAGE = 'PopupBlocker/test-popup-blocker.html'
async function clickPopupTricks (main, u, page, pageURL) {
  const results = []
  const buttons = await page.evaluate('Array.from(document.querySelectorAll("button")).map(b => b.innerText.trim())')
  const tricks = await page.evaluate('popupInstallers.length')
  for (let i = 0; i < buttons.length; i++) {
    // a fresh page for each trick
    await page.send('Page.navigate', { url: pageURL })
    await sleep(2500)
    await main.evaluate("(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().includes('test-popup-blocker')); if (wc) wc.focus(); return 1 })()")
    const click = async expression => {
      const box = await page.evaluate(expression)
      if (!box) return false
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
      }
      return true
    }
    await click(`(() => { const r = document.querySelectorAll('button')[${i}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
    await sleep(500)
    // then a click on the page's text
    await click("(() => { const r = document.querySelector('p').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })()")
    await sleep(2500)
    const tabs = await u.evaluate('tabs.get().map(t => t.url)')
    const pageNow = await page.evaluate('location.href').catch(() => '')
    results.push({ name: buttons[i], trick: i < tricks, opened: tabs.some(x => x.includes('evilsite.com')) || pageNow.includes('evilsite.com') })
    await u.evaluate("tabs.get().filter(t => !t.url.includes('test-popup-blocker')).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1")
    await sleep(500)
  }
  return results
}

// QUnit's results once it has finished: each test's name, its assertions failed / passed / total, pass or fail
const READ_RESULTS = `(() => {
  const display = document.getElementById('qunit-testresult-display')
  // "2 / 14 tests completed. Running: ..." while it runs; "14 tests completed in 158 milliseconds, ..." once done
  if (!display || !/completed in/.test(display.textContent)) return null
  return Array.from(document.querySelectorAll('#qunit-tests > li[id^="qunit-test-output"]')).map(li => ({
    name: ((li.querySelector('.test-name') || {}).textContent || '').trim(),
    passed: li.classList.contains('pass'),
    counts: ((li.querySelector('.counts') || {}).textContent || '').trim()
  }))
})()`

;(async () => {
  const report = []
  try {
    for (const group of groups) {
      const entry = { title: group.title, adguardChrome: group.adguardChrome, page: group.page }
      report.push(entry)
      try {
        // an engine of this group's list alone, as Min builds its own (its settings, scriptlets' code included; since
        // 2026-11-17 procedural rules on: an engine without them makes Min download its own lists a minute in)
        const engine = await ElectronBlocker.fromLists(cachedFetch, group.rules ? [group.rules] : [], { loadExtendedSelectors: true })
        fs.writeFileSync(path.join(t.profileDir, 'adblocker-engine-v2.bin'), Buffer.from(engine.serialize()))
        // and its pop-up and tracking-parameter rules, which Min keeps apart (js/util/adblockExtraRules.js; since
        // 2026-11-17), so Min doesn't download its own lists in their place
        const extraRules = group.rules ? getAdblockExtraRules(await (await cachedFetch(group.rules)).text()) : []
        fs.writeFileSync(path.join(t.profileDir, 'adblocker-extra-rules.txt'), extraRules.join('\n'))
        const isPopupPage = group.page.endsWith(POPUP_PAGE)
        const main = await launch('about:blank', isPopupPage ? { args: ['--host-resolver-rules=MAP evilsite.com 127.0.0.1'] } : {})
        const u = await ui()
        // the engine loads from the profile as Min starts; give it a moment before the page's first request
        await sleep(2500)
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(group.page)} }); 1`)
        const page = await target(x => x.type === 'page' && x.url.startsWith(group.page.replace(/\.html$/, '')), 20000)
        let tests = null
        if (page && isPopupPage) {
          await sleep(3000)
          const tricks = await clickPopupTricks(main, u, page, group.page)
          entry.notCounted = tricks.filter(x => !x.trick)
          tests = tricks.filter(x => x.trick).map(x => ({ name: x.name, passed: !x.opened, counts: x.opened ? 'evilsite.com opened' : 'blocked' }))
        } else if (page) {
          tests = await waitFor(async () => { const r = await page.evaluate(READ_RESULTS); return Array.isArray(r) ? r : null }, 45000)
        }
        if (!page) {
          entry.error = 'the page didn\'t open'
        } else if (!tests) {
          entry.error = 'QUnit didn\'t finish in 45 s'
          entry.pageText = String(await page.evaluate("document.body ? document.body.innerText.slice(0, 300) : ''")).slice(0, 300)
        } else {
          entry.tests = tests
          entry.passed = tests.filter(x => x.passed).length
          entry.total = tests.length
          // why: QUnit's text of the failed tests (their assertions' messages, expected and actual values)
          if (entry.passed < entry.total && !isPopupPage) {
            entry.failureText = String(await page.evaluate("(document.getElementById('qunit-testresult-display') || {}).innerText + ' | ' + Array.from(document.querySelectorAll('#qunit-tests > li')).filter(li => !li.classList.contains('pass')).map(li => li.innerText).join(' | ')")).slice(0, 2000)
          }
        }
        if (page) page.close()
        u.close()
        await quit(main)
      } catch (e) {
        entry.error = String(e.message || e).slice(0, 300)
      }
      const summary = entry.error ? 'error: ' + entry.error : entry.passed + ' of ' + entry.total + ' tests pass'
      check(group.title + ' (info; AdGuard\'s Chrome extension: ' + group.adguardChrome + '): ' + summary, true, entry.tests ? entry.tests.filter(x => !x.passed).map(x => x.name + ' ' + x.counts) : entry.pageText)
      fs.writeFileSync(t.output('groups.json'), JSON.stringify(report, null, 2))
    }
    const count = (list, key) => list.reduce((sum, g) => sum + (g[key] || 0), 0)
    const meant = report.filter(g => g.adguardChrome === 'yes')
    check('summary (info)', true, {
      switchedOff,
      groups: report.length,
      testsPassed: count(report, 'passed') + ' of ' + count(report, 'total'),
      inGroupsAdguardsChromeExtensionSupports: count(meant, 'passed') + ' of ' + count(meant, 'total'),
      groupsAllPassing: report.filter(g => g.total && g.passed === g.total).map(g => g.title),
      groupsWithErrors: report.filter(g => g.error).map(g => g.title + ': ' + g.error)
    })
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  finish()
})()
