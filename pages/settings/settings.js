document.title = l('settingsPreferencesHeading') + ' | Min'

var contentTypeBlockingContainer = document.getElementById('content-type-blocking')
var banner = document.getElementById('restart-required-banner')
var siteThemeCheckbox = document.getElementById('checkbox-site-theme')
var showDividerCheckbox = document.getElementById('checkbox-show-divider')
var userscriptsCheckbox = document.getElementById('checkbox-userscripts')
var userscriptsShowDirectorySection = document.getElementById('userscripts-show-directory')
var userscriptsPrivateTabsSection = document.getElementById('userscripts-private-tabs-section')
var userscriptsPrivateTabsCheckbox = document.getElementById('checkbox-userscripts-private-tabs')
var separateTitlebarCheckbox = document.getElementById('checkbox-separate-titlebar')
var openTabsInForegroundCheckbox = document.getElementById('checkbox-open-tabs-in-foreground')
var autoPlayCheckbox = document.getElementById('checkbox-enable-autoplay')
var userAgentCheckbox = document.getElementById('checkbox-user-agent')
var userAgentInput = document.getElementById('input-user-agent')

function showRestartRequiredBanner () {
  banner.hidden = false
  settings.set('restartNow', true)
}
settings.get('restartNow', (value) => {
  if (value === true) {
    showRestartRequiredBanner()
  }
})

/* content blocking settings */

var trackingLevelContainer = document.getElementById('tracking-level-container')
var trackingLevelOptions = Array.from(trackingLevelContainer.querySelectorAll('input[name=blockingLevel]'))
var blockingExceptionsContainer = document.getElementById('content-blocking-information')
var blockingExceptionsInput = document.getElementById('content-blocking-exceptions')
var blockedRequestCount = document.querySelector('#content-blocking-blocked-requests strong')

settings.listen('filteringBlockedCount', function (value) {
  var count = value || 0
  var valueStr
  if (count > 50000) {
    valueStr = new Intl.NumberFormat(navigator.locale, { notation: 'compact', maximumSignificantDigits: 4 }).format(count)
  } else {
    valueStr = new Intl.NumberFormat().format(count)
  }
  blockedRequestCount.textContent = valueStr
})

function updateBlockingLevelUI (level) {
  var radio = trackingLevelOptions[level]
  radio.checked = true

  if (level === 0) {
    blockingExceptionsContainer.hidden = true
  } else {
    blockingExceptionsContainer.hidden = false
    radio.parentNode.appendChild(blockingExceptionsContainer)
  }

  if (document.querySelector('#tracking-level-container .setting-option.selected')) {
    document.querySelector('#tracking-level-container .setting-option.selected').classList.remove('selected')
  }
  radio.parentNode.classList.add('selected')
}

function changeBlockingLevelSetting (level) {
  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.blockingLevel = level
    settings.set('filtering', value)
    updateBlockingLevelUI(level)
  })
}

function setExceptionInputSize () {
  blockingExceptionsInput.style.height = (blockingExceptionsInput.scrollHeight + 2) + 'px'
}

settings.get('filtering', function (value) {
  // migrate from old settings (<v1.9.0)
  if (value && typeof value.trackers === 'boolean') {
    if (value.trackers === true) {
      value.blockingLevel = 2
    } else if (value.trackers === false) {
      value.blockingLevel = 0
    }
    delete value.trackers
    settings.set('filtering', value)
  }

  if (value && value.blockingLevel !== undefined) {
    updateBlockingLevelUI(value.blockingLevel)
  } else {
    updateBlockingLevelUI(1)
  }

  if (value && value.exceptionDomains && value.exceptionDomains.length > 0) {
    blockingExceptionsInput.value = value.exceptionDomains.join(', ') + ', '
    setExceptionInputSize()
  }
})

trackingLevelOptions.forEach(function (item, idx) {
  item.addEventListener('change', function () {
    changeBlockingLevelSetting(idx)
  })
})

blockingExceptionsInput.addEventListener('input', function () {
  setExceptionInputSize()

  // remove protocols because of https://github.com/minbrowser/min/issues/1428
  var newValue = this.value.split(',').map(i => i.trim().replace('http://', '').replace('https://', '')).filter(i => !!i)

  settings.get('filtering', function (value) {
    if (!value) {
      value = {}
    }
    value.exceptionDomains = newValue
    settings.set('filtering', value)
  })
})

