// adblock.turtlecute.org's ad blocker test, run in Min: which of its 130 checks are blocked (126 ad and tracker hosts in 30
// groups, two decoy ad boxes, two decoy scripts). Its score is simply blocked / 130.
// usage: node test/e2e/measure-adblock-turtlecute.js <min|none|ubol>
//   min = Min's own blocker (default settings), none = blocking off, ubol = uBlock Origin Lite installed (it takes over
//   normal tabs' requests, section 10.9). Writes results/measure-adblock-turtlecute-<config>.json (the summary) and
//   results/measure-adblock-turtlecute-<config>-checks.json (every check). Needs the internet; the site's list can change.
const fs = require('fs')
const config = process.argv[2] || 'min'
if (!['min', 'none', 'ubol'].includes(config)) {
  console.error('usage: node test/e2e/measure-adblock-turtlecute.js <min|none|ubol>')
  process.exit(2)
}
const UBOL_ID = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
const TESTER = 'https://adblock.turtlecute.org/'
const harness = require('./harness')
const t = harness({
  name: 'measure-adblock-turtlecute-' + config,
  minutes: 8,
  extensions: config === 'ubol' ? [UBOL_ID] : [],
  settings: config === 'none' ? { filtering: { blockingLevel: 0, contentTypes: [], exceptionDomains: [] } } : {}
})
const { sleep, check, finish, target, waitFor, launch, ui } = t

// what the page shows once its test is done: every host check, the decoy ad boxes and scripts (green = blocked)
const READ_RESULTS = `(() => {
  const card = (document.getElementById('adb_test_r') || {}).innerText || ''
  const number = re => Number((card.match(re) || [])[1])
  const blockedBox = id => { const el = document.getElementById(id); return el ? el.className.includes('_bg-green') : null }
  return {
    total: number(/Total:\\s*(\\d+)/),
    blocked: number(/(\\d+)\\s*blocked/),
    notBlocked: number(/(\\d+)\\s*not blocked/),
    cosmetic: { staticAd: blockedBox('ct_static'), dynamicAd: blockedBox('ct_dynamic') },
    scripts: { 'ads.js': blockedBox('sfa_1'), 'pagead.js': blockedBox('sfa_2') },
    groups: Array.from(document.querySelectorAll('.test[id]')).map(group => ({
      group: group.id,
      hosts: Array.from(group.querySelectorAll(':scope > div > div')).map(row => ({
        host: (row.querySelector('span') || {}).textContent,
        blocked: (row.querySelector('svg') || { getAttribute: () => '' }).getAttribute('stroke') === 'var(--green)'
      }))
    }))
  }
})()`

;(async () => {
  try {
    const main = await launch('about:blank')
    const u = await ui()
    await sleep(1500)
    if (config === 'ubol') {
      await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
      const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
      await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
      await main.evaluate(`global.__nextOpen = ${JSON.stringify(t.crx(UBOL_ID))}; 1`)
      const installed = await s.evaluate("extensionPages.request('install-crx').catch(e => 'refused: ' + e.message)")
      check('uBO Lite installed (info)', installed === UBOL_ID, installed)
      s.close()
      // its rulesets are switched on from inside it (pitfall 26)
      await sleep(5000)
    }
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(TESTER)} }); 1`)
    const page = await target(x => x.type === 'page' && x.url.startsWith(TESTER), 30000)
    // the test runs by itself on load; done when every check has a result and nothing changes for 5 s
    let last = null
    let stableSince = Date.now()
    const results = await waitFor(async () => {
      const r = await page.evaluate(READ_RESULTS)
      if (!r || typeof r !== 'object' || !(r.total > 0) || r.blocked + r.notBlocked !== r.total) {
        return null
      }
      const key = JSON.stringify(r)
      if (key !== last) {
        last = key
        stableSince = Date.now()
        return null
      }
      return Date.now() - stableSince > 5000 ? r : null
    }, 120000)
    if (!results) {
      check('the test page finished', false, await page.evaluate(READ_RESULTS))
      return finish()
    }
    const hosts = results.groups.flatMap(g => g.hosts.map(h => Object.assign({ group: g.group }, h)))
    fs.writeFileSync(t.output('checks.json'), JSON.stringify(results, null, 2))
    const score = Math.round(results.blocked / results.total * 100)
    check('score (info): ' + score + '% (' + results.blocked + ' of ' + results.total + ' blocked)', true, {
      cosmetic: results.cosmetic,
      scripts: results.scripts,
      hostsBlocked: hosts.filter(h => h.blocked).length + ' of ' + hosts.length
    })
    check('groups (info): blocked / tested', true, Object.fromEntries(results.groups.map(g => [g.group, g.hosts.filter(h => h.blocked).length + '/' + g.hosts.length])))
    check('hosts not blocked (info)', true, hosts.filter(h => !h.blocked).map(h => h.group + ': ' + h.host))
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  finish()
})()
