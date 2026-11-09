// Records lifecycle events in chrome.storage.local and answers the harness's requests (sent from an extension page or content script).
let recording = Promise.resolve()
function record (event) {
  recording = recording.then(() => chrome.storage.local.get({ events: [] })).then(data => chrome.storage.local.set({ events: data.events.concat(event) }))
}

chrome.runtime.onInstalled.addListener(function (details) {
  record('installed:' + details.reason + (details.previousVersion ? ':' + details.previousVersion : ''))
})
chrome.runtime.onStartup.addListener(function () {
  record('startup')
})

async function handle (message, sender) {
  switch (message.op) {
    case 'ping':
      return { ok: true, tabId: sender.tab ? sender.tab.id : null, commands: typeof chrome.commands, browserSame: globalThis.browser === chrome }
    case 'events':
      await recording
      return (await chrome.storage.local.get({ events: [] })).events
    case 'query':
      return (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, active: t.active, windowId: t.windowId }))
    case 'create': {
      const tab = await chrome.tabs.create({ url: message.url, active: message.active })
      return { id: tab.id, url: tab.url }
    }
    case 'activate':
      await chrome.tabs.update(message.id, { active: true })
      return true
    case 'remove':
      await chrome.tabs.remove(message.id)
      return true
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  handle(message, sender).then(reply, e => reply({ error: String(e) }))
  return true
})