/* content type settings */

var contentTypes = {
  // humanReadableName: contentType
  scripts: 'script',
  images: 'image'
}

// used for showing localized strings
var contentTypeSettingNames = {
  scripts: 'settingsBlockScriptsToggle',
  images: 'settingsBlockImagesToggle'
}

for (var contentType in contentTypes) {
  (function (contentType) {
    settings.get('filtering', function (value) {
      // create the settings section for blocking each content type

      var section = document.createElement('div')
      section.classList.add('setting-section')

      var id = 'checkbox-block-' + contentTypes[contentType]

      var checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.id = id

      if (value && value.contentTypes) {
        checkbox.checked = value.contentTypes.indexOf(contentTypes[contentType]) != -1
      }

      var label = document.createElement('label')
      label.setAttribute('for', id)
      label.textContent = l(contentTypeSettingNames[contentType])

      section.appendChild(checkbox)
      section.appendChild(label)

      contentTypeBlockingContainer.appendChild(section)

      checkbox.addEventListener('change', function (e) {
        settings.get('filtering', function (value) {
          if (!value) {
            value = {}
          }
          if (!value.contentTypes) {
            value.contentTypes = []
          }

          if (e.target.checked) { // add the item to the array
            value.contentTypes.push(contentTypes[contentType])
          } else { // remove the item from the array
            var idx = value.contentTypes.indexOf(contentTypes[contentType])
            value.contentTypes.splice(idx, 1)
          }

          settings.set('filtering', value)
        })
      })
    })
  })(contentType)
}

/* dark mode setting */
var darkModeNever = document.getElementById('dark-mode-never')
var darkModeNight = document.getElementById('dark-mode-night')
var darkModeAlways = document.getElementById('dark-mode-always')
var darkModeSystem = document.getElementById('dark-mode-system')

// -1 - off ; 0 - auto ; 1 - on
settings.get('darkMode', function (value) {
  darkModeNever.checked = (value === -1)
  darkModeNight.checked = (value === 0)
  darkModeAlways.checked = (value === 1 || value === true)
  darkModeSystem.checked = (value === 2 || value === undefined || value === false)
})

darkModeNever.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', -1)
  }
})
darkModeNight.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 0)
  }
})
darkModeAlways.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 1)
  }
})
darkModeSystem.addEventListener('change', function (e) {
  if (this.checked) {
    settings.set('darkMode', 2)
  }
})

/* site theme setting */

settings.get('siteTheme', function (value) {
  if (value === true || value === undefined) {
    siteThemeCheckbox.checked = true
  } else {
    siteThemeCheckbox.checked = false
  }
})

siteThemeCheckbox.addEventListener('change', function (e) {
  settings.set('siteTheme', this.checked)
})

/* startup settings */

var startupSettingInput = document.getElementById('startup-options')

settings.get('startupTabOption', function(value = 2) {
  startupSettingInput.value = value
})

startupSettingInput.addEventListener('change', function() {
  settings.set('startupTabOption', parseInt(this.value))
})

/* new window settings */

var newWindowSettingInput = document.getElementById('new-window-options')

settings.get('newWindowOption', function(value = 1) {
  newWindowSettingInput.value = value
})

newWindowSettingInput.addEventListener('change', function() {
  settings.set('newWindowOption', parseInt(this.value))
})

/* userscripts setting */

var userscriptsManager = document.getElementById('userscripts-manager')
var userscriptsList = document.getElementById('userscripts-list')
var userscriptsEmpty = document.getElementById('userscripts-empty')
var userscriptsStatus = document.getElementById('userscripts-status')

function showUserscriptSettings (enabled) {
  userscriptsShowDirectorySection.hidden = !enabled
  userscriptsPrivateTabsSection.hidden = !enabled
  userscriptsManager.hidden = !enabled
  if (enabled) {
    loadUserscriptList()
  }
}

function createUserscriptLink (text, onClick) {
  var link = document.createElement('a')
  link.textContent = text
  link.addEventListener('click', onClick)
  return link
}

function addUserscriptDetail (parent, text, className) {
  var detail = document.createElement('div')
  detail.className = 'userscript-detail' + (className ? ' ' + className : '')
  detail.textContent = text
  parent.appendChild(detail)
  return detail
}

