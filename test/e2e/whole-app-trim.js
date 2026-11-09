// The packaged app only: whole-app trimming (main.js, trimMemory.exe min --exclude <protected pids>). With Dark Reader installed
// and a tab playing (silent) media: minimized, every process shrinks except the media tab's; restored, everything works.
// usage: npm run build, node scripts/buildWindows.js --arch=x64, then MIN_TEST_PACKAGED=1 node test/e2e/whole-app-trim.js
// Whole-app trimming works by process name, so it also trims an installed Min that is running (as that Min does itself
// when it's minimized), and an installed Min that is minimized trims this run's processes: quit it for clean numbers.
if (process.env.MIN_TEST_PACKAGED !== '1') {
  console.log('whole-app-trim tests the packaged app only: set MIN_TEST_PACKAGED=1 (after building it)')
  process.exit(2)
}
const path = require('path')
const http = require('http')
const t = require('./harness')({ name: 'whole-app-trim', minutes: 8, extensions: ['eimadpbcbfnmbkopoojfekhnkhdbieeh'] })
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui } = t
const { execFileSync } = require('child_process')
const DARK_READER = t.crx('eimadpbcbfnmbkopoojfekhnkhdbieeh')
const MEDIA_PORT = 8781
// one second of silence as a WAV file, looped
const silence = (() => { const rate = 8000; const data = Buffer.alloc(rate); const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40); data.fill(128); return Buffer.concat([header, data]) })()
const mediaServer = http.createServer((req, res) => {
  if (req.url.startsWith('/silence.wav')) {
    res.writeHead(200, { 'content-type': 'audio/wav' })
    return res.end(silence)
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>media</title><audio id="a" src="/silence.wav" loop></audio><p>media page</p>')
}).listen(MEDIA_PORT, '127.0.0.1')
const MEDIA = `http://127.0.0.1:${MEDIA_PORT}/media`
const states = () => JSON.parse(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'process-states.ps1'), '-Name', 'Min.exe', '-Root', t.root]).toString())
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    const u = await ui()
    await sleep(1500)
    check('the packaged app runs (process name, version, path)', await main.evaluate("(() => { const e = process.mainModule.require('electron'); return e.app.isPackaged && /win-unpacked/.test(process.execPath) && e.app.getVersion() === " + JSON.stringify(require(path.join(t.root, 'package.json')).version) + " && e.app.getPath('userData').endsWith('-development') })()"), await main.evaluate("({ packaged: process.mainModule.require('electron').app.isPackaged, exe: process.execPath, version: process.mainModule.require('electron').app.getVersion(), userData: process.mainModule.require('electron').app.getPath('userData') })"))
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(DARK_READER)}; 1`)
    check('an extension installs in the package', (await s.evaluate("extensionPages.request('install-crx').catch(e => 'ERROR ' + e.message)")) === 'eimadpbcbfnmbkopoojfekhnkhdbieeh')
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(PAGE + '?other')} }); 1`)
    await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(MEDIA)} }); 1`)
    await sleep(4000)
    // start the media as if the user had clicked play (the test's own gesture)
    await main.evaluate(`process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL() === ${JSON.stringify(MEDIA)}).executeJavaScript("document.getElementById('a').play().then(() => 'playing')", true)`)
    await sleep(3000)
    const mediaPid = await main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL() === ${JSON.stringify(MEDIA)}); return { pid: wc.getOSProcessId(), playing: !!wc._isMediaPlaying } })()`)
    check('the media tab counts as playing', mediaPid.playing, mediaPid)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    await sleep(5000)
    const before = states()
    console.log('IN USE ' + JSON.stringify(before.map(p => p.kind + ' ' + p.pid + ' ' + p.workingSetMB)))
    // the window's state and events after minimizing explain a run where nothing was trimmed: Min trims only while no
    // window of it is focused, and on a locked screen Windows kept focus on the minimized window and sent no blur
    await main.evaluate(`(() => { const win = ${WIN}; global.__windowEvents = []; ['minimize', 'blur'].forEach(name => win.once(name, () => global.__windowEvents.push(name))); win.setAlwaysOnTop(false); win.minimize(); return 1 })()`)
    await sleep(10000)
    const windowState = await main.evaluate(`(() => { const e = process.mainModule.require('electron'); const win = ${WIN}; return { minimized: win.isMinimized(), visible: win.isVisible(), focused: e.BaseWindow.getFocusedWindow() === win, events: global.__windowEvents, displays: e.screen.getAllDisplays().length } })()`)
    check('minimized: the window counts as not in use (info: minimized, not focused, blur sent)', true, Object.assign({ screenLocked: t.isScreenLocked() }, windowState))
    const after = states()
    console.log('MINIMIZED ' + JSON.stringify(after.map(p => p.kind + ' ' + p.pid + ' ' + p.workingSetMB)))
    const total = list => list.reduce((sum, p) => sum + p.workingSetMB, 0)
    const others = list => list.filter(p => p.pid !== mediaPid.pid)
    const media = list => list.find(p => p.pid === mediaPid.pid)
    check('minimized: Min\'s processes are trimmed (all but the media tab, together)', total(others(after)) < total(others(before)) * 0.4, { before: total(others(before)), after: total(others(after)) })
    check('minimized: the main and GPU processes are trimmed too', after.filter(p => p.kind === 'browser' || p.kind === 'gpu-process').every(p => p.workingSetMB < (before.find(b => b.pid === p.pid) || { workingSetMB: 0 }).workingSetMB * 0.5), after.filter(p => p.kind === 'browser' || p.kind === 'gpu-process'))
    check('minimized: the tab playing media is left alone', media(after) && media(before) && media(after).workingSetMB > media(before).workingSetMB * 0.7, { before: media(before), after: media(after) })
    await main.evaluate(`(() => { const win = ${WIN}; win.restore(); win.focus(); return 1 })()`)
    await sleep(3000)
    const page = await target(t => t.url === PAGE + '?other')
    check('restored: pages and the extension still work', page && (await page.evaluate('document.title')) && (await main.evaluate("Object.values(process.mainModule.require('electron').session.fromPartition('persist:webcontent').serviceWorkers.getAllRunning()).some(w => w.scope.includes('eimadpbcbfnmbkopoojfekhnkhdbieeh'))")))
    await s.evaluate("extensionPages.request('remove', { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh' })")
    s.close()
    u.close()
    await quit(main)
    mediaServer.close()
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    mediaServer.close()
    finish()
  }
})()
