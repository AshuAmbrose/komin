/* userscripts are loaded and run by main/userscripts.js and js/preload/userscripts.js.
   This keeps a list of them (without their code) for the !run bang and the page context menu,
   gets their GM_registerMenuCommand commands for the context menu, and opens and closes tabs for GM_openInTab. */

var path = require('path')

var webviews = require('webviews.js')
var browserUI = require('browserUI.js')
var bangsPlugin = require('searchbar/bangsPlugin.js')
var tabEditor = require('navbar/tabEditor.js')
var searchbarPlugins = require('searchbar/searchbarPlugins.js')
var userscriptMatching = require('util/userscriptMatching.js')

var statistics = require('js/statistics.js')

const userscripts = {
  scriptDir: path.join(window.globalArgs['user-data-path'], 'userscripts'),
  scripts: [], // {id, name, runAt, rules, matcher}
  setScripts: function (list) {
    userscripts.scripts = list.map(function (script) {
      return Object.assign({}, script, { matcher: userscriptMatching.compileUserscriptRules(script.rules) })
    })
  },
  showDirectory: function () {
    fs.mkdir(userscripts.scriptDir, { recursive: true }, function () {
      electron.shell.openPath(userscripts.scriptDir)
    })
  },
  getMatchingScripts: function (src) {
    return userscripts.scripts.filter(script => userscriptMatching.userscriptMatchesURL(script.matcher, src))
  },
  runScript: function (tabId, script) {
    ipc.invoke('userscripts-run', { tabId, scriptId: script.id })
  },
  // [{frameKey, scriptId, scriptName, id, caption}]
  getMenuCommands: function (tabId) {
    if (userscripts.scripts.length === 0) {
      return Promise.resolve([])
    }
    return ipc.invoke('userscripts-menu-commands', tabId).catch(() => [])
  },
  runMenuCommand: function (tabId, command) {
    ipc.invoke('userscripts-menu-command-run', { tabId, frameKey: command.frameKey, scriptId: command.scriptId, id: command.id })
  },
  initialize: function () {
    statistics.registerGetter('userscriptCount', function () {
      return userscripts.scripts.length
    })

    ipc.invoke('userscripts-list').then(userscripts.setScripts)
    ipc.on('userscripts-changed', function (e, list) {
      userscripts.setScripts(list)
    })

    webviews.bindIPC('showUserscriptDirectory', function () {
      userscripts.showDirectory()
    })

    // GM_openInTab (main/userscriptAPI.js)
    ipc.on('userscripts-open-tab', function (e, data) {
      const newTab = tabs.add({
        url: data.url,
        private: data.private
      })
      browserUI.addTab(newTab, {
        enterEditMode: false,
        openInBackground: !data.active
      })
      ipc.send('userscripts-tab-opened', { requestId: data.requestId, tabId: newTab })
    })

    ipc.on('userscripts-close-tab', function (e, tabId) {
      if (tabs.has(tabId)) {
        browserUI.closeTab(tabId)
      }
    })

    bangsPlugin.registerCustomBang({
      phrase: '!run',
      snippet: l('runUserscript'),
      isAction: false,
      showSuggestions: function (text, input, event) {
        searchbarPlugins.reset('bangs')

        var isFirst = true
        userscripts.scripts.forEach(function (script) {
          if (script.name.toLowerCase().startsWith(text.toLowerCase())) {
            searchbarPlugins.addResult('bangs', {
              title: script.name,
              fakeFocus: isFirst && text,
              click: function () {
                tabEditor.hide()
                userscripts.runScript(tabs.getSelected(), script)
              }
            })
            isFirst = false
          }
        })
      },
      fn: function (text) {
        if (!text) {
          return
        }
        var matchingScript = userscripts.scripts.find(script => script.name.toLowerCase().startsWith(text.toLowerCase()))
        if (matchingScript) {
          userscripts.runScript(tabs.getSelected(), matchingScript)
        }
      }
    })
  }
}

module.exports = userscripts
