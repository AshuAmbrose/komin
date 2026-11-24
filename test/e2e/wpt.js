// web-platform-tests (the browsers' shared standards suite, https://wpt.fyi) run in Min and in a bare Electron app with
// the same Chromium (test/e2e/wpt-baseline), to find where Min's own code changes how pages behave: pop-ups and
// navigation (main/viewManager.js), permissions, the scripts it adds to every page, its network hooks. Chromium's own
// failures show up in both and are left out of the comparison.
// usage:
//   node test/e2e/wpt.js setup                  a partial copy of the suite in the test cache (FOLDERS below), its manifest
//   node test/e2e/wpt.js run <min|electron> [folder or test ...]   runs the tests (all FOLDERS by default) and writes
//                                               results/wpt-<app>.json; a run of some folders or tests (a path such as
//                                               xhr/open-method-bogus.htm) replaces only their results in that file
//                                               @compare instead of a folder: the tests in the last comparison
//   node test/e2e/wpt.js compare [label]        tests and subtests that pass in plain Electron and not in Min:
//                                               results/wpt-compare.json, each such test marked when it (or a script it
//                                               loads) opens windows, which Min turns into tabs (opensWindows); with a
//                                               label, Min's results of that labelled run (wpt-compare-<label>.json)
// A Min run can differ from the default for one run, with a label of its own (results/wpt-min-<label>.json):
//   MIN_WPT_LABEL=<label>                         the results file's label (required with the two below)
//   MIN_WPT_SETTINGS='{"enableAutoplay":true}'    settings seeded in the run's profile
//   MIN_WPT_SWITCH=popupsAsNewTabs                Min's code changed for the run (SWITCHES below; main.build.js is put
//                                               back afterwards)
// Needs git and Python 3. The suite's server runs on ports 8000-8002, 8443-8445 and 49001-49002; its test domains
// (web-platform.test and the like) go to 127.0.0.1 through Chromium's --host-resolver-rules, so Windows' hosts file stays
// as it is. Tests that need WebDriver (testdriver.js: clicks, permissions) fail or time out in both apps. On Windows the
// display is kept on while it runs (keep-display-on.ps1, as run.js does): an idle display that turns off counts as
// covering every window, and pages then count as hidden (AGENTS.md pitfall 54).
/* global AbortSignal */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CACHE = path.join(os.tmpdir(), 'min-e2e-cache')
const WPT = path.join(CACHE, 'wpt')
const RESULTS = path.join(__dirname, 'results')
// the parts of the suite Min's own code can affect, and what every test needs
const SUPPORT = ['resources', 'tools', 'docs', 'common', 'images', 'fonts', 'media'] // docs: the suite's tool reads a command list there
const FOLDERS = [
  'html/browsers', // windows, pop-ups, navigation, history, the window object
  'html/webappapis/user-prompts', // alert, confirm, prompt
  'html/user-activation',
  'html/semantics/scripting-1', // scripts: Min adds its own to every page
  'fetch/api', // every request passes Min's network hooks
  'xhr',
  'service-workers/service-worker', // the extension library's preload starts in every service worker
  'notifications',
  'permissions',
  'fullscreen'
  // not 'referrer-policy/gen' (about 1,100 generated pages): Min doesn't change referrers, and they'd add an hour per app
]
// what a Min run can change in Min's own code, for one run (MIN_WPT_SWITCH). On 2026-11-14 a switch popupsKeepOpener
// showed the opposite of this one: with upstream's rule off, 99 of the 107 tests failing only in Min passed, which led to
// the change of 2026-11-17
const SWITCHES = {
  // window.open() without features (and links opening a new tab) go to a tab Min opens itself, and the page gets null,
  // as before 2026-11-17 (old-behaviour.js)
  popupsAsNewTabs: t => require('./old-behaviour')(t, ['popupsAsNewTabs'])
}
const ORIGIN = 'http://web-platform.test:8000'
const HTTPS_ORIGIN = 'https://web-platform.test:8443'
// tests named .https. or in an https folder must load over HTTPS (service workers need it)
const originFor = url => /\.https\.|\/https\//.test(url) ? HTTPS_ORIGIN : ORIGIN
const RESOLVER = '--host-resolver-rules=MAP web-platform.test 127.0.0.1, MAP *.web-platform.test 127.0.0.1, MAP not-web-platform.test 127.0.0.1, MAP *.not-web-platform.test 127.0.0.1, MAP *.xn--n8j6ds53lwwkrqhv28a.web-platform.test 127.0.0.1'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// every testharness.js test page reports through this file: the runner reads the results it keeps
const TESTHARNESS_REPORT = `// Replaced by Min's test runner (test/e2e/wpt.js): keeps every result for the runner to read
add_completion_callback(function (tests, status) {
  window.__minWptResults = {
    status: status.status,
    message: status.message ? String(status.message).slice(0, 500) : null,
    tests: tests.map(function (t) { return { name: t.name, status: t.status, message: t.message ? String(t.message).slice(0, 500) : null } })
  }
})
`

