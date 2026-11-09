// Extensions' toolbar (phase 5): toolbar buttons (icon, title, badge), popups, the button's menu, extension items in the
// page's menu, options pages, keyboard shortcuts, private tabs, on/off. Uses the test extension in extensions/toolbar.
// Native dialogs answer "yes" and native menus are recorded instead of shown (their items can be clicked from here).
const fs = require('fs')
const t = require('./harness')({ name: 'extensions-toolbar', minutes: 8 })
const EXTENSION = t.extension('toolbar')
const { PAGE, sleep, check, finish, waitFor, target, launch, quit, ui, toolbar, buttonRect, popupWindow, lastMenu, key } = t
;(async () => {
  let main
  try {
    main = await launch(PAGE)
    let u = await ui()
    await sleep(1000)
    let bar = await toolbar(u)
    check('no extensions: no toolbar buttons', bar.hidden && bar.buttons.length === 0, bar)

    // load the test extension through Settings
    await u.evaluate("ipc.emit('addTab', {}, { url: 'min://settings' }); 1")
    const s = await target(t => t.url.startsWith('min://app/pages/settings/'))
    await waitFor(async () => (await s.evaluate('typeof extensionPages')) === 'object')
    await main.evaluate(`global.__nextOpen = ${JSON.stringify(EXTENSION)}; 1`)
    const id = await s.evaluate("extensionPages.request('load-unpacked')")
    check('test extension loaded', /^[a-p]{32}$/.test(id || ''), id)
    await sleep(500)
    const listed = await s.evaluate("extensionPages.request('list')")
    check('Settings: "Options" offered', Array.isArray(listed) && listed[0].hasOptions && await s.evaluate("Array.from(document.querySelectorAll('.extension-item a')).some(a => a.textContent === 'Options')"))

    // back to the page: its toolbar button
    await u.evaluate(`(() => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(PAGE)})); ipc.emit('extensions-select-tab', {}, tab.id); return 1 })()`)
    bar = await waitFor(async () => { const b = await toolbar(u); return b.buttons.length && b.buttons[0].badge ? b : null }, 10000) || await toolbar(u)
    const button = bar.buttons[0] || {}
    check('toolbar button shown with the action\'s title and icon', !bar.hidden && button.id === id && button.title === 'Min toolbar test' && button.icon.startsWith('data:image/png'), bar)
    const width = await u.evaluate('window.innerWidth')
    const shot = await u.send('Page.captureScreenshot', { clip: { x: width - 420, y: 0, width: 420, height: 40, scale: 2 } })
    if (shot.result) fs.writeFileSync(t.output('toolbar.png'), Buffer.from(shot.result.data, 'base64'))
    check('badge text and color from the extension', button.badge === '7' && button.badgeColor === 'rgb(0, 170, 0)', button)

    // click: the popup opens under the button and sees the page as the active tab
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    let popup = await waitFor(() => popupWindow(main), 10000)
    const rect = await buttonRect(u, id)
    check('click opens the popup', popup && popup.visible, popup)
    if (popup) {
      const right = popup.popup.x + popup.popup.width
      const expectedRight = popup.win.x + rect.right
      const expectedTop = popup.win.y + (popup.win.height - popup.content.height) + rect.bottom + 5
      check('popup placed under the button, right-aligned to it', Math.abs(right - expectedRight) <= 2 && Math.abs(popup.popup.y - expectedTop) <= 2, { popup: popup.popup, window: popup.win, button: rect })
    }
    const popupPage = await target(t => t.url.includes(id + '/popup.html'), 10000)
    const popupTab = popupPage && await waitFor(() => popupPage.evaluate('window.activeTab'), 8000)
    check('popup\'s chrome.tabs.query sees the page as the active tab', popupTab === PAGE, popupTab)
    if (popupPage) popupPage.close()
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    check('clicking again closes the popup', await waitFor(async () => !(await popupWindow(main)), 5000))

    // the button's right-click menu
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); 1`)
    let labels = await waitFor(() => lastMenu(main), 5000)
    check('button menu: name, the extension\'s action item, Options, Remove, Manage', Array.isArray(labels) && labels[0].startsWith('Min test: toolbar') && labels.includes('Min toolbar action item') && labels.includes('Options') && labels.includes('Remove from Min…') && labels.includes('Manage extensions'), labels)
    await main.evaluate("__clickMenuItem('Options')")
    const options = await target(t => t.url.includes(id + '/options.html'), 10000)
    check('Options opens the options page in a tab', options)
    await waitFor(async () => (await options.evaluate('typeof ask')) === 'function')
    await main.evaluate("__clickMenuItem('Min toolbar action item')")

    // the page's right-click menu gets the extension's page item
    await u.evaluate(`(() => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(PAGE)})); ipc.emit('extensions-select-tab', {}, tab.id); return 1 })()`)
    await sleep(800)
    const menusBefore = await main.evaluate('__menus.length')
    // a synthetic right-click doesn't always reach the page (pitfall 25; worse on a locked screen): up to three tries
    for (let attempt = 0; attempt < 3; attempt++) {
      await main.evaluate("(() => { const wc = __tab(); global.__contextMenuEvent = false; wc.once('context-menu', () => { global.__contextMenuEvent = true }); wc.focus(); wc.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'right', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: 200, y: 200, button: 'right', clickCount: 1 }); return 1 })()")
      if (await waitFor(async () => (await main.evaluate('__menus.length')) > menusBefore, attempt < 2 ? 3000 : 8000)) {
        break
      }
    }
    check('right-click reached the page (context-menu event) (info)', true, await main.evaluate('global.__contextMenuEvent'))
    labels = (await main.evaluate('__menus.length')) > menusBefore ? await lastMenu(main) : 'no new menu'
    check('page menu includes the extension\'s item (after Min\'s own)', Array.isArray(labels) && labels.indexOf('Min toolbar test item') > labels.indexOf('Go Back') && labels.indexOf('Go Back') >= 0, labels)
    await main.evaluate("__clickMenuItem('Min toolbar test item')")

    // keyboard shortcuts
    await key(main, 'H', ['alt', 'shift'])
    await sleep(800)
    await key(main, 'T', ['control'])
    await sleep(800)
    let events = await waitFor(async () => { const e = await options.evaluate("ask({ op: 'events' })"); return Array.isArray(e) && e.some(x => x.startsWith('command:')) ? e : null }, 8000) || await options.evaluate("ask({ op: 'events' })")
    check('menu clicks reach the extension (button item and page item)', Array.isArray(events) && events.includes('menu:action-item') && events.includes('menu:page-item'), events)
    check('Alt+Shift+H sends commands.onCommand with the tab', Array.isArray(events) && events.includes('command:say-hello:' + PAGE), events)
    check('Ctrl+T stays Min\'s: the clashing command isn\'t sent', Array.isArray(events) && !events.some(e => e.startsWith('command:clash')), events)
    const commands = await options.evaluate("ask({ op: 'commands' })")
    check('commands.getAll shows the shortcuts', Array.isArray(commands) && commands.some(c => c.name === 'say-hello' && c.shortcut === 'Alt+Shift+H'), commands)
    await key(main, 'K', ['alt', 'shift'])
    popup = await waitFor(() => popupWindow(main), 8000)
    check('Alt+Shift+K (_execute_action) opens the popup', popup)
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    await waitFor(async () => !(await popupWindow(main)), 5000)

    // without a popup, a click sends action.onClicked
    await options.evaluate("ask({ op: 'no-popup' })")
    await u.evaluate(`(() => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(PAGE)})); ipc.emit('extensions-select-tab', {}, tab.id); return 1 })()`)
    await sleep(800)
    await u.evaluate(`document.querySelector('#extension-actions [data-extension-id="${id}"]').click(); 1`)
    events = await waitFor(async () => { const e = await options.evaluate("ask({ op: 'events' })"); return Array.isArray(e) && e.some(x => x.startsWith('clicked:')) ? e : null }, 8000) || await options.evaluate("ask({ op: 'events' })")
    check('no popup: a click sends action.onClicked with the tab', Array.isArray(events) && events.includes('clicked:' + PAGE), events)

    // private tabs: no buttons; back on a normal tab: buttons again
    await u.evaluate("ipc.emit('addPrivateTab', {}); 1")
    bar = await waitFor(async () => { const b = await toolbar(u); return b.hidden ? b : null }, 5000) || await toolbar(u)
    check('private tab: no extension buttons', bar.hidden && bar.buttons.length === 0, bar)
    await u.evaluate(`(() => { const tab = tabs.get().find(t => t.url.startsWith(${JSON.stringify(PAGE)})); ipc.emit('extensions-select-tab', {}, tab.id); return 1 })()`)
    bar = await waitFor(async () => { const b = await toolbar(u); return b.buttons.length ? b : null }, 5000) || await toolbar(u)
    check('normal tab again: buttons back', !bar.hidden && bar.buttons.length === 1, bar)

    // turned off in Settings: the button goes; on: back
    await s.evaluate(`extensionPages.request('set-enabled', { id: '${id}', enabled: false })`)
    bar = await waitFor(async () => { const b = await toolbar(u); return b.hidden ? b : null }, 5000) || await toolbar(u)
    check('turned off: button removed', bar.hidden && bar.buttons.length === 0, bar)
    await s.evaluate(`extensionPages.request('set-enabled', { id: '${id}', enabled: true })`)
    bar = await waitFor(async () => { const b = await toolbar(u); return b.buttons.length ? b : null }, 5000) || await toolbar(u)
    check('turned on again: button back', !bar.hidden && bar.buttons.length === 1, bar)

    s.close(); options.close(); u.close()
    await quit(main)
    finish()
  } catch (e) {
    check('harness error', false, String(e.stack || e))
    finish()
  }
})()
