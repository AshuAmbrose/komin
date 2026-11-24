// Min's own pages (min://app/...) and its interface under their security rules (Content-Security-Policy): since
// 2026-11-24 (upstream's 29cb4d31) every min:// page gets "script-src 'self'; style-src 'self'; object-src 'none';
// form-action 'self'" from main/minInternalProtocol.js, and most pages a stricter rule of their own. Each page is opened
// and used, and every "Refused to ..." message Chromium prints for any of Min's pages is collected in main, so a style,
// script, image or connection a rule blocks shows up here. Checks, each page also doing its job:
//   Settings (and its Extensions list with a test extension loaded), the new tab page, the error page, the session
//   restore error page (its script moved out of the page), the PDF viewer, reader view, the userscript install page, and
//   the interface: an extension's toolbar icon and a page's data: favicon (data: images, which the interface's rule
//   names since upstream's `*` doesn't cover them)
// Not opened: the translation service (a hidden window started for a translation) and the sign-in prompt window.
const http = require('http')
const t = require('./harness')({ name: 'internal-pages', minutes: 8 })
const { sleep, check, finish, target, waitFor, launch, ui } = t

const PORT = 8796
const SITE = `http://127.0.0.1:${PORT}`
const TOOLBAR_EXTENSION = t.extension('toolbar')

// a one-page PDF with a line of text in a standard font
function makePdf () {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  const stream = 'BT /F1 18 Tf 20 70 Td (Min PDF test) Tj ET'
  objects[3] = '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n'
  })
  const xref = out.length
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  return out
}
const PDF = makePdf()
const ARTICLE = '<!doctype html><html><head><title>A long article</title></head><body><article><h1>A long article</h1>' +
  Array.from({ length: 12 }, (_, i) => '<p>Paragraph ' + (i + 1) + ' of the article, with enough words in it to look like real writing to the reader view, which wants a few sentences before it believes a page is an article. Here is one more sentence to make sure.</p>').join('') +
  '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="a data: image"></article></body></html>'
const USERSCRIPT = ['// ==UserScript==', '// @name Internal pages probe', '// @namespace min-test', '// @version 1', '// @match ' + SITE + '/nothing*', '// @grant none', '// ==/UserScript==', 'void 0'].join('\n')
const FAVICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

