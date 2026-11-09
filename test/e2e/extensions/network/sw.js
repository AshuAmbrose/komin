// Logs the test pages' requests it sees through chrome.webRequest, and reports its declarativeNetRequest rules.
// The static rule (rules.json) blocks pagead2.googlesyndication.com; the dynamic rule added here blocks securepubads.g.doubleclick.net.
console.log('network: worker started')

chrome.webRequest.onBeforeRequest.addListener(function (details) {
  if (details.url.includes('127.0.0.1') || details.url.includes('googlesyndication') || details.url.includes('doubleclick')) {
    console.log('network: webRequest saw ' + details.url)
  }
}, { urls: ['<all_urls>'] })

chrome.declarativeNetRequest.getEnabledRulesets().then(function (ids) {
  console.log('network: enabled static rulesets ' + JSON.stringify(ids))
}, function (e) {
  console.log('network: getEnabledRulesets failed ' + e.message)
})

chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [2],
  addRules: [{
    id: 2,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter: '||securepubads.g.doubleclick.net^', resourceTypes: ['script', 'image', 'xmlhttprequest', 'sub_frame'] }
  }]
}).then(function () {
  return chrome.declarativeNetRequest.getDynamicRules()
}).then(function (rules) {
  console.log('network: dynamic rules ' + rules.map(r => r.id).join(','))
}, function (e) {
  console.log('network: updateDynamicRules failed ' + e.message)
})