// the scripts in <userData>/userscripts (main/userscriptInstall.js)
function renderUserscriptList (data) {
  userscriptsList.textContent = ''
  userscriptsEmpty.hidden = data.scripts.length > 0

  data.scripts.forEach(function (script, i) {
    var item = document.createElement('div')
    item.className = 'userscript-item'

    var checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.id = 'userscript-' + i
    checkbox.checked = script.enabled
    checkbox.addEventListener('change', function () {
      userscriptPages.request('set-enabled', { id: script.id, enabled: checkbox.checked })
    })
    item.appendChild(checkbox)

    var info = document.createElement('div')
    info.className = 'userscript-info'
    var name = document.createElement('label')
    name.htmlFor = checkbox.id
    name.className = 'userscript-name'
    name.textContent = script.name + (script.version ? ' ' + script.version : '')
    info.appendChild(name)

    if (script.description) {
      addUserscriptDetail(info, script.description)
    }

    var sites = script.runsEverywhere ? [l('userscriptInstallEverywhere')] : script.sites.map(userscriptPages.describeSite)
    var where = script.legacy ? l('settingsUserscriptsLegacy') : l('settingsUserscriptsRunsOn').replace('%s', sites.slice(0, 3).join(', ') + (sites.length > 3 ? ', …' : ''))
    var from = script.sourceURL ? l('settingsUserscriptsFrom').replace('%s', userscriptPages.describeHost(script.sourceURL)) : l('settingsUserscriptsLocal')
    addUserscriptDetail(info, where + ' · ' + from, 'light-fade')

    if (script.pendingUpdate) {
      var review = addUserscriptDetail(info, '')
      review.appendChild(createUserscriptLink(l('settingsUserscriptsReviewUpdate').replace('%v', script.pendingUpdate.version), function () {
        window.location = 'min://app/pages/userscriptInstall/index.html?url=' + encodeURIComponent(script.pendingUpdate.url) + '&id=' + encodeURIComponent(script.id)
      }))
    }
    if (script.downloading) {
      addUserscriptDetail(info, l('settingsUserscriptsDownloading'), 'light-fade')
    }
    if (script.downloadError) {
      addUserscriptDetail(info, l('settingsUserscriptsDownloadFailed').replace('%s', script.downloadError), 'userscript-error')
    }
    if (script.updateError) {
      addUserscriptDetail(info, l('settingsUserscriptsUpdateFailed').replace('%s', script.updateError), 'light-fade')
    }
    item.appendChild(info)

    var actions = document.createElement('div')
    actions.className = 'userscript-actions'
    actions.appendChild(createUserscriptLink(l('settingsUserscriptsEdit'), function () {
      userscriptPages.request('edit', { id: script.id })
    }))
    actions.appendChild(createUserscriptLink(l('settingsUserscriptsRemove'), function () {
      if (confirm(l('settingsUserscriptsRemoveConfirm').replace('%s', script.name))) {
        userscriptPages.request('remove', { id: script.id })
      }
    }))
    item.appendChild(actions)

    userscriptsList.appendChild(item)
  })
}

function loadUserscriptList () {
  userscriptPages.request('list').then(renderUserscriptList, function (e) {
    userscriptsStatus.textContent = e.message
  })
}

userscriptPages.onChange(function () {
  if (!userscriptsManager.hidden) {
    loadUserscriptList()
  }
})

document.getElementById('userscripts-new').addEventListener('click', function () {
  userscriptPages.request('create')
})

document.getElementById('userscripts-check-updates').addEventListener('click', function () {
  userscriptsStatus.textContent = l('settingsUserscriptsChecking')
  userscriptPages.request('check-updates').then(function (data) {
    userscriptsStatus.textContent = ''
    renderUserscriptList(data)
  }, function (e) {
    userscriptsStatus.textContent = e.message
  })
})

settings.get('userscriptsEnabled', function (value) {
  userscriptsCheckbox.checked = value === true
  showUserscriptSettings(value === true)
})

userscriptsCheckbox.addEventListener('change', function (e) {
  settings.set('userscriptsEnabled', this.checked)
  showUserscriptSettings(this.checked)
})

settings.get('userscriptsInPrivateTabs', function (value) {
  userscriptsPrivateTabsCheckbox.checked = value === true
})

