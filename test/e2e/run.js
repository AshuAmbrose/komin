// Runs Min's end-to-end suites one after another and prints a summary (test/e2e/README.md).
// usage: npm run test:e2e                      every regression suite (about 25 min)
//        npm run test:e2e -- extensions-toolbar storage-and-passwords     just these
//        MIN_TEST_PACKAGED=1 npm run test:e2e   the same suites against dist/app/win-unpacked/Min.exe (build it first),
//                                             plus whole-app-trim, which only the packaged app can do
// Each suite writes test/e2e/results/<suite>.json (every check) and <suite>.log (what Min printed).
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')

const REGRESSION = [
  'adblock-first-start',
  'extensions-core',
  'extensions-webstore',
  'extensions-toolbar',
  'extensions-real-popups',
  'extensions-network',
  'extensions-apis',
  'extensions-startup',
  'extensions-footprint',
  'extensions-youtube',
  'storage-and-passwords',
  'userscripts-basics',
  'userscripts-functions',
  'userscripts-real',
  'performance-defaults',
  'performance-settings',
  'electron-workarounds'
]
const packaged = process.env.MIN_TEST_PACKAGED === '1'
const suites = process.argv.length > 2 ? process.argv.slice(2) : REGRESSION.concat(packaged ? ['whole-app-trim'] : [])

const summary = []
for (const suite of suites) {
  const file = path.join(__dirname, suite + '.js')
  if (!fs.existsSync(file)) {
    console.log('no suite named ' + suite)
    summary.push({ suite, result: 'missing' })
    continue
  }
  console.log('\n=== ' + suite + (packaged ? ' (packaged)' : ''))
  const start = Date.now()
  const run = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env })
  let result = 'no results'
  try {
    const out = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', suite + '.json'), 'utf8'))
    result = out.passed + '/' + out.total + (out.stoppedEarly ? ' (stopped: ' + out.stoppedEarly.slice(0, 80) + ')' : '') + (out.screenLocked ? ' [screen locked]' : '')
  } catch (e) {}
  summary.push({ suite, result, ok: run.status === 0, minutes: ((Date.now() - start) / 60000).toFixed(1) })
}

console.log('\n=== summary')
for (const s of summary) {
  console.log((s.ok ? 'ok    ' : 'FAIL  ') + s.suite.padEnd(26) + String(s.result).padEnd(40) + (s.minutes ? s.minutes + ' min' : ''))
}
process.exit(summary.every(s => s.ok) ? 0 : 1)
