// What the harness reads back
self.changes = []
chrome.cookies.onChanged.addListener(change => self.changes.push(change.cookie.domain + ' ' + change.cookie.name))
// a refused call answers nothing (the extension library logs the error in this worker's console)
self.readCookies = () => chrome.cookies.getAll({}).then(list => Array.isArray(list) ? list.map(c => c.domain + ' ' + c.name + '=' + c.value) : 'refused', e => 'refused: ' + e.message)
self.getCookie = (url, name) => chrome.cookies.get({ url, name }).then(c => c === undefined ? 'refused' : (c ? c.value : null), e => 'refused: ' + e.message)
