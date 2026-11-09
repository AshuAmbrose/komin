chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
  window.activeTab = tabs[0] ? tabs[0].url : 'none'
  document.getElementById('tab').textContent = 'Active tab: ' + window.activeTab
})
