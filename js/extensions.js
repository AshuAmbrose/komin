/* Chrome extensions run in main (main/extensions.js, main/extensionAPIs.js). This draws their toolbar buttons and runs
   their keyboard shortcuts; opens, switches to and closes tabs when an extension asks (chrome.tabs.create,
   update({active: true}), remove; windows.create); makes room for an extension's side panel and draws its title bar;
   searches (chrome.search) and speaks (chrome.tts) for them; while extensions run, sends main this window's tabs in order
   (main/extensionTabs.js). */

var webviews = require('webviews.js')
var browserUI = require('browserUI.js')
var keybindings = require('keybindings.js')
var searchEngine = require('util/searchEngine.js')

const EXECUTE_ACTION_COMMANDS = ['_execute_action']

const extensions = {
  renderedButtons: '',
  commandsByCombo: {}, // key combo: {extensionId, name}
  registeredCombos: new Set(),
  // state: {buttons: [{id, title, badgeText, badgeColor, icon}], commands: [{extensionId, name, combo}]} from main
  showToolbar: function (state) {
    if (state.tabList) {
      extensions.startTabList()
    }
    const buttons = JSON.stringify(state.buttons)
    if (buttons !== extensions.renderedButtons) {
      extensions.renderedButtons = buttons
      extensions.renderButtons(state.buttons)
    }
    extensions.setCommands(state.commands)
  },
  renderButtons: function (buttons) {
    const container = document.getElementById('extension-actions')
    container.textContent = ''
    container.hidden = buttons.length === 0
    buttons.forEach(function (button) {
      const element = document.createElement('button')
      element.className = 'navbar-action-button extension-action-button'
      element.tabIndex = -1
      element.title = button.title
      element.setAttribute('aria-label', button.title)
      element.dataset.extensionId = button.id
      if (button.icon) {
        const icon = document.createElement('img')
        icon.alt = ''
        icon.src = button.icon
        element.appendChild(icon)
      } else {
        element.textContent = (button.title || '?').trim().charAt(0).toUpperCase()
      }
      if (button.badgeText) {
        const badge = document.createElement('span')
        badge.className = 'extension-action-badge'
        badge.textContent = button.badgeText
        if (button.badgeColor) {
          badge.style.background = button.badgeColor
        }
        element.appendChild(badge)
      }
      element.addEventListener('click', () => extensions.activate(button.id))
      element.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        const rect = element.getBoundingClientRect()
        ipc.send('extensions-toolbar-menu', { id: button.id, x: rect.left, y: rect.bottom })
      })
      container.appendChild(element)
    })
  },
  // a click on the button: main opens the popup under it, or sends action.onClicked
  activate: function (extensionId) {
    const element = document.querySelector('#extension-actions [data-extension-id="' + extensionId + '"]')
    if (!element) {
      return
    }
    const rect = element.getBoundingClientRect()
    ipc.invoke('extensions-toolbar-click', {
      id: extensionId,
      anchorRect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
    })
  },
  // keybindings.js can't remove a shortcut, so each key combo is defined once and looks up which command it runs now.
  // A combo Min already uses is skipped, as Chrome skips suggested keys that clash; the first extension to ask gets it.
  setCommands: function (commands) {
    extensions.commandsByCombo = {}
    commands.forEach(function (command) {
      if (extensions.commandsByCombo[command.combo]) {
        return
      }
      if (!extensions.registeredCombos.has(command.combo)) {
        if (keybindings.hasShortcut(command.combo)) {
          return
        }
        extensions.registeredCombos.add(command.combo)
        keybindings.defineShortcut({ keys: command.combo }, () => extensions.runCommand(command.combo))
      }
      extensions.commandsByCombo[command.combo] = command
    })
  },
  runCommand: function (combo) {
    const command = extensions.commandsByCombo[combo]
    if (!command) {
      return
    }
    if (EXECUTE_ACTION_COMMANDS.includes(command.name)) {
      extensions.activate(command.extensionId)
    } else {
      ipc.send('extensions-command', { extensionId: command.extensionId, name: command.name })
    }
  },
  // the side panel shown in this window ({extensionId, title, width, header}), or null. The tab is narrowed by its width;
  // main places the panel's page below the title bar drawn here.
  sidePanel: null,
  showSidePanel: function (panel) {
    if (extensions.sidePanel) {
      webviews.adjustMargin([0, -extensions.sidePanel.width, 0, 0])
    }
    extensions.sidePanel = panel
    const header = document.getElementById('extension-side-panel-header')
    header.hidden = !panel
    if (panel) {
      document.getElementById('extension-side-panel-title').textContent = panel.title
      webviews.adjustMargin([0, panel.width, 0, 0])
      extensions.placeSidePanelHeader()
    }
  },
  placeSidePanelHeader: function () {
    const panel = extensions.sidePanel
    if (!panel) {
      return
    }
    const bounds = webviews.getViewBounds()
    const header = document.getElementById('extension-side-panel-header')
    header.style.left = (bounds.x + bounds.width) + 'px'
    header.style.top = bounds.y + 'px'
    header.style.width = panel.width + 'px'
    header.style.height = panel.header + 'px'
  },
  // chrome.tts, with the system's voices
  speak: function (data) {
    if (data.action === 'voices') {
      const answer = function () {
        ipc.send('extensions-tts-voices', {
          requestId: data.requestId,
          voices: speechSynthesis.getVoices().map(voice => ({
            voiceName: voice.name,
            lang: voice.lang,
            remote: !voice.localService,
            eventTypes: ['start', 'end', 'word', 'sentence', 'interrupted', 'cancelled', 'error', 'pause', 'resume']
          }))
        })
      }
      // the list can be empty until the system has loaded it
      if (speechSynthesis.getVoices().length > 0) {
        answer()
      } else {
        speechSynthesis.addEventListener('voiceschanged', answer, { once: true })
        setTimeout(answer, 1000)
      }
    } else if (data.action === 'stop') {
      speechSynthesis.cancel()
    } else if (data.action === 'pause') {
      speechSynthesis.pause()
    } else if (data.action === 'resume') {
      speechSynthesis.resume()
    } else if (data.action === 'speak') {
      const options = data.options
      if (!options.enqueue) {
        speechSynthesis.cancel()
      }
      const utterance = new SpeechSynthesisUtterance(data.text)
      if (options.lang) {
        utterance.lang = options.lang
      }
      const voice = options.voiceName && speechSynthesis.getVoices().find(v => v.name === options.voiceName)
      if (voice) {
        utterance.voice = voice
      }
      ;['rate', 'pitch', 'volume'].forEach(function (name) {
        if (typeof options[name] === 'number') {
          utterance[name] = options[name]
        }
      })
      const send = (type, extra) => ipc.send('extensions-tts-event', Object.assign({ requestId: data.requestId, extensionId: data.extensionId, type }, extra))
      utterance.onstart = () => send('start', { charIndex: 0 })
      utterance.onend = () => send('end', { charIndex: data.text.length })
      utterance.onpause = () => send('pause', { charIndex: 0 })
      utterance.onresume = () => send('resume', { charIndex: 0 })
      utterance.onboundary = e => send(e.name === 'sentence' ? 'sentence' : 'word', { charIndex: e.charIndex })
      utterance.onerror = function (e) {
        if (e.error === 'interrupted' || e.error === 'canceled') {
          send(e.error === 'canceled' ? 'cancelled' : 'interrupted', { charIndex: e.charIndex })
        } else {
          send('error', { charIndex: e.charIndex, errorMessage: e.error })
        }
      }
      speechSynthesis.speak(utterance)
    }
  },
  // Min's tabs as extensions should see them: every task's tabs in order (private tabs never), sent after each change
  sendingTabList: false,
  startTabList: function () {
    if (extensions.sendingTabList) {
      return
    }
    extensions.sendingTabList = true
    const send = debounce(function () {
      ipc.send('extensions-tab-list', tasks.map(task => ({
        selectedHere: task.selectedInWindow === windowId,
        selectedInAnyWindow: !!task.selectedInWindow,
        tabs: task.tabs.get().filter(tab => !tab.private).map(tab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          muted: !!tab.muted,
          favicon: tab.favicon ? tab.favicon.url : undefined,
          hasView: webviews.hasViewForTab(tab.id)
        }))
      })))
    }, 100)
    // not after changes the list doesn't carry: a tab's scroll position changes with every scroll
    const notListed = ['scrollPosition', 'lastActivity', 'previewImage', 'themeColor', 'backgroundColor', 'secure', 'readerable', 'hasAudio', 'isFileView']
    tasks.on('*', function (name, id, key) {
      if (name !== 'tab-updated' || !notListed.includes(key)) {
        send()
      }
    })
    send()
  },
  initialize: function () {
    ipc.invoke('extensions-toolbar-get').then(extensions.showToolbar)
    ipc.on('extensions-tab-list-wanted', () => extensions.startTabList())
    ipc.on('extensions-toolbar', (e, state) => extensions.showToolbar(state))

    ipc.on('extensions-open-tab', function (e, data) {
      const newTab = tabs.add({ url: data.url })
      browserUI.addTab(newTab, {
        enterEditMode: false,
        openInBackground: !data.active
      })
      ipc.send('extensions-tab-opened', { requestId: data.requestId, tabId: newTab })
    })

    // an extension reloaded a discarded tab (hibernated, or not loaded yet), or gave it a new address: its page loads
    // again, in the background (main/extensionTabs.js). data: {tabId, url}
    ipc.on('extensions-load-tab', function (e, data) {
      const task = tasks.getTaskContainingTab(data.tabId)
      if (!task) {
        return
      }
      if (data.url) {
        task.tabs.update(data.tabId, { url: data.url })
      }
      if (webviews.hasViewForTab(data.tabId)) {
        if (data.url) {
          webviews.update(data.tabId, data.url)
        }
      } else if (task.id === tasks.getSelected().id) {
        // only a tab of the task shown here: webviews.add reads that task's tabs. Any other loads when it's shown
        webviews.add(data.tabId)
      }
    })

    // an extension muted or unmuted a discarded tab: kept with the tab, for when its page loads. data: {tabId, muted}
    ipc.on('extensions-mute-tab', function (e, data) {
      const task = tasks.getTaskContainingTab(data.tabId)
      if (task) {
        task.tabs.update(data.tabId, { muted: !!data.muted })
      }
    })

    ipc.on('extensions-select-tab', function (e, tabId) {
      const task = tasks.getTaskContainingTab(tabId)
      if (!task) {
        return
      }
      if (task.id !== tasks.getSelected().id) {
        browserUI.switchToTask(task.id)
      }
      if (tabs.getSelected() !== tabId) {
        browserUI.switchToTab(tabId)
      }
    })

    // {extensionId: null} when it closes
    ipc.on('extensions-side-panel', (e, panel) => extensions.showSidePanel(panel.extensionId ? panel : null))
    webviews.bindEvent('view-resized', extensions.placeSidePanelHeader)
    document.getElementById('extension-side-panel-close').addEventListener('click', () => ipc.send('extensions-side-panel-close'))

    ipc.on('extensions-tts', (e, data) => extensions.speak(data))

    // chrome.search.query, with Min's search engine
    ipc.on('extensions-search', function (e, data) {
      const url = searchEngine.getCurrent().searchURL.replace('%s', encodeURIComponent(data.text))
      const tabId = data.tabId && tabs.has(data.tabId) ? data.tabId : tabs.getSelected()
      if (data.newTab || !tabId) {
        browserUI.addTab(tabs.add({ url }), { enterEditMode: false })
      } else {
        webviews.update(tabId, url)
      }
    })

    ipc.on('extensions-close-tab', function (e, tabId) {
      const task = tasks.getTaskContainingTab(tabId)
      if (!task) {
        return
      }
      if (task.id === tasks.getSelected().id) {
        browserUI.closeTab(tabId)
      } else {
        // as the task overlay does for tabs in other tasks; the task stays even if it's now empty
        task.tabs.destroy(tabId)
        webviews.destroy(tabId)
      }
    })
  }
}

module.exports = extensions