userscriptsPrivateTabsCheckbox.addEventListener('change', function (e) {
  settings.set('userscriptsInPrivateTabs', this.checked)
})

userscriptsShowDirectorySection.getElementsByTagName('a')[0].addEventListener('click', function() {
  postMessage({ message: 'showUserscriptDirectory' })
})

/* show divider between tabs setting */

settings.get('showDividerBetweenTabs', function (value) {
  if (value === true) {
    showDividerCheckbox.checked = true
  }
})

showDividerCheckbox.addEventListener('change', function (e) {
  settings.set('showDividerBetweenTabs', this.checked)
})

/* language setting*/

var languagePicker = document.getElementById('setting-language-picker')

for (var language in languages) { //from localization.build.js
  var item = document.createElement('option')
  item.textContent = languages[language].name
  item.value = languages[language].identifier
  languagePicker.appendChild(item)
}

languagePicker.value = getCurrentLanguage()

languagePicker.addEventListener('change', function () {
  settings.set('userSelectedLanguage', this.value)
  showRestartRequiredBanner()
})

/* separate titlebar setting */

settings.get('useSeparateTitlebar', function (value) {
  if (value === true) {
    separateTitlebarCheckbox.checked = true
  }
})

separateTitlebarCheckbox.addEventListener('change', function (e) {
  settings.set('useSeparateTitlebar', this.checked)
  showRestartRequiredBanner()
})

/* tabs in foreground setting */

settings.get('openTabsInForeground', function (value) {
  if (value === true) {
    openTabsInForegroundCheckbox.checked = true
  }
})

openTabsInForegroundCheckbox.addEventListener('change', function (e) {
  settings.set('openTabsInForeground', this.checked)
})

/* media autoplay setting */

settings.get('enableAutoplay', function (value) {
  autoPlayCheckbox.checked = value
})

autoPlayCheckbox.addEventListener('change', function (e) {
  settings.set('enableAutoplay', this.checked)
})

/* user agent settting */

settings.get('customUserAgent', function (value) {
  if (value) {
    userAgentCheckbox.checked = true
    userAgentInput.style.visibility = 'visible'
    userAgentInput.value = value
  }
})

userAgentCheckbox.addEventListener('change', function (e) {
  if (this.checked) {
    userAgentInput.style.visibility = 'visible'
  } else {
    settings.set('customUserAgent', null)
    userAgentInput.style.visibility = 'hidden'
    showRestartRequiredBanner()
  }
})

userAgentInput.addEventListener('input', function (e) {
  const value = this.value.slice(0, 200)
  if (value !== this.value) {
    this.value = value
  }
  if (value) {
    settings.set('customUserAgent', value)
  } else {
    settings.set('customUserAgent', null)
  }
  showRestartRequiredBanner()
})

/* update notifications setting */

var updateNotificationsCheckbox = document.getElementById('checkbox-update-notifications')

settings.get('updateNotificationsEnabled', function (value) {
  if (value === false) {
    updateNotificationsCheckbox.checked = false
  } else {
    updateNotificationsCheckbox.checked = true
  }
})

updateNotificationsCheckbox.addEventListener('change', function (e) {
  settings.set('updateNotificationsEnabled', this.checked)
})

/* usage statistics setting */

var usageStatisticsCheckbox = document.getElementById('checkbox-usage-statistics')

settings.get('collectUsageStats', function (value) {
  if (value === false) {
    usageStatisticsCheckbox.checked = false
  } else {
    usageStatisticsCheckbox.checked = true
  }
})

usageStatisticsCheckbox.addEventListener('change', function (e) {
  settings.set('collectUsageStats', this.checked)
})

/* default search engine setting */

var searchEngineDropdown = document.getElementById('default-search-engine')
var searchEngineInput = document.getElementById('custom-search-engine')

searchEngineInput.setAttribute('placeholder', l('customSearchEngineDescription'))

