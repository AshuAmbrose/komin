// Opens Min with a throwaway profile, to look at it or try a change by hand, without touching the maintainer's profiles
// (%APPDATA%\Min, their everyday browser, and %APPDATA%\Min-development, which `npm start` uses and which holds their test
// data). Runs the dev build (run `npm run build` first), or the packaged app with MIN_TEST_PACKAGED=1. The profile starts
// like the suites' (no usage statistics or update checks, no first-run tour, the cached ad-block engine). Min's output
// goes to this terminal. When Min closes (or on Ctrl+C) the profile is deleted; MIN_TEST_KEEP_PROFILE=1 keeps it.
// usage: node test/e2e/open.js [url]
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { CACHE } = require('./harness')

const root = path.resolve(__dirname, '..', '..')
const packaged = process.env.MIN_TEST_PACKAGED === '1'
const url = process.argv[2]

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-open-'))
// Min adds "-development" to --user-data-dir in development mode, so its profile is <userDataDir>-development
const userDataDir = path.join(runDir, 'profile')
const profileDir = userDataDir + '-development'
fs.mkdirSync(profileDir, { recursive: true })
fs.writeFileSync(path.join(profileDir, 'settings.json'), JSON.stringify({ collectUsageStats: false, updateNotificationsEnabled: false }))
fs.writeFileSync(path.join(profileDir, 'sessionRestore.json'), JSON.stringify({ version: 2, state: { tasks: [] } }))
const engine = path.join(CACHE, 'adblocker-engine-v2.bin')
if (fs.existsSync(engine)) {
  fs.copyFileSync(engine, path.join(profileDir, 'adblocker-engine-v2.bin'))
}

const args = ['--user-data-dir=' + userDataDir, '--development-mode'].concat(url ? [url] : [])
const child = packaged
  ? spawn(path.join(root, 'dist/app/win-unpacked/Min.exe'), args, { cwd: path.join(root, 'dist/app/win-unpacked'), stdio: 'inherit' })
  : spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), ['.'].concat(args), { cwd: root, stdio: 'inherit' })
console.log('Min is open with a throwaway profile: ' + profileDir)

function cleanUp () {
  if (process.env.MIN_TEST_KEEP_PROFILE === '1') {
    console.log('profile kept: ' + profileDir)
    return
  }
  try {
    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
    console.log('profile deleted')
  } catch (e) {
    console.log('couldn\'t delete ' + runDir + ': ' + e.message)
  }
}

child.on('exit', code => {
  cleanUp()
  process.exit(code || 0)
})
child.on('error', e => {
  console.log('couldn\'t start Min: ' + e.message)
  cleanUp()
  process.exit(1)
})
process.on('SIGINT', () => child.kill())
