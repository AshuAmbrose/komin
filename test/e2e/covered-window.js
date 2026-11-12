// Covered windows go idle (AGENTS.md section 10.4): with Min's window fully covered by another program's window, its pages
// count as hidden and draw nothing (no frames, almost no CPU); partly covered or visible, they draw normally; uncovered, they
// draw again at once. Upstream Min turned this off (disable-backgrounding-occluded-windows); this fork turned it back on.
// The cover is a plain window from cover-screen.ps1. Needs an unlocked screen: a locked one counts as covering every window.
const path = require('path')
const { spawn } = require('child_process')
const t = require('./harness')({ name: 'covered-window', minutes: 5 })
const { PAGE, sleep, check, finish, target, launch, quit } = t
const WIN = "(() => { const e = process.mainModule.require('electron'); return e.BaseWindow.getAllWindows().find(w => !(w instanceof e.BrowserWindow)) })()"
// an animation that draws on every frame, like the page used for the 2026-10 measurement
const ANIMATE = `(() => { window.__frames = 0; const c = document.createElement('canvas'); c.width = 300; c.height = 150; document.body.appendChild(c)
  const ctx = c.getContext('2d'); (function draw () { window.__frames++; ctx.fillStyle = 'hsl(' + (Date.now() % 360) + ', 60%, 50%)'; ctx.fillRect(0, 0, 300, 150); requestAnimationFrame(draw) })(); return 1 })()`
// processor seconds so far: the test page's renderer, the GPU process, and all of Min
const CPU = `(() => { const e = process.mainModule.require('electron'); const tab = __tab(); const pid = tab && tab.getOSProcessId(); const m = e.app.getAppMetrics()
  const sum = list => Math.round(list.reduce((a, x) => a + (x.cpu.cumulativeCPUUsage || 0), 0) * 1000) / 1000
  return { page: sum(m.filter(x => x.pid === pid)), gpu: sum(m.filter(x => x.type === 'GPU')), all: sum(m) } })()`

function cover (mode, seconds, rect = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'cover-screen.ps1'), '-Mode', mode, '-Seconds', String(seconds)]
  if (mode === 'rect') args.push('-X', String(rect.x), '-Y', String(rect.y), '-W', String(rect.width), '-H', String(rect.height))
  const child = spawn('powershell', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', d => { err += d })
  const shown = new Promise(resolve => {
    child.stdout.on('data', d => { if (/shown/.test(String(d))) resolve(true) })
    child.on('exit', () => resolve(false))
    setTimeout(() => resolve(false), 15000)
  })
  const closed = new Promise(resolve => child.on('exit', resolve))
  return { shown, closed, close: () => { child.kill(); return closed }, error: () => err.slice(0, 300) }
}

// frames per second, visibility and processor time over ms
async function sample (tab, main, ms) {
  const f0 = await tab.evaluate('__frames'); const c0 = await main.evaluate(CPU)
  await sleep(ms)
  const f1 = await tab.evaluate('__frames'); const c1 = await main.evaluate(CPU)
  const per = key => Math.round((c1[key] - c0[key]) / (ms / 1000) * 1000) / 10
  return { fps: Math.round((f1 - f0) / (ms / 1000)), visibility: await tab.evaluate('document.visibilityState'), cpuPercentOfOneCore: { page: per('page'), gpu: per('gpu'), allOfMin: per('all') } }
}

;(async () => {
  try {
    const main = await launch(PAGE)
    await sleep(1500)
    await main.evaluate(`(() => { const win = ${WIN}; win.setAlwaysOnTop(true); win.focus(); return 1 })()`)
    const tab = await target(x => x.url.startsWith(t.PAGE) && x.type === 'page', 15000)
    await tab.evaluate(ANIMATE)
    await sleep(2000)
    check('screen unlocked (info)', true, { screenLocked: t.isScreenLocked() })

    const visible = await sample(tab, main, 3000)
    check('visible: the page draws (30+ frames per second) and is visible', visible.fps >= 30 && visible.visibility === 'visible', visible)

    // from here Min is an ordinary window, so the cover can go over it
    const rect = await main.evaluate(`(() => { const e = process.mainModule.require('electron'); const win = ${WIN}; win.setAlwaysOnTop(false); return e.screen.dipToScreenRect(win, win.getBounds()) })()`)

    // partly covered (the left half of the window): still visible, still drawing
    const half = cover('rect', 20, { x: rect.x, y: rect.y, width: Math.round(rect.width / 2), height: rect.height })
    const halfShown = await half.shown
    await sleep(2000)
    const partly = await sample(tab, main, 3000)
    await half.close()
    check('partly covered: still draws and stays visible', halfShown && partly.fps >= 30 && partly.visibility === 'visible', { coverShown: halfShown, coverError: half.error(), windowRect: rect, ...partly })
    await sleep(1500)

    // fully covered: hidden, no frames, the page's renderer nearly idle
    const full = cover('full', 30)
    const fullShown = await full.shown
    // Chromium checks occlusion shortly after windows move: give it a moment
    await sleep(3000)
    const covered = await sample(tab, main, 4000)
    check('fully covered: hidden and draws nothing', fullShown && covered.fps <= 1 && covered.visibility === 'hidden', { coverShown: fullShown, coverError: full.error(), ...covered })
    check('fully covered: the page uses (almost) no processor time', fullShown && covered.cpuPercentOfOneCore.page < 2, covered.cpuPercentOfOneCore)

    // uncovered: how long until the page draws again
    const before = await tab.evaluate('__frames')
    await full.close()
    const start = Date.now()
    let resumedMs = null
    while (Date.now() - start < 3000) {
      if ((await tab.evaluate('__frames')) > before) { resumedMs = Date.now() - start; break }
      await sleep(20)
    }
    const after = await sample(tab, main, 3000)
    check('uncovered: draws again within a second', resumedMs !== null && resumedMs < 1000 && after.fps >= 30 && after.visibility === 'visible', { resumedMs, ...after })

    tab.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
