// The extension library's own tests (electron-chrome-extensions, from samuelmaddock/electron-browser-shell, MIT): its
// mocha suite (tabs, toolbar buttons, right-click menus, notifications, windows, native messaging, loading extensions),
// run with Min's Electron instead of the one its repository names (44), to show whether the library itself works on the
// Electron Min ships. They test the library on its own, in its own small test app: Min changes several of its answers
// (its tab list, permission checks, the API objects it puts back; section 10.9), which Min's own suites test.
// usage:
//   node test/e2e/library-tests.js setup   a copy of the repository at the library version Min uses (git, in the test
//                                          cache) and its development packages (yarn, from the internet, about 560;
//                                          Electron's own download is skipped)
//   node test/e2e/library-tests.js [run]   builds the library there and runs its tests (about 2 minutes);
//                                          results/library-tests.json
// Run after every Electron or electron-chrome-extensions upgrade (setup again for a new library version).
//   node test/e2e/library-tests.js run native-messaging   also the 2 native messaging tests (the maintainer agreed on
//                                          2026-11-24). Their setup builds a test program and registers it for Google
//                                          Chrome on Windows: a key, HKCU\Software\Google\Chrome\NativeMessagingHosts\
//                                          com.crx.test, which the user's own Chrome reads, and a folder,
//                                          %APPDATA%\Electron\NativeMessagingHosts. The runner notes which of the two
//                                          were there before (a state file in the test cache), removes the ones the tests
//                                          added once they end, even after a failure, and first thing in the next run if
//                                          one was stopped, and records what's left in the results. Without the option
//                                          those tests are left out.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { CACHE } = require('./harness')

const ROOT = path.join(__dirname, '..', '..')
const REPO = path.join(CACHE, 'electron-browser-shell')
const PACKAGE = path.join(REPO, 'packages', 'electron-chrome-extensions')
const RESULTS = path.join(__dirname, 'results', 'library-tests.json')
const version = require(path.join(ROOT, 'node_modules', 'electron-chrome-extensions', 'package.json')).version
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version
// what the tests need from the install (yarn stopped once on a sibling package's folder, the right-click menu library's,
// on Windows: "EEXIST ... electron-chrome-context-menu\node_modules\.bin"; these were all there anyway)
const NEEDED = ['mocha', 'ts-node', 'chai', 'chai-as-promised', 'esbuild', 'typescript', 'colors', 'minimist', 'walkdir', 'yargs']

const NATIVE_MESSAGING = process.argv.includes('native-messaging')
const HOST_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.crx.test'
const HOST_FOLDER = path.join(os.homedir(), 'AppData', 'Roaming', 'Electron', 'NativeMessagingHosts')
const NATIVE_STATE = path.join(CACHE, 'library-tests-native-messaging.json')

const run = (command, args, options = {}) => spawnSync(command, args, Object.assign({ encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 }, options))
const yarn = (args, cwd, env = {}, timeout = 600000) => run('npx', ['--yes', 'yarn@1.22.22'].concat(args), { cwd, timeout, env: Object.assign({}, process.env, env) })
const missing = () => NEEDED.filter(name => !fs.existsSync(path.join(REPO, 'node_modules', name, 'package.json')))

function setup () {
  if (!fs.existsSync(REPO)) {
    const clone = run('git', ['clone', '--depth', '1', '--branch', 'electron-chrome-extensions@' + version, 'https://github.com/samuelmaddock/electron-browser-shell', JSON.stringify(REPO)], { stdio: 'inherit' })
    if (clone.status !== 0) {
      console.error('git clone failed')
      process.exit(1)
    }
  }
  const install = yarn(['install', '--frozen-lockfile', '--non-interactive'], REPO, { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' })
  console.log(String(install.stdout || '').split('\n').slice(-6).join('\n'), String(install.stderr || '').split('\n').slice(-4).join('\n'))
  const lacking = missing()
  console.log(lacking.length ? 'still missing: ' + lacking.join(', ') : 'ready: ' + REPO)
  process.exit(lacking.length ? 1 : 0)
}

const hostKeyExists = () => run('reg', ['query', '"' + HOST_KEY + '"']).status === 0

// removes what the native messaging tests added, as the state file says (only what wasn't there before)
function removeNativeMessagingHost () {
  if (!fs.existsSync(NATIVE_STATE)) {
    return null
  }
  const added = JSON.parse(fs.readFileSync(NATIVE_STATE, 'utf8'))
  if (added.key && hostKeyExists()) {
    run('reg', ['delete', '"' + HOST_KEY + '"', '/f'])
  }
  if (added.folder && fs.existsSync(HOST_FOLDER)) {
    fs.rmSync(HOST_FOLDER, { recursive: true, force: true })
  }
  const left = { keyLeft: added.key && hostKeyExists(), folderLeft: added.folder && fs.existsSync(HOST_FOLDER) }
  if (!left.keyLeft && !left.folderLeft) {
    fs.rmSync(NATIVE_STATE, { force: true })
  }
  return Object.assign({ removedKey: added.key, removedFolder: added.folder }, left)
}

// the test program's build calls `npx postject`, whose shortcut the install may have left out (see NEEDED)
function ensurePostjectShortcut () {
  const bin = path.join(REPO, 'node_modules', '.bin')
  const cli = path.join(REPO, 'node_modules', 'postject', 'dist', 'cli.js')
  fs.mkdirSync(bin, { recursive: true })
  if (!fs.existsSync(path.join(bin, 'postject.cmd'))) {
    fs.writeFileSync(path.join(bin, 'postject.cmd'), '@node "' + cli + '" %*\r\n')
  }
  if (!fs.existsSync(path.join(bin, 'postject'))) {
    fs.writeFileSync(path.join(bin, 'postject'), '#!/bin/sh\nexec node "' + cli + '" "$@"\n')
  }
}

// mocha's TAP output: "ok 3 name", "not ok 4 name" followed by an indented block with the error
function parseTap (text) {
  const tests = []
  const lines = text.split(/\r?\n/)
  lines.forEach(function (line, i) {
    const m = /^(not ok|ok) (\d+) (.*)$/.exec(line)
    if (!m) return
    const test = { name: m[3].trim(), passed: m[1] === 'ok' }
    if (!test.passed) {
      const block = []
      for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]) && block.length < 12; j++) block.push(lines[j].trim())
      test.error = block.join(' ').slice(0, 600)
    }
    tests.push(test)
  })
  return tests
}

