// Sign-in windows on real sites (needs the internet): each site's "Continue with Google / GitHub / Microsoft" button is
// clicked for real (through the DevTools protocol, which pages can't tell from a person's click), and the suite checks
// that the sign-in page opens in a tab and that it's linked to the site (window.opener), which it needs to hand the
// sign-in back. Nothing is typed and no one signs in: finishing a sign-in needs a person and their password.
// A site may change its page or show a robot check; such a site is recorded as "couldn't check", not failed.
// `MIN_TEST_OLD=popupsAsNewTabs` puts back the rule from before 2026-11-17 (window.open without features became a tab
// with no link back), for a comparison. `node test/e2e/popups-real.js <part of a site's name> ...` runs only those.
const t = require('./harness')({ name: 'popups-real' + (process.env.MIN_TEST_OLD ? '-old' : ''), minutes: 14 })
const { sleep, check, finish, target, waitFor, launch, ui, list } = t
const switchedOff = require('./old-behaviour')(t)

// [name, page, the button's text, the sign-in page's address]
const SITES = [
  ['Medium', 'https://medium.com/m/signin', /sign in with google|continue with google/i, /accounts\.google\.com/],
  ['Canva', 'https://www.canva.com/login', /continue with google/i, /accounts\.google\.com/],
  ['Vercel', 'https://vercel.com/login', /continue with github/i, /github\.com\/login/],
  ['Figma', 'https://www.figma.com/login', /continue with google/i, /accounts\.google\.com/],
  ['Khan Academy', 'https://www.khanacademy.org/login', /continue with google/i, /accounts\.google\.com/],
  ['Quora', 'https://www.quora.com/', /continue with google/i, /accounts\.google\.com/],
  ['Pinterest', 'https://www.pinterest.com/login/', /continue with google|continue as/i, /accounts\.google\.com/],
  ['Notion', 'https://www.notion.so/login', /continue with google/i, /accounts\.google\.com/],
  ['Trello', 'https://trello.com/login', /continue with google|google/i, /accounts\.google\.com|id\.atlassian\.com/],
  ['Replit', 'https://replit.com/login', /continue with google/i, /accounts\.google\.com/]
]
const only = process.argv.slice(2).map(s => s.toLowerCase())
const sites = only.length ? SITES.filter(s => only.some(o => s[0].toLowerCase().includes(o))) : SITES

const tabList = u => u.evaluate('({ selected: tabs.getSelected(), tabs: tabs.get().map(t => ({ id: t.id, url: t.url })) })')

// the button: an element whose own text matches, or a Google sign-in button frame (its text isn't readable from the page)
const FIND = text => `(() => {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 20 && r.height > 10 && r.bottom > 0 && r.top < innerHeight }
  const candidates = Array.from(document.querySelectorAll('button, a, [role=button], div, span')).filter(e => ${text}.test((e.innerText || e.getAttribute('aria-label') || '').trim()) && (e.innerText || '').length < 60 && visible(e))
  candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
  let el = candidates[0]
  if (!el) el = Array.from(document.querySelectorAll('iframe')).find(f => /accounts\\.google\\.com\\/gsi\\/button/.test(f.src) && visible(f))
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  return { x: r.left + Math.min(r.width / 2, 120), y: r.top + r.height / 2, text: (el.innerText || el.tagName).trim().slice(0, 40) }
})()`