function setup () {
  if (!fs.existsSync(path.join(WPT, '.git'))) {
    fs.mkdirSync(CACHE, { recursive: true })
    execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', 'https://github.com/web-platform-tests/wpt.git', WPT], { stdio: 'inherit' })
  }
  execFileSync('git', ['sparse-checkout', 'set', ...SUPPORT, ...FOLDERS], { cwd: WPT, stdio: 'inherit' })
  fs.writeFileSync(path.join(WPT, 'resources', 'testharnessreport.js'), TESTHARNESS_REPORT)
  // the server binds to 127.0.0.1 and doesn't check that the test domains resolve: Windows can't look them up (only the
  // browsers, through --host-resolver-rules, can)
  fs.writeFileSync(path.join(WPT, 'min-serve-config.json'), JSON.stringify({ server_host: '127.0.0.1', check_subdomains: false }))
  console.log('building the manifest (the list of tests)...')
  execFileSync('python', ['wpt', 'manifest', '--no-download', '--path', path.join(WPT, 'MANIFEST.json')], { cwd: WPT, stdio: 'inherit' })
  console.log('ready: ' + WPT)
}

// [url, timeout ms] for every testharness test in these folders, from the suite's manifest
function listTests (folders) {
  const manifest = JSON.parse(fs.readFileSync(path.join(WPT, 'MANIFEST.json'), 'utf8'))
  const tests = []
  const walk = (node, at) => {
    for (const [name, value] of Object.entries(node)) {
      const here = at ? at + '/' + name : name
      if (Array.isArray(value)) {
        // [hash, [url, {timeout}], ...]
        for (const item of value.slice(1)) {
          const url = item[0] || '/' + here
          if (folders.some(folder => url.startsWith('/' + folder + '/') || url.split('?')[0] === '/' + folder) && !/\.h2\./.test(url)) {
            tests.push([url, item[1] && item[1].timeout === 'long' ? 60000 : 12000])
          }
        }
      } else {
        walk(value, here)
      }
    }
  }
  walk(manifest.items.testharness || {}, '')
  return tests.sort((a, b) => a[0].localeCompare(b[0]))
}