function runTests () {
  if (!fs.existsSync(PACKAGE) || missing().length) {
    console.error('run `node test/e2e/library-tests.js setup` first' + (missing().length ? ' (missing: ' + missing().join(', ') + ')' : ''))
    process.exit(2)
  }
  const copyVersion = require(path.join(PACKAGE, 'package.json')).version
  const out = { date: new Date().toISOString(), libraryVersionInMin: version, libraryVersionTested: copyVersion, electron: electronVersion }
  if (copyVersion !== version) {
    console.log('warning: the copy is ' + copyVersion + ', Min uses ' + version + ' (delete ' + REPO + ' and run setup again)')
  }
  const started = Date.now()
  const build = yarn(['build'], PACKAGE)
  out.buildOK = build.status === 0
  if (!out.buildOK) {
    out.buildError = (String(build.stdout || '') + String(build.stderr || '')).slice(-2000)
    fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2))
    console.log('the library didn\'t build:\n' + out.buildError)
    process.exit(1)
  }
  // what `yarn test` does, its steps called directly (the install's .bin folder may be missing, see NEEDED): a test
  // preload bundled first (pretest), then the specs in Electron: Min's
  const esbuild = path.join(REPO, 'node_modules', 'esbuild', 'bin', 'esbuild')
  const pretest = run('node', [JSON.stringify(esbuild), 'spec/fixtures/crx-test-preload.ts', '--bundle', '--external:electron', '--outfile=spec/fixtures/crx-test-preload.js', '--platform=node'], { cwd: PACKAGE })
  if (pretest.status !== 0) {
    out.pretestError = (String(pretest.stdout || '') + String(pretest.stderr || '')).slice(-2000)
    fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2))
    console.log('the test preload didn\'t build:\n' + out.pretestError)
    process.exit(1)
  }
  // a run that was stopped may have left the native messaging host registered
  const earlier = removeNativeMessagingHost()
  if (earlier) out.removedFromAnEarlierRun = earlier
  let testArgs = ['script/spec-runner.js']
  if (NATIVE_MESSAGING) {
    ensurePostjectShortcut()
    fs.writeFileSync(NATIVE_STATE, JSON.stringify({ key: !hostKeyExists(), folder: !fs.existsSync(HOST_FOLDER) }))
    process.on('SIGINT', function () {
      removeNativeMessagingHost()
      process.exit(130)
    })
  } else {
    // every test but native messaging's (above): mocha's grep, inverted
    out.leftOut = 'nativeMessaging'
    testArgs = testArgs.concat(['-g', 'nativeMessaging', '-i'])
  }
  const test = run('node', testArgs, { cwd: PACKAGE, timeout: 900000, env: Object.assign({}, process.env, { ELECTRON_OVERRIDE_DIST_PATH: path.join(ROOT, 'node_modules', 'electron', 'dist') }) })
  const log = String(test.stdout || '') + String(test.stderr || '')
  if (NATIVE_MESSAGING) {
    out.nativeMessagingCleanup = removeNativeMessagingHost()
  }
  const tests = parseTap(log)
  Object.assign(out, {
    seconds: Math.round((Date.now() - started) / 1000),
    exitCode: test.status,
    total: tests.length,
    passed: tests.filter(x => x.passed).length,
    failed: tests.filter(x => !x.passed),
    tests,
    logTail: log.slice(-3000)
  })
  fs.writeFileSync(RESULTS, JSON.stringify(out, null, 2))
  console.log(out.passed + ' of ' + out.total + ' tests pass (electron-chrome-extensions ' + copyVersion + ' on Electron ' + electronVersion + ', ' + out.seconds + ' s)')
  out.failed.forEach(x => console.log('FAIL ' + x.name + '\n     ' + (x.error || '').slice(0, 300)))
  if (out.nativeMessagingCleanup) console.log('native messaging host removed: ' + JSON.stringify(out.nativeMessagingCleanup))
  if (tests.length === 0) console.log('no test results; the end of the log:\n' + out.logTail)
}

if (process.argv[2] === 'setup') {
  setup()
} else {
  runTests()
}