const server = http.createServer(function (req, res) {
  if (req.url.startsWith('/doc.pdf')) {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    return res.end(PDF)
  }
  if (req.url.startsWith('/article')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(ARTICLE)
  }
  if (req.url.startsWith('/probe.user.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    return res.end(USERSCRIPT)
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>start</title><link rel="icon" href="${FAVICON}"><p>start</p>`)
}).listen(PORT, '127.0.0.1')

const openTab = (u, url) => u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
const pageTarget = (prefix, ms = 10000) => target(x => x.type === 'page' && x.url.startsWith(prefix), ms).catch(() => null)
// "Refused to ..." messages from Min's pages and interface, collected in main since the hook below
const refusals = main => main.evaluate('global.__minRefused.splice(0)')

;(async () => {
  try {
    const main = await launch(SITE + '/start')
    await main.evaluate(`(() => {
      const electron = process.mainModule.require('electron')
      global.__minRefused = []
      const watch = wc => wc.on('console-message', (event, ...rest) => {
        const message = String(event && event.message !== undefined ? event.message : rest[1])
        const url = wc.isDestroyed() ? '' : wc.getURL()
        if (/Content Security Policy|Refused to/.test(message) && url.startsWith('min:')) global.__minRefused.push({ url: url.slice(0, 80), message: message.slice(0, 300) })
      })
      electron.webContents.getAllWebContents().forEach(watch)
      electron.app.on('web-contents-created', (e, wc) => watch(wc))
      return 1
    })()`)
    const u = await ui()
    await sleep(1500)
    const pages = {}

    // Settings, and its Extensions list with a test extension (whose toolbar icon then shows in the interface)
    await openTab(u, 'min://settings')
    const settings = await pageTarget('min://app/pages/settings/')
    await waitFor(async () => (await settings.evaluate('typeof extensionPages')) === 'object', 10000)
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(TOOLBAR_EXTENSION)}; 1`)
    const loaded = await settings.evaluate("extensionPages.request('load-unpacked').catch(e => 'refused: ' + e.message)")
    await sleep(1500)
    pages.settings = {
      sections: await settings.evaluate("document.querySelectorAll('.settings-container, section, h2, h3').length"),
      extensionListed: await settings.evaluate("document.querySelectorAll('.extension-item').length"),
      customSearchMargin: await settings.evaluate("getComputedStyle(document.getElementById('custom-search-engine')).marginLeft"),
      refused: await refusals(main)
    }
    check('Settings works under its rules (sections, the extension list; styles from its stylesheet)', pages.settings.sections > 3 && pages.settings.extensionListed === 1 && /^[a-p]{32}$/.test(loaded || '') && pages.settings.customSearchMargin !== '0px' && pages.settings.refused.length === 0, Object.assign({ loaded }, pages.settings))

    // the interface: the extension's toolbar icon (a data: image), a page's data: favicon
    await u.evaluate(`(() => { const tab = tabs.get().find(x => x.url.startsWith(${JSON.stringify(SITE + '/start')})); ipc.emit('extensions-select-tab', {}, tab.id); return 1 })()`)
    await sleep(2000)
    const iface = await u.evaluate(`(() => {
      const icon = document.querySelector('#extension-actions img')
      const favicons = Array.from(document.querySelectorAll('img')).filter(i => (i.src || '').startsWith('data:image/png'))
      return { toolbarIcon: icon ? { loaded: icon.complete && icon.naturalWidth > 0, data: icon.src.startsWith('data:') } : null, dataImagesShown: favicons.filter(i => i.complete && i.naturalWidth > 0).length }
    })()`)
    iface.refused = await refusals(main)
    check('the interface shows an extension\'s toolbar icon (a data: image) under its rules', iface.toolbarIcon && iface.toolbarIcon.loaded && iface.refused.length === 0, iface)

    // the new tab page
    await openTab(u, 'min://newtab')
    const newtab = await pageTarget('min://app/pages/newtab/')
    await sleep(1000)
    pages.newtab = { loaded: Boolean(newtab) && (await newtab.evaluate('document.readyState')) === 'complete', refused: await refusals(main) }
    check('the new tab page loads under its rules', pages.newtab.loaded && pages.newtab.refused.length === 0, pages.newtab)

    // the error page (a site that refuses the connection)
    await openTab(u, 'http://127.0.0.1:1/')
    const error = await pageTarget('min://app/pages/error/', 15000)
    await sleep(1000)
    pages.error = { text: error ? (await error.evaluate('document.body.innerText')).slice(0, 120) : null, refused: await refusals(main) }
    check('the error page shows its message under its rules', /\S/.test(pages.error.text || '') && pages.error.refused.length === 0, pages.error)

    // the session restore error page: its script now in a file of its own
    await openTab(u, 'min://app/pages/sessionRestoreError/index.html?backupLoc=' + encodeURIComponent('C:\\min-test\\backup.json'))
    const restoreError = await pageTarget('min://app/pages/sessionRestoreError/')
    await sleep(1000)
    pages.sessionRestoreError = { backupInfo: restoreError ? await restoreError.evaluate("document.getElementById('backup-info').textContent") : null, refused: await refusals(main) }
    check('the session restore error page names the backup file under its rules', /min-test\\backup\.json/.test(pages.sessionRestoreError.backupInfo || '') && pages.sessionRestoreError.refused.length === 0, pages.sessionRestoreError)

    // the PDF viewer
    await openTab(u, SITE + '/doc.pdf')
    const pdf = await pageTarget('min://app/pages/pdfViewer/', 15000)
    const pdfShown = pdf ? await waitFor(async () => { const v = await pdf.evaluate("(() => { const c = document.querySelector('canvas'); return c && c.width > 0 ? { canvas: c.width + 'x' + c.height, text: document.body.innerText.slice(0, 100) } : null })()"); return v }, 10000) : null
    pages.pdf = { shown: pdfShown, refused: await refusals(main) }
    check('the PDF viewer draws a page under its rules', Boolean(pdfShown) && pages.pdf.refused.length === 0, pages.pdf)

    // reader view of an article (with a data: image)
    await openTab(u, 'min://app/reader/index.html?url=' + encodeURIComponent(SITE + '/article'))
    const reader = await pageTarget('min://app/reader/', 15000)
    const readerText = reader ? await waitFor(async () => { const frameText = await reader.evaluate("(() => { const f = document.querySelector('iframe'); try { return f && f.contentDocument ? f.contentDocument.body.innerText : document.body.innerText } catch (e) { return document.body.innerText } })()"); return /Paragraph 12/.test(frameText || '') ? frameText.length : null }, 12000) : null
    pages.reader = { articleShown: readerText, refused: await refusals(main) }
    check('reader view shows the article under its rules', Boolean(readerText) && pages.reader.refused.length === 0, pages.reader)

    // the userscript install page
    await openTab(u, SITE + '/probe.user.js')
    const install = await pageTarget('min://app/pages/userscriptInstall/', 15000)
    const installShown = install ? await waitFor(async () => { const v = await install.evaluate('document.body.innerText'); return /Internal pages probe/.test(v) ? v.slice(0, 120) : null }, 10000) : null
    pages.userscriptInstall = { shown: installShown, refused: await refusals(main) }
    check('the userscript install page shows the script under its rules', Boolean(installShown) && pages.userscriptInstall.refused.length === 0, pages.userscriptInstall)

    // the translation service: its Bergamot worker compiles WebAssembly, which a script-src without 'wasm-unsafe-eval'
    // refuses. The real worker, started as the service starts it, asked to initialize: it loads and compiles its
    // WebAssembly from Min's own files (no download; the models come later, for a translation)
    await openTab(u, 'min://app/pages/translateService/index.html')
    const translate = await pageTarget('min://app/pages/translateService/')
    await sleep(1000)
    const workerStart = "new Promise(resolve => { const w = new Worker(new URL('../../node_modules/@browsermt/bergamot-translator/worker/translator-worker.js', location.href)); w.onmessage = e => resolve(e.data.error ? 'error: ' + JSON.stringify(e.data.error).slice(0, 200) : 'initialized'); w.onerror = e => resolve('worker error: ' + e.message); w.postMessage({ id: 1, name: 'initialize', args: [{}] }); setTimeout(() => resolve('no answer in 20 s'), 20000) })"
    pages.translateService = { worker: translate ? await translate.evaluate(workerStart) : null, refused: await refusals(main) }
    check('the translation service\'s worker compiles its WebAssembly under its rules', pages.translateService.worker === 'initialized', pages.translateService)
    await u.evaluate("tabs.get().filter(x => x.url.startsWith('min://app/pages/translateService/')).forEach(x => ipc.emit('extensions-close-tab', {}, x.id)); 1")

    // anything else refused on the way (the interface while all this ran)
    const rest = await refusals(main)
    check('nothing else refused on Min\'s pages or interface', rest.length === 0, rest)
    u.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  server.close()
  finish()
})()