function startServer () {
  const server = spawn('python', ['wpt', 'serve', '--no-h2', '--config', 'min-serve-config.json'], { cwd: WPT, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', d => { log = (log + d).slice(-20000) })
  server.stderr.on('data', d => { log = (log + d).slice(-20000) })
  server.log = () => log
  return server
}

async function run (app, folders) {
  if (!fs.existsSync(path.join(WPT, 'MANIFEST.json'))) {
    console.error('run `node test/e2e/wpt.js setup` first')
    process.exit(2)
  }
  // the page that reports results: written at every run, so a change to it needs no new setup
  fs.writeFileSync(path.join(WPT, 'resources', 'testharnessreport.js'), TESTHARNESS_REPORT)
  // @compare: the tests the last comparison found broken in Min, or with a subtest failing only in Min
  if (folders.includes('@compare')) {
    const diff = JSON.parse(fs.readFileSync(path.join(RESULTS, 'wpt-compare.json'), 'utf8'))
    const urls = new Set(diff.testsOnlyBrokenInMin.map(x => x.url).concat(diff.subtestsOnlyFailingInMin.map(x => x.url)))
    folders = folders.filter(f => f !== '@compare').concat(Array.from(urls).map(u => u.slice(1)))
  }
  const label = process.env.MIN_WPT_LABEL || ''
  const extraSettings = JSON.parse(process.env.MIN_WPT_SETTINGS || '{}')
  const switches = (process.env.MIN_WPT_SWITCH || '').split(',').map(s => s.trim()).filter(Boolean)
  if ((Object.keys(extraSettings).length || switches.length) && (!label || app !== 'min')) {
    console.error('MIN_WPT_SETTINGS and MIN_WPT_SWITCH need a Min run with MIN_WPT_LABEL, so the default results stay')
    process.exit(2)
  }
  switches.forEach(s => { if (!SWITCHES[s]) throw new Error('MIN_WPT_SWITCH: unknown ' + s + ' (known: ' + Object.keys(SWITCHES).join(', ') + ')') })
  const tests = listTests(folders)
  console.log(tests.length + ' tests' + (label ? ' (' + label + ')' : '') + ' in ' + (folders.length > 12 ? folders.length + ' folders and tests' : folders.join(', ')))
  if (process.platform === 'win32' && process.env.MIN_TEST_DISPLAY !== 'leave') {
    const keeper = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'keep-display-on.ps1'), '-WatchPid', String(process.pid)], { stdio: 'ignore', windowsHide: true })
    keeper.unref()
    process.env.MIN_TEST_DISPLAY_KEPT_ON = '1' // read by the harness
  }
  const name = 'wpt-' + app + (label ? '-' + label : '')
  const t = require('./harness')({ name, minutes: 15 + Math.ceil(tests.length * 4 / 60), stopOnMainErrors: false, settings: extraSettings })
  const { check, finish, target, waitFor, launch, quit, ui, list } = t
  switches.forEach(s => SWITCHES[s](t))
  const server = startServer()
  process.on('exit', () => server.kill())
  const outFile = path.join(RESULTS, name + '.json')
  let out = { app, label, settings: extraSettings, switches, date: new Date().toISOString(), folders, results: {} }
  // a run of some tests updates theirs in the full run's file
  if (folders !== FOLDERS && fs.existsSync(outFile)) {
    out = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    out.reruns = (out.reruns || []).concat({ date: new Date().toISOString(), folders, tests: tests.length })
  }
  const ranNow = new Set()
  const save = () => fs.writeFileSync(outFile, JSON.stringify(out))
  // kept even if the run is stopped early (time limit, Ctrl+C)
  process.on('exit', save)
  try {
    const up = await waitFor(async () => (await fetch('http://127.0.0.1:8000/', { signal: AbortSignal.timeout(2000) })).ok, 60000)
    if (!up) {
      check('the suite\'s server started', false, server.log().slice(-1500))
      return finish()
    }
    const args = [RESOLVER, '--ignore-certificate-errors']
    let main = null
    let page = null
    let pageId = null
    let runnerTab = null
    let u = null
    // starts the app with one page to run tests in (Min: a tab; the bare app: its window)
    const start = async () => {
      if (main) {
        if (u) u.close()
        await quit(main)
      }
      main = await launch(app === 'min' ? 'about:blank' : ORIGIN + '/', app === 'min' ? { args } : { args, app: 'test/e2e/wpt-baseline' })
      if (app === 'min') {
        u = await ui()
        await sleep(1500)
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(ORIGIN + '/')} }); 1`)
        page = await target(x => x.type === 'page' && x.url.startsWith(ORIGIN), 20000)
        runnerTab = await u.evaluate(`tabs.get().find(t => t.url.startsWith(${JSON.stringify(ORIGIN)})).id`)
      } else {
        page = await target(x => x.type === 'page' && x.url.startsWith(ORIGIN), 20000)
      }
      const found = (await list()).find(x => x.type === 'page' && x.url.startsWith(ORIGIN))
      pageId = found ? found.id : null
    }
    // the page's results, or null; a page that doesn't answer within 3 s counts as not done (never the harness's 30 s)
    const readResults = async () => {
      const r = await Promise.race([page.send('Runtime.evaluate', { expression: 'window.__minWptResults || null', returnByValue: true }), sleep(3000).then(() => null)])
      const value = r && r.result && r.result.result && r.result.result.value
      return value && typeof value === 'object' ? value : null
    }
    // closes what a test left open: Min's other tabs, the bare app's other windows
    const tidy = async () => {
      if (app === 'min') {
        await u.evaluate(`tabs.get().filter(t => t.id !== ${JSON.stringify(runnerTab)}).forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1`)
      } else {
        await main.evaluate("(() => { const all = process.mainModule.require('electron').BrowserWindow.getAllWindows(); all.slice(1).forEach(w => w.destroy()); return all.length })()")
      }
    }
    await start()
    let sinceStart = 0
    for (const [url, timeout] of tests) {
      // a fresh app every 250 tests, and after anything that broke or closed the page (a test calling window.close())
      if (sinceStart >= 250 || !page || !pageId || !(await list()).some(x => x.id === pageId)) {
        await start()
        sinceStart = 0
      }
      sinceStart++
      let result
      try {
        await Promise.race([page.send('Page.navigate', { url: originFor(url) + url }), sleep(10000)])
        result = await waitFor(readResults, timeout)
        if (!result) {
          result = { status: 'RUNNER_TIMEOUT' }
        }
      } catch (e) {
        result = { status: 'RUNNER_ERROR', message: String(e.message || e).slice(0, 500) }
        page = null
      }
      out.results[url] = result
      ranNow.add(url)
      try {
        await tidy()
      } catch (e) {
        page = null
      }
      if (ranNow.size % 10 === 0) {
        save()
      }
      if (ranNow.size % 100 === 0) {
        console.log(ranNow.size + ' / ' + tests.length)
      }
    }
    save()
    const values = Array.from(ranNow).map(url => out.results[url])
    const subtests = values.flatMap(r => r.tests || [])
    check('ran (info)', true, {
      tests: values.length,
      harnessOK: values.filter(r => r.status === 0).length,
      runnerTimeouts: values.filter(r => r.status === 'RUNNER_TIMEOUT').length,
      subtests: subtests.length,
      subtestsPassing: subtests.filter(s => s.status === 0).length
    })
    if (u) u.close()
    await quit(main)
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    save()
  }
  server.kill()
  finish()
}

// whether a test opens windows (window.open, a link or form with a target), in its own source or in a script it loads
// from the suite (one level: the helpers in common/ and resources/ folders). Min opens them as tabs with no link back to
// the page that opened them (main/viewManager.js, setWindowOpenHandler), so window.open() gives the page null.
function opensWindows (url) {
  const file = path.join(WPT, url.split('?')[0].replace(/\.any\.(?:worker|serviceworker|sharedworker)?\.?html$/, '.any.js').replace(/\.(window|worker)\.html$/, '.$1.js'))
  const read = f => { try { return fs.readFileSync(f, 'utf8') } catch (e) { return '' } }
  const source = read(file)
  const opens = text => /(?:window|win|w|self|globalThis|frames\[\d\])\.open\s*\(|(?:^|[^.\w])open\s*\(\s*['"`\w]|target\s*=\s*["']?_blank|noopener|window\.opener/.test(text)
  if (opens(source)) {
    return true
  }
  const scripts = Array.from(source.matchAll(/(?:src=["']|from\s+["']|META:\s*script=)([^"'\s>]+)/g)).map(m => m[1].split('?')[0])
    .filter(s => !/^https?:|testharness|testdriver/.test(s))
  return scripts.some(s => opens(read(s.startsWith('/') ? path.join(WPT, s) : path.join(path.dirname(file), s))))
}

