chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  document.getElementById('tab').textContent = 'Active tab: ' + (tabs[0] ? tabs[0].url : 'none')
})
chrome.storage.local.get('installedAt', function (data) {
  document.getElementById('storage').textContent = 'Installed at: ' + new Date(data.installedAt).toLocaleTimeString()
})
