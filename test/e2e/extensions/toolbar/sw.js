// Records what reaches it (menus, commands, action clicks) in chrome.storage.local, for the harness to read.
let recording = Promise.resolve()
function record (event) {
  recording = recording.then(() => chrome.storage.local.get({ events: [] })).then(data => chrome.storage.local.set({ events: data.events.concat(event) }))
}

// at every worker start: the library keeps menu items in memory only
chrome.contextMenus.create({ id: 'page-item', title: 'Min toolbar test item', contexts: ['page'] }, () => chrome.runtime.lastError)
chrome.contextMenus.create({ id: 'action-item', title: 'Min toolbar action item', contexts: ['action'] }, () => chrome.runtime.lastError)
chrome.action.setBadgeText({ text: '7' })
chrome.action.setBadgeBackgroundColor({ color: '#00aa00' })

chrome.contextMenus.onClicked.addListener(info => record('menu:' + info.menuItemId))
chrome.commands.onCommand.addListener((name, tab) => record('command:' + name + ':' + (tab ? tab.url : 'no tab')))
chrome.action.onClicked.addListener(tab => record('clicked:' + tab.url))

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  (async function () {
    if (message.op === 'events') {
      await recording
      return (await chrome.storage.local.get({ events: [] })).events
    }
    if (message.op === 'commands') {
      return chrome.commands.getAll()
    }
    if (message.op === 'no-popup') {
      await chrome.action.setPopup({ popup: '' })
      return true
    }
  })().then(reply, e => reply({ error: String(e) }))
  return true
})
