// What the harness reads back: events received, and whether `chrome` can be added to (Chrome's can)
self.events = { created: [], changed: [], erased: [], privacy: [], panel: [] }
self.chromeExtensible = (() => { try { chrome.minTestProperty = 1; return chrome.minTestProperty === 1 } catch (e) { return String(e) } })()

chrome.downloads.onCreated.addListener(item => self.events.created.push({ id: item.id, byExtensionId: item.byExtensionId, state: item.state }))
chrome.downloads.onChanged.addListener(delta => self.events.changed.push(delta))
chrome.downloads.onErased.addListener(id => self.events.erased.push(id))
chrome.privacy.services.passwordSavingEnabled.onChange.addListener(details => self.events.privacy.push(details))
chrome.sidePanel.onOpened.addListener(info => self.events.panel.push('opened ' + info.path))
chrome.sidePanel.onClosed.addListener(info => self.events.panel.push('closed ' + info.path))

// a red square, as pixels
self.setRedIcon = function () {
  const data = new ImageData(16, 16)
  for (let i = 0; i < data.data.length; i += 4) {
    data.data[i] = 255
    data.data[i + 3] = 255
  }
  return chrome.action.setIcon({ imageData: data })
}

// speech, with every event it gets
self.speak = function (text) {
  return new Promise(function (resolve) {
    const events = []
    chrome.tts.speak(text, {
      volume: 0,
      onEvent: function (event) {
        events.push(event.type)
        if (['end', 'interrupted', 'cancelled', 'error'].includes(event.type)) {
          resolve(events)
        }
      }
    })
    setTimeout(() => resolve(events.concat('timeout')), 15000)
  })
}

// Chrome's callback style: [result, lastError message]
self.withCallback = function (fn) {
  return new Promise(resolve => fn(result => resolve([result, chrome.runtime.lastError ? chrome.runtime.lastError.message : null])))
}
