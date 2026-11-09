window.ask = message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve))
window.commandsType = typeof chrome.commands
