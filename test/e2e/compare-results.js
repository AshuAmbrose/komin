// Compares measurement runs: for each group of result files, the median [min–max] of every number in the run's info
// detail (processor time, memory and the rest), so runs of a change switched on and off (old-behaviour.js) can be read
// side by side. How the 2026-11-10 figures in docs/agents (ad-blocking.md "What these changes cost", extensions.md,
// memory-and-background.md) were worked out.
// usage: node test/e2e/compare-results.js "<label>=<regex for file names in results/>" ...
//   node test/e2e/compare-results.js "on=^measure-watcher-memory-on-g\d\.json" "off=^measure-watcher-memory-off-g\d\.json"
// Counters (mutations, process counts, wall time) are left out to keep it short. Lists of objects are numbered
// (memoryWhilePlaying.0.allMB). Per-site timings (measure-generic-cosmetics.js's genericRulesTiming) get a table of
// their own: per site, the median [min–max] of first paint, DOMContentLoaded, the first report, how long the page was
// drawn before it, and the watcher's time (how the 2026-11-11 page-speed look in ad-blocking.md was done).
const fs = require('fs')
const path = require('path')
const dir = path.join(__dirname, 'results')
const groups = process.argv.slice(2)
if (!groups.length || groups.some(g => !g.includes('='))) {
  console.error('usage: node test/e2e/compare-results.js "<label>=<regex for file names in results/>" ...')
  process.exit(2)
}
const SKIP = /genericRulesTiming|watcherCalls|mutations|firstPaint|domContentLoaded|processes|wallSeconds|classes|ids|hrefs/
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
const median = a => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const show = a => `${Math.round(median(a) * 100) / 100} [${Math.min(...a)}–${Math.max(...a)}]`
function flatten (o, prefix, out) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? prefix + '.' + k : k
    if (typeof v === 'number') out[key] = v
    else if (Array.isArray(v) && k !== 'genericRulesTiming') v.forEach((x, i) => { if (x && typeof x === 'object') flatten(x, key + '.' + i, out) })
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
  }
  return out
}
const SITE_FIELDS = ['firstPaint', 'domContentLoaded', 'firstReport', 'shownBeforeGenericRules', 'watcherMs']
for (const g of groups) {
  const at = g.indexOf('=')
  const label = g.slice(0, at)
  const rx = new RegExp(g.slice(at + 1))
  const rows = {}
  const sites = {}
  const picked = []
  for (const f of files.filter(f => rx.test(f))) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
    if (!Array.isArray(r.results)) continue // not a run's result file (a script's extra output, such as -videos.json)
    picked.push(f)
    const info = r.results.filter(x => /info/.test(x.name) && x.detail && typeof x.detail === 'object' && !Array.isArray(x.detail)).map(x => x.detail)
    // the measurement's detail: the first info check with processor time or memory in it
    const d = info.find(x => x.loadingSevenPages || x.loadingSevenSites || x.tabWork || x.beforeMinimizing || x.allSeconds !== undefined) || {}
    for (const [k, v] of Object.entries(flatten(d, '', {}))) (rows[k] = rows[k] || []).push(v)
    ;(rows.allChecksPassed = rows.allChecksPassed || []).push(r.passed === r.total ? 1 : 0)
    for (const s of d.genericRulesTiming || []) {
      const site = sites[s.host] = sites[s.host] || {}
      for (const f of SITE_FIELDS) if (typeof s[f] === 'number') (site[f] = site[f] || []).push(s[f])
    }
  }
  console.log(`\n== ${label} (${picked.length} runs: ${picked.join(' ')})`)
  for (const [k, v] of Object.entries(rows)) {
    if (!SKIP.test(k)) console.log('  ' + k.padEnd(56) + show(v))
  }
  if (Object.keys(sites).length) {
    console.log('  per site, ms: ' + SITE_FIELDS.join(', '))
    for (const [host, v] of Object.entries(sites)) {
      console.log('    ' + host.padEnd(30) + SITE_FIELDS.map(f => v[f] ? show(v[f]) : '-').join('  |  '))
    }
  }
}
