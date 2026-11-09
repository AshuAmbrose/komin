// records the lifecycle events this worker gets, and what `browser` is
self.events = []
chrome.runtime.onInstalled.addListener(details => self.events.push("installed:" + details.reason))
chrome.runtime.onStartup.addListener(() => self.events.push("startup"))
self.browserInfo = () => ({ exists: typeof browser !== "undefined", sameObject: typeof browser !== "undefined" && browser === chrome, sameRuntime: typeof browser !== "undefined" && browser.runtime === chrome.runtime, browserTabsCreate: typeof browser !== "undefined" && !!browser.tabs && typeof browser.tabs.create })
