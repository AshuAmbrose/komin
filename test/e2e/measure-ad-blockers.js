// The ad blocker side-by-side (AGENTS.md section 10.2): no blocking, Min's blocker and uBlock Origin Lite (full uBlock
// Origin was a fourth setup until Min stopped loading Manifest V2 extensions; its results are in AGENTS.md),
// each in a brand-new profile, on five ad-heavy sites and three YouTube videos, interleaved so that the time of day and the
// network affect every setup alike. About 8 minutes per run; with the default two rounds, about 50 minutes.
// usage: node test/e2e/measure-ad-blockers.js [rounds]     node test/e2e/measure-ad-blockers.js --summary (only rewrite the table)
// Results: test/e2e/results/ad-blockers/<config>-<run>.json and summary.md. Windows must stay unlocked for the YouTube part.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const dir = path.join(__dirname, 'results', 'ad-blockers')
fs.mkdirSync(dir, { recursive: true })
if (process.argv[2] !== '--summary') {
  const rounds = Number(process.argv[2]) || 2
  for (let run = 1; run <= rounds; run++) {
    for (const config of ['none', 'min', 'ubol']) {
      console.log('=== ' + config + ' ' + run + ' ' + new Date().toLocaleTimeString())
      const out = path.join(dir, config + '-' + run + '.json')
      const log = fs.openSync(out.replace(/json$/, 'log'), 'w')
      spawnSync(process.execPath, [path.join(__dirname, 'measure-ad-blockers-run.js'), config, String(run), out], { stdio: ['ignore', log, log] })
      fs.closeSync(log)
    }
  }
  fs.rmSync(path.join(os.tmpdir(), 'min-e2e-blockers'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
const CONFIGS = ['none', 'min', 'ubol']
const NAMES = { none: 'No blocking', min: "Min's blocker", ubol: 'uBO Lite' }
const runs = {}
for (const c of CONFIGS) {
  runs[c] = []
  // every round's file (<config>-<n>.json), in order
  const files = fs.readdirSync(dir).filter(f => new RegExp('^' + c + '-\\d+\\.json$').test(f)).sort((a, b) => parseInt(a.split('-')[1]) - parseInt(b.split('-')[1]))
  for (const f of files) {
    runs[c].push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  }
}
const mean = list => { const v = list.filter(x => typeof x === 'number' && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const fmt = (v, digits = 0) => v === null || v === undefined ? '–' : Number(v).toFixed(digits)
const both = (c, fn, digits = 0) => runs[c].map(r => { try { return fmt(fn(r), digits) } catch (e) { return '–' } }).join(' / ')
const avg = (c, fn) => mean(runs[c].map(r => { try { return fn(r) } catch (e) { return null } }))
const sum = (list, key) => list.reduce((a, s) => a + (typeof s[key] === 'number' ? s[key] : 0), 0)

const rows = [
  ['Runs completed', c => runs[c].filter(r => !r.stoppedEarly).length + ' of ' + runs[c].length],
  ['Screen locked during run', c => runs[c].map(r => r.screenLocked ? 'yes' : 'no').join(' / ')],
  ['**Blocking**', null],
  ['Requests to ad/tracker hosts that loaded (5 sites)', c => both(c, r => sum(r.sites, 'adTrackerLoaded'))],
  ['Requests blocked (5 sites)', c => both(c, r => sum(r.sites, 'blocked'))],
  ['Requests neutralized by redirect (5 sites)', c => both(c, r => sum(r.sites, 'redirectedAway'))],
  ['Stand-ins Chromium refused, so blocked instead (5 sites)', c => both(c, r => sum(r.sites, 'standInRefused'))],
  ['Visible ad slots (5 sites)', c => both(c, r => sum(r.sites, 'visibleAdSlots'))],
  ['YouTube videos that showed an ad (of 3)', c => both(c, r => r.youtube.filter(v => v.adSeen).length)],
  ['YouTube anti-adblock warnings', c => both(c, r => r.youtube.filter(v => v.antiAdblockWarning).length)],
  ['adblock-tester.com score (of 100)', c => both(c, r => r.tester.score)],
  ['**Page weight and speed**', null],
  ['Requests made (5 sites)', c => both(c, r => sum(r.sites, 'requests'))],
  ['Data downloaded (5 sites, MB)', c => both(c, r => sum(r.sites, 'bytes') / 1024, 1)],
  ['Sites that finished loading within 35 s (of 5)', c => both(c, r => r.sites.filter(s => s.loadMs > 0).length)],
  ['Average load time of the sites that finished (ms)', c => both(c, r => mean(r.sites.filter(s => s.loadMs > 0).map(s => s.loadMs)))],
  ['Average DOM ready time (ms)', c => both(c, r => mean(r.sites.map(s => s.domContentLoadedMs)))],
  ['Page script errors (5 sites)', c => both(c, r => sum(r.sites, 'exceptions'))],
  ['YouTube: average time until the video played (s)', c => both(c, r => mean(r.youtube.map(v => v.mainVideoPlayedAfterMs)) / 1000, 1)],
  ['**CPU (seconds of processor time)**', null],
  ['Start-up, first 45 s', c => both(c, r => r.startupCpuSecondsFirst45s, 1)],
  ['Idle, one blank tab, per 30 s', c => both(c, r => r.idleCpuSecondsPer30s, 2)],
  ['Loading the 5 sites (plus 20 s settling)', c => both(c, r => r.sitesCpuSeconds, 1)],
  ['Idle with the 5 sites open, per 60 s', c => both(c, r => r.idleWithTabsCpuSecondsPer60s, 1)],
  ['**Memory (private MB)**', null],
  ['After start-up: total', c => both(c, r => r.startupMemory.totalMB)],
  ['After start-up: blocker extension', c => both(c, r => r.startupMemory.groups.extensions)],
  ['After start-up: main process', c => both(c, r => r.startupMemory.groups.main)],
  ['Idle (one blank tab): total', c => both(c, r => r.idleMemory.totalMB)],
  ['Idle: blocker extension', c => both(c, r => r.idleMemory.groups.extensions)],
  ['Idle: main process', c => both(c, r => r.idleMemory.groups.main)],
  ['With the 5 sites open: total', c => both(c, r => r.loadedMemory.totalMB)],
  ['With the 5 sites open: web pages', c => both(c, r => r.loadedMemory.groups.pages)],
  ['With the 5 sites open: blocker extension', c => both(c, r => r.loadedMemory.groups.extensions)],
  ['With the 5 sites open: main process', c => both(c, r => r.loadedMemory.groups.main)],
  ['With the 5 sites open: GPU', c => both(c, r => r.loadedMemory.groups.gpu)],
  ['With the 5 sites open: processes', c => both(c, r => r.loadedMemory.processes)],
  ['Time to Min window (ms)', c => both(c, r => r.startupMs)]
]
let md = '| | ' + CONFIGS.map(c => NAMES[c]).join(' | ') + ' |\n|---|' + CONFIGS.map(() => '---').join('|') + '|\n'
for (const [label, fn] of rows) {
  md += fn ? `| ${label} | ${CONFIGS.map(fn).join(' | ')} |\n` : `| ${label} | | | | |\n`
}
// per site
const sites = (runs.none[0] || runs.min[0] || {}).sites || []
md += '\n**Per site** (ad/tracker requests loaded · visible ad slots · load ms; run 1 / run 2)\n\n| Site | ' + CONFIGS.map(c => NAMES[c]).join(' | ') + ' |\n|---|' + CONFIGS.map(() => '---').join('|') + '|\n'
for (const [i, s] of sites.entries()) {
  md += `| ${new URL(s.site).hostname.replace('www.', '')} | ` + CONFIGS.map(c => runs[c].map(r => { const x = r.sites[i]; return x ? `${x.adTrackerLoaded}·${x.visibleAdSlots}·${x.loadMs > 0 ? x.loadMs : '>35s'}` : '–' }).join(' / ')).join(' | ') + ' |\n'
}
const notes = CONFIGS.flatMap(c => runs[c].flatMap(r => [].concat(r.stoppedEarly ? [`${c}-${r.run}: stopped early: ${r.stoppedEarly}`] : [], r.notes || [], r.install ? [`${c}-${r.run} install: ${r.install.listed}`] : [])))
md += '\n' + notes.map(n => '- ' + n).join('\n') + '\n'
fs.writeFileSync(path.join(dir, 'summary.md'), md)
console.log(md)
