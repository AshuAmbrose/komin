// Marks the page so the harness can see the content script ran, then asks the background worker for a reply.
document.documentElement.dataset.minTestExtension = 'ran'
document.body.style.outline = '4px solid #507ac4'
chrome.runtime.sendMessage({ hello: location.href }, function (reply) {
  document.documentElement.dataset.minTestReply = JSON.stringify(reply || chrome.runtime.lastError)
})
