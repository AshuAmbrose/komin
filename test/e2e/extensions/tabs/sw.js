// What the harness reads back: every tab event, in order
self.events = []
chrome.tabs.onCreated.addListener(tab => self.events.push({ type: 'created', id: tab.id, url: tab.url || tab.pendingUrl }))
chrome.tabs.onRemoved.addListener(id => self.events.push({ type: 'removed', id }))
chrome.tabs.onReplaced.addListener((added, removed) => self.events.push({ type: 'replaced', added, removed }))
chrome.tabs.onUpdated.addListener((id, change) => { if ('discarded' in change) self.events.push({ type: 'discarded', id, discarded: change.discarded }) })

// this window's tabs as Chrome reports them: sorted by index, with what the harness compares
self.listTabs = function (query) {
  return chrome.tabs.query(query || { currentWindow: true }).then(list => list
    .sort((a, b) => a.index - b.index)
    .map(t => ({ id: t.id, index: t.index, url: t.url, active: t.active, discarded: t.discarded })))
}