settings.onLoad(function () {
  if (currentSearchEngine.custom) {
    searchEngineInput.hidden = false
    searchEngineInput.value = currentSearchEngine.searchURL
  }

  for (var searchEngine in searchEngines) {
    var item = document.createElement('option')
    item.textContent = searchEngines[searchEngine].name

    if (searchEngines[searchEngine].name == currentSearchEngine.name) {
      item.setAttribute('selected', 'true')
    }

    searchEngineDropdown.appendChild(item)
  }

  // add custom option
  item = document.createElement('option')
  item.textContent = 'custom'
  if (currentSearchEngine.custom) {
    item.setAttribute('selected', 'true')
  }
  searchEngineDropdown.appendChild(item)
})

searchEngineDropdown.addEventListener('change', function (e) {
  if (this.value === 'custom') {
    searchEngineInput.hidden = false
  } else {
    searchEngineInput.hidden = true
    settings.set('searchEngine', { name: this.value })
  }
})

searchEngineInput.addEventListener('input', function (e) {
  settings.set('searchEngine', { url: this.value })
})

/* key map settings */

settings.get('keyMap', function (keyMapSettings) {
  var keyMap = userKeyMap(keyMapSettings)

  var keyMapList = document.getElementById('key-map-list')

  Object.keys(keyMap).forEach(function (action) {
    var li = createKeyMapListItem(action, keyMap)
    keyMapList.appendChild(li)
  })
})

function formatCamelCase (text) {
  var result = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  return result.charAt(0).toUpperCase() + result.slice(1)
}

function createKeyMapListItem (action, keyMap) {
  var li = document.createElement('li')
  var label = document.createElement('label')
  var input = document.createElement('input')
  label.innerText = formatCamelCase(action)
  label.htmlFor = action

  input.type = 'text'
  input.id = input.name = action
  input.value = formatKeyValue(keyMap[action])
  input.addEventListener('input', onKeyMapChange)

  li.appendChild(label)
  li.appendChild(input)

  return li
}

function formatKeyValue (value) {
  // multiple shortcuts should be separated by commas
  if (value instanceof Array) {
    value = value.join(', ')
  }
  // use either command or ctrl depending on the platform
  if (navigator.platform === 'MacIntel') {
    value = value.replace(/\bmod\b/g, 'command')
  } else {
    value = value.replace(/\bmod\b/g, 'ctrl')
    value = value.replace(/\boption\b/g, 'alt')
  }
  if (navigator.platform === 'Win32') {
    value = value.replace(/\bsuper\b/g, 'win')
  }
  return value
}

function parseKeyInput (input) {
  // input may be a single mapping or multiple mappings comma separated.
  var parsed = input.toLowerCase().split(',')
  parsed = parsed.map(function (e) { return e.trim() })
  // Remove empty
  parsed = parsed.filter(Boolean)
  // convert key names back to generic equivalents
  parsed = parsed.map(function (e) {
    if (navigator.platform === 'MacIntel') {
      e = e.replace(/\b(command)|(cmd)\b/g, 'mod')
    } else {
      e = e.replace(/\b(control)|(ctrl)\b/g, 'mod')
      e = e.replace(/\balt\b/g, 'option')
      e = e.replace(/\bwin\b/g, 'super')
    }
    return e
  })
  return parsed.length > 1 ? parsed : parsed[0]
}

function onKeyMapChange (e) {
  var action = this.name
  var newValue = this.value

  settings.get('keyMap', function (keyMapSettings) {
    if (!keyMapSettings) {
      keyMapSettings = {}
    }

    keyMapSettings[action] = parseKeyInput(newValue)
    settings.set('keyMap', keyMapSettings)
    showRestartRequiredBanner()
  })
}

/* Password auto-fill settings  */

var passwordManagersDropdown = document.getElementById('selected-password-manager')
for (var manager in passwordManagers) {
  var item = document.createElement('option')
  item.textContent = passwordManagers[manager].name
  passwordManagersDropdown.appendChild(item)
}

settings.listen('passwordManager', function (value) {
  passwordManagersDropdown.value = currentPasswordManager.name
})

passwordManagersDropdown.addEventListener('change', function (e) {
  if (this.value === 'none') {
    settings.set('passwordManager', { name: 'none' })
  } else {
    settings.set('passwordManager', { name: this.value })
  }
})

var keychainViewLink = document.getElementById('keychain-view-link')

keychainViewLink.addEventListener('click', function () {
  postMessage({ message: 'showCredentialList' })
})

settings.listen('passwordManager', function (value) {
  keychainViewLink.hidden = !(currentPasswordManager.name === 'Built-in password manager')
})

