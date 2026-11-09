// the panel can see the page beside it
chrome.tabs.query({ active: true, currentWindow: true }).then(function (found) {
  document.getElementById('tab').textContent = found.length ? 'Active tab: ' + found[0].title : 'No active tab'
  window.panelReady = true
})
