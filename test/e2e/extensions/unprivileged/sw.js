// What the harness reads back: every event this extension gets, with whatever address or title came with it
self.events = []
chrome.tabs.onCreated.addListener(tab => self.events.push({ type: 'created', id: tab.id, url: tab.url, title: tab.title }))
chrome.tabs.onUpdated.addListener((id, change, tab) => self.events.push({ type: 'updated', id, change, url: tab.url, title: tab.title }))
chrome.action.onClicked.addListener(tab => self.events.push({ type: 'clicked', id: tab.id, url: tab.url }))
// declared as optional and never granted: the APIs are there, and Min refuses them
if (chrome.webNavigation) chrome.webNavigation.onCommitted.addListener(details => self.events.push({ type: 'navigation', url: details.url }))
if (chrome.cookies) chrome.cookies.onChanged.addListener(change => self.events.push({ type: 'cookie', name: change.cookie.name }))

self.listTabs = query => chrome.tabs.query(query || {}).then(list => list.map(t => ({ id: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl, active: t.active })))
self.apis = () => ({ tabs: typeof chrome.tabs, cookies: typeof chrome.cookies, webNavigation: typeof chrome.webNavigation, notifications: typeof chrome.notifications, contextMenus: typeof chrome.contextMenus })
// The extension library's own bridge to main stays within reach of the extension's code (globalThis.electron), and
// takes the extension's id as an argument: this asks for cookies in another extension's name. Nothing comes back when
// Min refuses.
self.readCookiesAs = id => {
  const bridge = globalThis.electron
  if (!bridge || typeof bridge.invokeExtension !== 'function') return 'no bridge'
  return bridge.invokeExtension(id, 'cookies.getAll', {}, {}).then(list => Array.isArray(list) ? list.map(c => c.name + '=' + c.value) : 'refused', e => 'refused: ' + e.message)
}
// optional permissions (a refused call answers nothing)
self.permissionEvents = []
chrome.permissions.onAdded.addListener(added => self.permissionEvents.push({ type: 'added', added }))
chrome.permissions.onRemoved.addListener(removed => self.permissionEvents.push({ type: 'removed', removed }))
self.requestPermissions = wanted => chrome.permissions.request(wanted).then(answer => answer === undefined ? 'refused' : answer, e => 'refused: ' + e.message)
self.hasPermissions = wanted => chrome.permissions.contains(wanted)
self.removePermissions = wanted => chrome.permissions.remove(wanted)
// a refused call answers nothing (the extension library logs the error in this worker's console)
// a picture of the shown tab: 'picture' if Min allowed it (even when the window had nothing to draw), else its refusal
self.capture = () => chrome.tabs.captureVisibleTab().then(image => 'picture', e => /activeTab|all_urls/.test(e.message) ? 'refused: ' + e.message : 'picture (not drawn: ' + e.message + ')')
self.readCookies = () => chrome.cookies.getAll({}).then(list => Array.isArray(list) ? list.map(c => c.name + '=' + c.value) : 'refused', e => 'refused: ' + e.message)
