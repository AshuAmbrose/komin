// Marks the page and asks the background worker for a reply, so the harness can see both work.
document.documentElement.dataset.minCoreContent = 'ran'
chrome.runtime.sendMessage({ op: 'ping' }, function (reply) {
  document.documentElement.dataset.minCoreReply = JSON.stringify(reply || String(chrome.runtime.lastError && chrome.runtime.lastError.message))
})
