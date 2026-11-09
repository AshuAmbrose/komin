// Logs every event the background worker receives; the spike harness reads these console messages.
console.log('basic: worker started')

chrome.runtime.onInstalled.addListener(function (details) {
  console.log('basic: installed (' + details.reason + ')')
  chrome.storage.local.set({ installedAt: Date.now() })
})

chrome.runtime.onStartup.addListener(function () {
  console.log('basic: browser startup')
})

// the same setup at worker start, so it doesn't depend on onInstalled
chrome.alarms.get('tick', function (alarm) {
  if (!alarm) {
    chrome.alarms.create('tick', { periodInMinutes: 0.5 })
    console.log('basic: alarm created')
  }
})
chrome.contextMenus.create({ id: 'min-test', title: 'Min test menu item', contexts: ['page'] }, function () {
  console.log('basic: context menu ' + (chrome.runtime.lastError ? 'error ' + chrome.runtime.lastError.message : 'created'))
})

chrome.alarms.onAlarm.addListener(function (alarm) {
  console.log('basic: alarm ' + alarm.name)
})

chrome.contextMenus.onClicked.addListener(function (info) {
  console.log('basic: context menu clicked ' + info.menuItemId)
})

chrome.tabs.onUpdated.addListener(function (tabId, info, tab) {
  if (info.status === 'complete') {
    console.log('basic: tab updated ' + tab.url)
  }
})

chrome.tabs.onActivated.addListener(function (info) {
  console.log('basic: tab activated ' + info.tabId)
})

chrome.storage.onChanged.addListener(function (changes) {
  console.log('basic: storage changed ' + Object.keys(changes).join(','))
})

chrome.runtime.onMessage.addListener(function (message, sender, reply) {
  console.log('basic: message from ' + (sender.tab ? sender.tab.url : 'extension'))
  reply({ ok: true, tabId: sender.tab ? sender.tab.id : null })
})