/* proxy settings */

const proxyTypeInput = document.getElementById('selected-proxy-type')
const proxyInputs = Array.from(document.querySelectorAll('#proxy-settings-container input'))

const toggleProxyOptions = proxyType => {
  document.getElementById('manual-proxy-section').hidden = proxyType != 1
  document.getElementById('pac-option').hidden = proxyType != 2
}

const setProxy = (key, value) => {
  settings.get('proxy', (proxy = {}) => {
    proxy[key] = value
    settings.set('proxy', proxy)
  })
}

settings.get('proxy', (proxy = {}) => {
  toggleProxyOptions(proxy.type)

  proxyTypeInput.options.selectedIndex = proxy.type || 0
  proxyInputs.forEach(item => item.value = proxy[item.name] || '')
})

proxyTypeInput.addEventListener('change', e => {
  const proxyType = e.target.options.selectedIndex
  setProxy('type', proxyType)
  toggleProxyOptions(proxyType)
})

proxyInputs.forEach(item => item.addEventListener('change', e => setProxy(e.target.name, e.target.value)))

settings.get('customBangs', (value) => {
  const bangslist = document.getElementById('custom-bangs')

  if (value) {
    value.forEach(function (bang) {
      bangslist.appendChild(createBang(bang.phrase, bang.snippet, bang.redirect))
    })
  }
})

document.getElementById('add-custom-bang').addEventListener('click', function () {
  const bangslist = document.getElementById('custom-bangs')
  const newListItem = createBang()
  bangslist.appendChild(newListItem)
  document.body.scrollBy(0, Math.round(newListItem.getBoundingClientRect().height))
})

function createBang (bang, snippet, redirect) {
  var li = document.createElement('li')
  var bangInput = document.createElement('input')
  var snippetInput = document.createElement('input')
  var redirectInput = document.createElement('input')
  var xButton = document.createElement('button')
  var current = { phrase: bang ?? '', snippet: snippet ?? '', redirect: redirect ?? '' }
  function update (key, input) {
    settings.get('customBangs', function (d) {
      const filtered = d ? d.filter((bang) => bang.phrase !== current.phrase && (key !== 'phrase' || bang.phrase !== input.value)) : []
      filtered.push({ phrase: bangInput.value, snippet: snippetInput.value, redirect: redirectInput.value })
      settings.set('customBangs', filtered)
      current[key] = input.value
    })
  }

  bangInput.type = 'text'
  snippetInput.type = 'text'
  redirectInput.type = 'text'
  bangInput.value = bang ?? ''
  snippetInput.value = snippet ?? ''
  redirectInput.value = redirect ?? ''
  xButton.className = 'i carbon:close custom-bang-delete-button'

  bangInput.placeholder = l('settingsCustomBangsPhrase')
  snippetInput.placeholder = l('settingsCustomBangsSnippet')
  redirectInput.placeholder = l('settingsCustomBangsRedirect')
  xButton.addEventListener('click', function () {
    li.remove()
    settings.get('customBangs', (d) => {
      settings.set('customBangs', d.filter((bang) => bang.phrase !== bangInput.value))
    })
    showRestartRequiredBanner()
  })

  bangInput.addEventListener('change', function () {
    if (this.value.startsWith('!')) {
      this.value = this.value.slice(1)
    }
    update('phrase', bangInput)
    showRestartRequiredBanner()
  })
  snippetInput.addEventListener('change', function () {
    update('snippet', snippetInput)
    showRestartRequiredBanner()
  })
  redirectInput.addEventListener('change', function () {
    update('redirect', redirectInput)
    showRestartRequiredBanner()
  })

  li.appendChild(bangInput)
  li.appendChild(snippetInput)
  li.appendChild(redirectInput)
  li.appendChild(xButton)

  return li
}

/* site permissions */

var sitePermissionsEmpty = document.getElementById('site-permissions-empty')
var sitePermissionsList = document.getElementById('site-permissions-list')

function getPermissionLabel (permKey) {
  if (permKey === 'notifications') {
    return l('settingsPermissionNotifications') || 'Notifications'
  }
  if (permKey === 'media:audio') {
    return l('settingsPermissionMicrophone') || 'Microphone'
  }
  if (permKey === 'media:video') {
    return l('settingsPermissionCamera') || 'Camera'
  }
  if (permKey === 'pointerLock') {
    return l('settingsPermissionPointerLock') || 'Pointer Lock'
  }
  return permKey
}

