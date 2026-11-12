// Password managers and Min's own password saving (AGENTS.md section 10.9, privacy settings): Bitwarden, 1Password,
// LastPass and Dashlane turn off the browser's "save password?" offer with chrome.privacy.services.passwordSavingEnabled,
// so that only they offer to save. Checks Min's save bar after a login, with that setting on and off, after a restart
// (Chrome keeps extensions' settings), and once the extension is removed. Test extension: extensions/apis (privacy).
const http = require('http')
const t = require('./harness')({ name: 'extensions-passwords', minutes: 6 })
const { sleep, check, finish, target, waitFor, launch, quit, ui } = t
const APIS = t.extension('apis')
const LOGIN_PORT = 8782
const LOGIN = `http://127.0.0.1:${LOGIN_PORT}/login`
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>Sign in</title><form method="post" action="/login"><input name="user" autocomplete="username"><input name="pass" type="password" autocomplete="current-password"><button>Sign in</button></form>')
}).listen(LOGIN_PORT, '127.0.0.1')

// signs in on the test page as the given user, then reports whether Min's save bar came up
async function signIn (u, user) {
  await u.evaluate("document.getElementById('password-capture-bar').hidden = true; 1")
  const p = await target(x => x.url.startsWith(LOGIN) && x.type === 'page', 10000)
  await waitFor(async () => (await p.evaluate("!!document.querySelector('form')")) === true, 10000)
  await p.evaluate(`(() => { document.querySelector('[name=user]').value = ${JSON.stringify(user)}; document.querySelector('[name=pass]').value = 'secret-' + ${JSON.stringify(user)}; document.querySelector('form').requestSubmit(); return 1 })()`)
  p.close()
  await sleep(2500)
  return u.evaluate("!document.getElementById('password-capture-bar').hidden")
}
const loadExtension = async (u, main) => {
  await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
  const s = await target(x => x.url.startsWith('min://app/pages/settings/'))
  await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
  await main.evaluate(`global.__nextOpen = ${JSON.stringify(APIS)}; 1`)
  const id = await s.evaluate("extensionPages.request('load-unpacked')")
  return { s, id }
}
const showLogin = async u => { await u.evaluate(`ipc.emit('extensions-select-tab', {}, tabs.get().find(t => t.url.startsWith(${JSON.stringify(LOGIN)})).id); 1`); await sleep(1000) }

;(async () => {
  let main
  try {
    main = await launch(LOGIN)
    let u = await ui()
    await sleep(1500)
    check('no extension: Min offers to save the password', (await signIn(u, 'alice')) === true)

    const { s, id } = await loadExtension(u, main)
    check('test extension loaded', /^[a-p]{32}$/.test(id), id)
    await showLogin(u)
    let w = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
    check('extension installed, setting untouched: Min still offers', (await signIn(u, 'bob')) === true)

    await w.evaluate('chrome.privacy.services.passwordSavingEnabled.set({ value: false })')
    check('extension turned password saving off: no offer from Min', (await signIn(u, 'carol')) === false)
    s.close()
    u.close()
    w.close()
    await quit(main)

    // Chrome keeps an extension's setting until the extension clears it or is removed
    main = await launch(LOGIN)
    u = await ui()
    await sleep(2500)
    w = await target(x => x.type === 'service_worker' && x.url.startsWith('chrome-extension://' + id + '/'), 15000)
    const kept = w && await w.evaluate('chrome.privacy.services.passwordSavingEnabled.get({})')
    check('after a restart: the setting is kept, controlled by the extension', kept && kept.value === false && kept.levelOfControl === 'controlled_by_this_extension', kept)
    check('after a restart: still no offer from Min', (await signIn(u, 'dave')) === false)

    await w.evaluate('chrome.privacy.services.passwordSavingEnabled.clear({})')
    check('extension cleared the setting: Min offers again', (await signIn(u, 'erin')) === true)
    await w.evaluate('chrome.privacy.services.passwordSavingEnabled.set({ value: false })')

    // removing the extension gives the setting back to Min
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s2 = await target(x => x.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s2.evaluate('typeof extensionPages')) === 'object')
    await s2.evaluate(`extensionPages.request('remove', { id: ${JSON.stringify(id)} })`)
    s2.close()
    await showLogin(u)
    check('extension removed: Min offers again', (await signIn(u, 'frank')) === true)
    w.close()
    u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
