// The hidden helper page: parses HTML for the worker, and reports what its own chrome object looks like
const firstObjects = {}
Object.getOwnPropertyNames(chrome).forEach(name => { firstObjects[name] = chrome[name] })

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.target !== 'offscreen') {
    return
  }
  if (message.op === 'parse') {
    const doc = new DOMParser().parseFromString(message.html, 'text/html')
    sendResponse({ text: doc.body.textContent })
  } else if (message.op === 'probe') {
    sendResponse({
      apis: Object.getOwnPropertyNames(chrome).sort(),
      replaced: Object.keys(firstObjects).filter(name => chrome[name] !== firstObjects[name]),
      canRestore: typeof globalThis[Symbol.for('min.restoreExtensionAPIs')] === 'function',
      contextIsolated: typeof require === 'undefined'
    })
  }
})
