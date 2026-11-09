// the harness sets values here and reads both areas
self.setSync = value => chrome.storage.sync.set({ setting: value })
self.readAreas = () => Promise.all([chrome.storage.sync.get("setting"), chrome.storage.local.get("setting")]).then(([s, l]) => ({ sync: s.setting, local: l.setting }))