;(async () => {
  let main
  try {
    if (switchedOff.length) check('switched back to the old behaviour (info)', true, switchedOff)
    main = await launch('about:blank')
    const u = await ui()
    await sleep(1500)
    const outcomes = []
    for (const [name, url, buttonText, provider] of sites) {
      const outcome = { site: name }
      outcomes.push(outcome)
      try {
        await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(url)} }); 1`)
        const host = new URL(url).hostname.replace(/^www\./, '')
        const page = await target(x => x.type === 'page' && new URL(x.url).hostname.endsWith(host), 20000)
        await sleep(7000)
        outcome.pageTitle = (await page.evaluate('document.title') || '').slice(0, 60)
        if (/just a moment|attention required|verify you are human|access denied|captcha/i.test(outcome.pageTitle + ' ' + (await page.evaluate('document.body ? document.body.innerText.slice(0, 300) : ""')))) {
          outcome.result = 'couldn\'t check: a robot check'
          continue
        }
        const button = await waitFor(() => page.evaluate(FIND(buttonText.toString())), 8000)
        if (!button) {
          outcome.result = 'couldn\'t check: no sign-in button found'
          continue
        }
        outcome.button = button.text
        await sleep(800)
        const box = await page.evaluate(FIND(buttonText.toString()))
        await main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().includes(${JSON.stringify(host)})); if (wc) wc.focus(); return 1 })()`)
        const before = new Set((await list()).map(x => x.id))
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
        }
        // the sign-in page: a new tab at the provider's address, or this tab going there (some sites redirect instead)
        const opened = await waitFor(async () => (await list()).find(x => x.type === 'page' && !before.has(x.id) && provider.test(x.url)), 12000)
        if (!opened) {
          const sameTab = provider.test(await page.evaluate('location.href').catch(() => ''))
          outcome.result = sameTab ? 'couldn\'t check: the site goes to the sign-in page in its own tab (no window)' : 'no sign-in window'
          outcome.tabs = (await tabList(u)).tabs.map(x => x.url.slice(0, 80))
          continue
        }
        outcome.signInPage = opened.url.slice(0, 80)
        const popup = await target(x => x.id === opened.id, 5000)
        outcome.hasOpener = await popup.evaluate('window.opener !== null')
        // what the sign-in page shows once loaded (an email box, or a refusal such as "This browser or app may not be
        // secure"), and where it ended up
        await sleep(5000)
        outcome.signInShows = String(await popup.evaluate('document.body ? document.body.innerText.replace(/\\s+/g, " ").slice(0, 300) : ""').catch(() => '')).slice(0, 300)
        outcome.signInPageNow = String(await popup.evaluate('location.href').catch(() => '')).slice(0, 120)
        outcome.result = outcome.hasOpener ? 'linked sign-in window' : 'sign-in window without a link back'
        popup.close()
        page.close()
      } catch (e) {
        outcome.result = 'couldn\'t check: ' + String(e.message || e).slice(0, 120)
      } finally {
        await u.evaluate("tabs.get().forEach(t => ipc.emit('extensions-close-tab', {}, t.id)); 1").catch(() => {})
        await sleep(1000)
      }
    }
    for (const o of outcomes) {
      check(o.site + ': ' + o.result + (o.result.startsWith('couldn\'t') || o.result === 'no sign-in window' ? ' (info)' : ''), o.result !== 'sign-in window without a link back', o)
    }
    const linked = outcomes.filter(o => o.result === 'linked sign-in window').length
    const tried = outcomes.filter(o => !o.result.startsWith('couldn\'t')).length
    if (sites.length) {
      check('sign-in windows that opened are linked to their site', tried > 0 && outcomes.every(o => o.result !== 'sign-in window without a link back'), { linked, tried, sites: outcomes.length })
    }

    // on a real page: links opened with Ctrl+click and a middle click, then the page closed; the tabs must stay, with
    // their pages (pitfall 66: closing a page emptied the tabs it had opened, 2026-11-17 to 24)
    if (!only.length || only.includes('tabs')) {
      const SOURCE = 'https://en.wikipedia.org/wiki/Web_browser'
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(SOURCE)} }); 1`)
      const source = await target(x => x.type === 'page' && x.url.startsWith(SOURCE), 20000)
      await sleep(4000)
      // two article links, by their full address (the page may write them relative or absolute)
      const links = await source.evaluate('Array.from(new Set(Array.from(document.querySelectorAll("#mw-content-text a")).map(a => a.href).filter(h => h.startsWith("https://en.wikipedia.org/wiki/") && !/[:#?]/.test(h.slice(30)) && h !== location.href))).slice(0, 2)')
      const opened = []
      for (const [i, href] of links.entries()) {
        const box = await source.evaluate(`(() => { const a = Array.from(document.querySelectorAll('#mw-content-text a')).find(a => a.href === ${JSON.stringify(href)}); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height / 2 } })()`)
        await main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(SOURCE)})); if (wc) wc.focus(); return 1 })()`)
        const button = i === 0 ? 'left' : 'middle'
        const modifiers = i === 0 ? 2 : 0
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await source.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button, buttons: type === 'mousePressed' ? (button === 'middle' ? 4 : 1) : 0, clickCount: 1, modifiers })
        }
        const url = href
        opened.push({ how: i === 0 ? 'Ctrl+click' : 'middle click', url, tab: Boolean(await waitFor(async () => (await tabList(u)).tabs.find(x => x.url.startsWith(url)), 8000)) })
      }
      await sleep(3000)
      await u.evaluate(`tabs.get().filter(x => x.url.startsWith(${JSON.stringify(SOURCE)})).forEach(x => ipc.emit('extensions-close-tab', {}, x.id)); 1`)
      await sleep(2000)
      for (const o of opened) {
        o.tabAfter = Boolean((await tabList(u)).tabs.find(x => x.url.startsWith(o.url)))
        const page = await target(x => x.type === 'page' && x.url.startsWith(o.url), 4000).catch(() => null)
        o.pageAfter = page ? await page.evaluate('({ title: document.title.slice(0, 60), text: document.body.innerText.length })').catch(e => 'gone: ' + e.message) : null
        if (page) page.close()
      }
      check('Wikipedia: links opened with Ctrl+click and a middle click stay alive after the page they came from closes', opened.length === 2 && opened.every(o => o.tab && o.tabAfter && o.pageAfter && o.pageAfter.text > 1000), opened)
      await u.evaluate("tabs.get().filter(x => x.url.startsWith('https://en.wikipedia.org/')).forEach(x => ipc.emit('extensions-close-tab', {}, x.id)); 1")
    }

    // Min's key button for saved passwords on a real https sign-in page (nothing is typed, nothing saved or filled)
    if (!only.length || only.includes('key')) {
      const LOGIN = 'https://github.com/login'
      await u.evaluate(`ipc.emit('addTab', {}, { url: ${JSON.stringify(LOGIN)} }); 1`)
      const login = await target(x => x.type === 'page' && x.url.startsWith(LOGIN), 20000)
      await sleep(4000)
      await main.evaluate(`(() => { const wc = process.mainModule.require('electron').webContents.getAllWebContents().find(w => w.getURL().startsWith(${JSON.stringify(LOGIN)})); if (wc) wc.focus(); return 1 })()`)
      await login.evaluate("(document.querySelector('input[type=password]') || {}).focus && document.querySelector('input[type=password]').focus(); 1")
      await sleep(1000)
      const key = await login.evaluate('({ passwordBox: Boolean(document.querySelector("input[type=password]")), keyButton: Array.from(document.body.children).some(e => e.tagName === "DIV" && e.querySelector("svg") && e.style.position === "absolute") })')
      check('GitHub\'s sign-in page (https): Min shows its key button on the password box', key.passwordBox && key.keyButton, key)
      await u.evaluate(`tabs.get().filter(x => x.url.startsWith(${JSON.stringify(LOGIN)})).forEach(x => ipc.emit('extensions-close-tab', {}, x.id)); 1`)
    }
    u.close()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
  }
  finish()
})()