function renderSitePermissions (permissionsData) {
  if (!sitePermissionsList) {
    return
  }

  while (sitePermissionsList.firstChild) {
    sitePermissionsList.removeChild(sitePermissionsList.firstChild)
  }

  var sitePermissions = permissionsData || {}
  var origins = Object.keys(sitePermissions).filter(origin => {
    return Object.keys(sitePermissions[origin] || {}).length > 0
  }).sort()

  if (origins.length === 0) {
    if (sitePermissionsEmpty) {
      sitePermissionsEmpty.hidden = false
    }
    return
  }

  if (sitePermissionsEmpty) {
    sitePermissionsEmpty.hidden = true
  }

  origins.forEach(function (origin) {
    var perms = sitePermissions[origin]
    var permKeys = Object.keys(perms)

    var item = document.createElement('div')
    item.className = 'site-permission-item'

    var originTitle = document.createElement('div')
    originTitle.className = 'site-permission-origin'
    originTitle.textContent = origin

    var entriesContainer = document.createElement('div')
    entriesContainer.className = 'site-permission-entries'

    permKeys.forEach(function (key) {
      var entry = document.createElement('div')
      entry.className = 'site-permission-entry'

      var label = document.createElement('span')
      label.className = 'site-permission-type'
      label.textContent = getPermissionLabel(key)

      var select = document.createElement('select')
      select.className = 'site-permission-state'

      var allowOpt = document.createElement('option')
      allowOpt.value = 'allow'
      allowOpt.textContent = l('settingsPermissionAllow') || 'Allowed'
      if (perms[key] === 'allow') {
        allowOpt.selected = true
      }

      var blockOpt = document.createElement('option')
      blockOpt.value = 'block'
      blockOpt.textContent = l('settingsPermissionBlock') || 'Blocked'
      if (perms[key] === 'block') {
        blockOpt.selected = true
      }

      var askOpt = document.createElement('option')
      askOpt.value = 'ask'
      askOpt.textContent = l('settingsPermissionAsk') || 'Ask (default)'

      select.appendChild(allowOpt)
      select.appendChild(blockOpt)
      select.appendChild(askOpt)

      select.addEventListener('change', function () {
        settings.get('sitePermissions', function (current) {
          var updated = Object.assign({}, current || {})
          if (select.value === 'ask') {
            if (updated[origin]) {
              delete updated[origin][key]
              if (Object.keys(updated[origin]).length === 0) {
                delete updated[origin]
                item.remove()
              } else {
                entry.remove()
              }
            }
          } else {
            if (!updated[origin]) {
              updated[origin] = {}
            }
            updated[origin][key] = select.value
          }
          settings.set('sitePermissions', updated)

          var remaining = Object.keys(updated).filter(k => Object.keys(updated[k] || {}).length > 0)
          if (remaining.length === 0 && sitePermissionsEmpty) {
            sitePermissionsEmpty.hidden = false
          }
        })
      })

      entry.appendChild(label)
      entry.appendChild(select)
      entriesContainer.appendChild(entry)
    })

    var deleteBtn = document.createElement('button')
    deleteBtn.className = 'i carbon:trash-can site-permission-delete-button'
    deleteBtn.title = l('settingsPermissionDelete') || 'Reset permissions'
    deleteBtn.addEventListener('click', function () {
      settings.get('sitePermissions', function (current) {
        var updated = Object.assign({}, current || {})
        delete updated[origin]
        settings.set('sitePermissions', updated)
        item.remove()

        var remaining = Object.keys(updated).filter(k => Object.keys(updated[k] || {}).length > 0)
        if (remaining.length === 0 && sitePermissionsEmpty) {
          sitePermissionsEmpty.hidden = false
        }
      })
    })

    item.appendChild(originTitle)
    item.appendChild(entriesContainer)
    item.appendChild(deleteBtn)
    sitePermissionsList.appendChild(item)
  })
}

settings.get('sitePermissions', function (sitePermissions) {
  renderSitePermissions(sitePermissions)
})

settings.listen('sitePermissions', function (sitePermissions) {
  renderSitePermissions(sitePermissions)
})
