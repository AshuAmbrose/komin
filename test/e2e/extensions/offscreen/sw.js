// The worker opens the hidden helper page and sends it work, as Chrome extensions do for things a worker can't do
// (parsing HTML, the clipboard, audio). The suite calls these through the DevTools protocol.
self.openHelper = async function () {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'parse HTML for the test' })
  }
  return chrome.offscreen.hasDocument()
}
self.askHelper = message => chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, message))