// what passes in the bare app and not in Min: those are Min's doing
function compare (label) {
  const read = app => JSON.parse(fs.readFileSync(path.join(RESULTS, 'wpt-' + app + '.json'), 'utf8')).results
  const min = read(label ? 'min-' + label : 'min')
  const electron = read('electron')
  const diff = { testsOnlyBrokenInMin: [], subtestsOnlyFailingInMin: [], subtestsOnlyPassingInMin: [], counted: { tests: 0, subtests: 0 } }
  for (const [url, base] of Object.entries(electron)) {
    const ours = min[url]
    if (!ours) {
      continue
    }
    diff.counted.tests++
    const baseOK = base.status === 0
    const oursOK = ours.status === 0
    if (baseOK && !oursOK) {
      diff.testsOnlyBrokenInMin.push({ url, min: ours.status, message: ours.message || null, opensWindows: opensWindows(url) })
    }
    const baseByName = new Map((base.tests || []).map(s => [s.name, s]))
    for (const sub of ours.tests || []) {
      const b = baseByName.get(sub.name)
      if (!b) {
        continue
      }
      diff.counted.subtests++
      if (b.status === 0 && sub.status !== 0) {
        diff.subtestsOnlyFailingInMin.push({ url, name: sub.name, status: sub.status, message: sub.message })
      } else if (b.status !== 0 && sub.status === 0) {
        diff.subtestsOnlyPassingInMin.push({ url, name: sub.name })
      }
    }
    // a whole test that passes in Electron but never reports in Min: all its subtests count
    if (baseOK && !ours.tests) {
      for (const b of base.tests || []) {
        if (b.status === 0) {
          diff.subtestsOnlyFailingInMin.push({ url, name: b.name, status: ours.status, message: 'no results in Min' })
        }
      }
    }
  }
  const byFolder = {}
  for (const item of diff.subtestsOnlyFailingInMin) {
    const folder = item.url.split('/').slice(1, 4).join('/')
    byFolder[folder] = (byFolder[folder] || 0) + 1
  }
  diff.subtestsOnlyFailingInMinByFolder = byFolder
  const windowless = diff.testsOnlyBrokenInMin.filter(x => !x.opensWindows)
  fs.writeFileSync(path.join(RESULTS, 'wpt-compare' + (label ? '-' + label : '') + '.json'), JSON.stringify(diff, null, 2))
  console.log(JSON.stringify({ counted: diff.counted, testsOnlyBrokenInMin: diff.testsOnlyBrokenInMin.length, ofThoseOpeningWindows: diff.testsOnlyBrokenInMin.length - windowless.length, subtestsOnlyFailingInMin: diff.subtestsOnlyFailingInMin.length, subtestsOnlyPassingInMin: diff.subtestsOnlyPassingInMin.length, byFolder }, null, 2))
  console.log('\nbroken only in Min, opening no windows:\n  ' + windowless.map(x => x.url + ' (' + x.min + ')').join('\n  '))
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'setup') {
  setup()
} else if (command === 'run' && ['min', 'electron'].includes(rest[0])) {
  run(rest[0], rest.length > 1 ? rest.slice(1) : FOLDERS)
} else if (command === 'compare') {
  compare(rest[0])
} else {
  console.error('usage: node test/e2e/wpt.js setup | run <min|electron> [folder or test ... | @compare] | compare [label]')
  process.exit(2)
}
