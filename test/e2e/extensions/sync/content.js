// what a content script sees in sync storage, and changes to it
const show = value => { document.documentElement.dataset.syncSetting = value }
chrome.storage.sync.get("setting").then(r => show(r.setting === undefined ? "none" : r.setting), e => show("error " + e.message))
chrome.storage.onChanged.addListener((changes, area) => { if (area === "sync" && changes.setting) show("changed " + changes.setting.newValue) })
