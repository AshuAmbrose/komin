/* Shows what a user script can do before it's installed or updated (main/userscriptInstall.js opens this page for .user.js files).
   ?url= is the script to install; ?id= is set when reviewing an update of an installed script. */

var params = new URLSearchParams(window.location.search)
var scriptURL = params.get('url')
var updateId = params.get('id')

var statusEl = document.getElementById('status')
var detailsEl = document.getElementById('details')
var installButton = document.getElementById('install-button')
var cancelButton = document.getElementById('cancel-button')

document.title = l('userscriptInstallHeading')

function addListItem (list, text, className) {
  var item = document.createElement('li')
  item.textContent = text
  if (className) {
    item.className = className
  }
  list.appendChild(item)
  return item
}

function addPermission (title, values, warning) {
  if (values.length === 0) {
    return
  }
  var list = document.getElementById('permissions')
  var dt = document.createElement('dt')
  dt.textContent = title
  list.appendChild(dt)
  values.forEach(function (value) {
    var dd = document.createElement('dd')
    dd.textContent = value
    if (warning) {
      dd.className = 'warning'
    }
    list.appendChild(dd)
  })
}

function showInfo (info) {
  var script = info.script
  var existing = info.existing
  var isUpdate = existing && existing.comparison > 0

  document.getElementById('heading').textContent = l(isUpdate ? 'userscriptUpdateHeading' : 'userscriptInstallHeading')
  document.title = script.name
  document.getElementById('script-name').textContent = script.name

  var meta = []
  if (script.version) {
    meta.push(script.version)
  }
  if (script.author) {
    meta.push(l('userscriptInstallBy').replace('%s', script.author))
  }
  meta.push(l('userscriptInstallFrom').replace('%s', userscriptPages.describeHost(info.url)))
  if (existing && existing.version) {
    meta.push(l('userscriptUpdateFrom').replace('%v', existing.version))
  }
  document.getElementById('script-meta').textContent = meta.join(' · ')
  document.getElementById('script-description').textContent = script.description

  if (script.icon) {
    var icon = document.getElementById('script-icon')
    icon.src = script.icon
    icon.hidden = false
    icon.addEventListener('error', function () {
      icon.hidden = true
    })
  }

  /* warnings */
  var warnings = document.getElementById('warnings')
  var connectsAnywhere = script.grants.includes('xmlhttpRequest') && script.connects.includes('*')
  if (!info.userscriptsEnabled) {
    addListItem(warnings, l('userscriptWarningDisabled'), 'info')
  }
  if (existing && existing.comparison < 0) {
    addListItem(warnings, l('userscriptWarningOlder').replace('%v', existing.version))
  } else if (existing && existing.comparison === 0) {
    addListItem(warnings, l('userscriptWarningSameVersion'), 'info')
  }
  if (existing && existing.edited) {
    addListItem(warnings, l('userscriptWarningEdited'))
  }
  if (existing && existing.increase) {
    var increase = existing.increase
    var added = increase.sites.map(site => site === '*' ? l('userscriptInstallEverywhere') : userscriptPages.describeSite(site))
      .concat(increase.connects.map(host => host === '*' ? l('userscriptInstallConnectsAnywhere') : host))
      .concat(userscriptPages.describeGrants(increase.grants).map(l))
    if (added.length > 0) {
      var item = addListItem(warnings, l('userscriptWarningNewPermissions'))
      var addedList = document.createElement('ul')
      added.forEach(text => addListItem(addedList, text))
      item.appendChild(addedList)
    }
  }
  if (script.runsEverywhere) {
    addListItem(warnings, l('userscriptWarningEverywhere'))
  }
  if (connectsAnywhere) {
    addListItem(warnings, l('userscriptWarningConnectAnywhere'))
  }
  addListItem(warnings, l('userscriptWarningTrust'), 'info')

  /* what it can do */
  addPermission(l('userscriptInstallRunsOn'), script.runsEverywhere ? [l('userscriptInstallEverywhere')] : script.sites.map(userscriptPages.describeSite), script.runsEverywhere)
  addPermission(l('userscriptInstallExcept'), script.excludes.map(userscriptPages.describeSite))
  if (script.grants.includes('xmlhttpRequest') || script.grants.includes('download')) {
    var connects = connectsAnywhere
      ? [l('userscriptInstallConnectsAnywhere')]
      : [l('userscriptInstallConnectsPage')].concat(script.connects.filter(host => host !== 'self'))
    addPermission(l('userscriptInstallConnects'), connects, connectsAnywhere)
  }
  addPermission(l('userscriptInstallCan'), userscriptPages.describeGrants(script.grants).filter(id => id !== 'userscriptGrantRequests').map(l))
  var downloadHosts = script.requires.concat(script.resources.map(resource => resource.url)).map(userscriptPages.describeHost)
  addPermission(l('userscriptInstallDownloads'), downloadHosts.filter((host, i) => downloadHosts.indexOf(host) === i))
  var antifeatureLabels = { ads: 'userscriptAntifeatureAds', tracking: 'userscriptAntifeatureTracking', miner: 'userscriptAntifeatureMiner' }
  addPermission(l('userscriptInstallAntifeatures'), script.antifeatures.map(type => antifeatureLabels[type] ? l(antifeatureLabels[type]) : type), true)

  document.getElementById('code').textContent = info.content

  if (isUpdate) {
    installButton.textContent = l('userscriptUpdateButton')
  } else if (existing && existing.comparison === 0) {
    installButton.textContent = l('userscriptReinstallButton')
  } else {
    installButton.textContent = l('userscriptInstallButton')
  }

  statusEl.hidden = true
  detailsEl.hidden = false
  installButton.focus()

  installButton.addEventListener('click', function () {
    installButton.disabled = true
    cancelButton.disabled = true
    statusEl.textContent = l('userscriptInstalling')
    statusEl.hidden = false
    userscriptPages.request('install', { url: info.url, id: existing ? existing.id : updateId }).then(function () {
      statusEl.textContent = l('userscriptInstalled')
      installButton.hidden = true
      cancelButton.textContent = l('userscriptDoneButton')
      cancelButton.disabled = false
      cancelButton.focus()
    }, function (e) {
      statusEl.textContent = e.message
      installButton.disabled = false
      cancelButton.disabled = false
    })
  })
}

cancelButton.addEventListener('click', function () {
  userscriptPages.request('leave')
})

if (scriptURL) {
  userscriptPages.request('install-info', { url: scriptURL, id: updateId }).then(showInfo, function (e) {
    statusEl.textContent = l('userscriptInstallLoadError').replace('%s', e.message)
  })
} else {
  statusEl.textContent = l('userscriptInstallLoadError').replace('%s', 'no script')
}
