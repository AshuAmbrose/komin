/* Installing userscripts, their @require/@resource files, updates, and the pages that manage them.
   - Opening a .user.js file in a tab (js/preload/userscripts.js notices it) shows pages/userscriptInstall, which lists what the script can do before it's installed.
   - @require and @resource files are downloaded into userscriptData/cache when a script is installed or updated, or when it's first loaded.
   - Scripts installed from the web are checked for updates once a day. An update is installed automatically unless it adds sites, @connect domains
     or Greasemonkey functions, or the script was edited here; then it waits for approval in Settings.
   Install sources and on/off state are in scripts.json (getUserscriptRegistry in main/userscripts.js). */

const userscriptCacheDir = path.join(userscriptDataDir, 'cache')
const userscriptInstallPage = 'min://app/pages/userscriptInstall/index.html'
const USERSCRIPT_MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024
const USERSCRIPT_FIRST_UPDATE_CHECK_DELAY = 10 * 60 * 1000
const USERSCRIPT_UPDATE_INTERVAL = 24 * 60 * 60 * 1000
const userscriptCrypto = require('crypto')

const failedUserscriptDownloads = new Map() // URL: error message, so a broken @require isn't retried on every reload
const pendingUserscriptInstalls = new Map() // URL: {content, expires}, the exact file the install page showed
let userscriptDependencyDownload = null
let userscriptUpdateTimer = null
let userscriptUpdateCheck = null

function hashUserscriptText (text) {
  return userscriptCrypto.createHash('sha256').update(text).digest('hex')
}

function getUserscriptCachePath (url) {
  return path.join(userscriptCacheDir, hashUserscriptText(url))
}

function readUserscriptDependency (url) {
  const file = getUserscriptCachePath(url)
  let contentType = ''
  try {
    contentType = fs.readFileSync(file + '.type', 'utf-8')
  } catch (e) {}
  return { data: fs.readFileSync(file), contentType }
}

function getMissingUserscriptDependencies (script) {
  return script.requires.concat(script.resources.map(resource => resource.url)).filter(url => !fs.existsSync(getUserscriptCachePath(url)))
}

// a script file or one of its downloads, with the cookies of normal tabs
async function fetchUserscriptFile (url, allowFile) {
  const parsed = new URL(url)
  if (parsed.protocol === 'file:' && allowFile) {
    return { data: await fs.promises.readFile(require('url').fileURLToPath(parsed)), contentType: '' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https downloads are supported: ' + url)
  }
  const response = await session.fromPartition('persist:webcontent').fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(30 * 1000) })
  if (!response.ok) {
    throw new Error('Download failed (' + response.status + '): ' + url)
  }
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > USERSCRIPT_MAX_DOWNLOAD_SIZE) {
    throw new Error('File too large: ' + url)
  }
  return { data, contentType: response.headers.get('content-type') || '' }
}

// "@require https://example.com/lib.js#sha256=..." (or md5, sha1, sha384, sha512, as hex or base64; several separated by commas)
function checkUserscriptIntegrity (url, data) {
  const hash = new URL(url).hash.slice(1)
  hash.split(/[,;]/).forEach(function (part) {
    const parts = part.trim().match(/^(md5|sha1|sha256|sha384|sha512)[=-](.+)$/i)
    if (!parts) {
      return
    }
    const digest = userscriptCrypto.createHash(parts[1].toLowerCase()).update(data).digest()
    if (parts[2].toLowerCase() !== digest.toString('hex') && parts[2] !== digest.toString('base64')) {
      throw new Error('Integrity check failed: ' + url)
    }
  })
}

async function downloadUserscriptDependency (url) {
  const file = await fetchUserscriptFile(url, false)
  checkUserscriptIntegrity(url, file.data)
  const cachePath = getUserscriptCachePath(url)
  await fs.promises.mkdir(userscriptCacheDir, { recursive: true })
  await fs.promises.writeFile(cachePath + '.type', file.contentType)
  await fs.promises.writeFile(cachePath + '.tmp', file.data)
  await fs.promises.rename(cachePath + '.tmp', cachePath)
  failedUserscriptDownloads.delete(url)
}

function downloadMissingUserscriptDependencies () {
  if (userscriptDependencyDownload) {
    return
  }
  const urls = Array.from(new Set(loadedUserscripts.flatMap(script => script.missing))).filter(url => !failedUserscriptDownloads.has(url))
  if (urls.length === 0) {
    return
  }
  userscriptDependencyDownload = Promise.all(urls.map(function (url) {
    return downloadUserscriptDependency(url).catch(function (e) {
      console.warn('failed to download userscript file', e)
      failedUserscriptDownloads.set(url, e.message)
    })
  })).then(function () {
    userscriptDependencyDownload = null
    if (userscriptsEnabled) {
      loadUserscripts()
    }
  })
}

function findInstalledUserscript (script) {
  return getKnownUserscripts().find(installed => !installed.legacy && installed.name === script.name && installed.namespace === script.namespace)
}

function getNewUserscriptFileName (name) {
  let base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'script' // eslint-disable-line no-control-regex
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) {
    base += ' script'
  }
  let fileName = base + '.user.js'
  for (let i = 2; fs.existsSync(path.join(userscriptDir, fileName)); i++) {
    fileName = base + ' (' + i + ').user.js'
  }
  return fileName
}

function compileUserscriptForInstall (content) {
  const script = compileUserscript('install.user.js', content, app.getLocale())
  if (!script || script.legacy) {
    throw new Error('This file isn\'t a user script: it has no "==UserScript==" block.')
  }
  return script
}

// id: the file to replace (an update); otherwise a script with the same @name and @namespace is replaced, or a new file created
async function installUserscript (content, sourceURL, id) {
  const script = compileUserscriptForInstall(content)
  await Promise.all(script.requires.concat(script.resources.map(resource => resource.url)).map(downloadUserscriptDependency))

  if (!id || !getKnownUserscripts().some(installed => installed.id === id)) {
    const existing = findInstalledUserscript(script)
    id = existing ? existing.id : getNewUserscriptFileName(script.name)
  }
  writeUserscriptFile(path.join(userscriptDir, id), content)

  const registry = getUserscriptRegistry()
  const entry = registry[id] || {}
  registry[id] = Object.assign(entry, {
    enabled: entry.enabled !== false,
    sourceURL: sourceURL || entry.sourceURL,
    installedAt: entry.installedAt || Date.now(),
    updatedAt: Date.now(),
    lastUpdateCheck: Date.now(),
    hash: hashUserscriptText(content)
  })
  delete entry.pendingUpdate
  delete entry.updateError
  saveUserscriptRegistry()

  if (settings.get('userscriptsEnabled') === true) {
    loadUserscripts()
  } else {
    settings.set('userscriptsEnabled', true)
  }
  return id
}

function describeUserscriptForPage (script) {
  const webURL = url => /^https?:/i.test(url) ? url : ''
  return {
    id: script.id,
    name: script.name,
    namespace: script.namespace,
    version: script.version,
    description: script.description,
    author: script.author,
    homepage: webURL(script.homepage),
    icon: /^(https?|data):/i.test(script.icon) ? script.icon : '',
    runsEverywhere: userscriptRunsEverywhere(script.rules),
    sites: (script.rules.match || []).concat(script.rules.include || []),
    excludes: (script.rules.exclude || []).concat(script.rules.excludeMatch || []),
    connects: script.connects,
    grants: script.grants,
    requires: script.requires,
    resources: script.resources,
    antifeatures: script.antifeatures,
    runAt: script.runAt,
    legacy: script.legacy
  }
}

async function getUserscriptInstallInfo (url, id) {
  const file = await fetchUserscriptFile(url, true)
  const content = file.data.toString('utf-8')
  const script = compileUserscriptForInstall(content)
  pendingUserscriptInstalls.set(url, { content, expires: Date.now() + 60 * 60 * 1000 })

  let existing = id && getKnownUserscripts().find(installed => installed.id === id)
  existing = existing || findInstalledUserscript(script)
  let existingInfo = null
  if (existing) {
    const registryEntry = getUserscriptRegistry()[existing.id]
    existingInfo = {
      id: existing.id,
      version: existing.version,
      comparison: compareUserscriptVersions(script.version, existing.version),
      increase: existing.legacy ? null : getUserscriptPermissionIncrease(existing, script),
      edited: !registryEntry || !registryEntry.hash || registryEntry.hash !== hashUserscriptText(existing.content)
    }
  }
  return {
    url,
    content,
    script: describeUserscriptForPage(script),
    userscriptsEnabled: settings.get('userscriptsEnabled') === true,
    existing: existingInfo
  }
}

function getUserscriptManagementList () {
  const registry = getUserscriptRegistry()
  return {
    enabled: settings.get('userscriptsEnabled') === true,
    scripts: loadedUserscripts.map(function (script) {
      const entry = registry[script.id] || {}
      const failed = script.missing.filter(url => failedUserscriptDownloads.has(url))
      return Object.assign(describeUserscriptForPage(script), {
        enabled: script.enabled,
        sourceURL: entry.sourceURL || '',
        updatedAt: entry.updatedAt || null,
        pendingUpdate: entry.pendingUpdate || null,
        updateError: entry.updateError || '',
        downloading: script.missing.length > failed.length,
        downloadError: failed.length > 0 ? failedUserscriptDownloads.get(failed[0]) : ''
      })
    })
  }
}

function getInstalledUserscript (id) {
  const script = loadedUserscripts.find(script => script.id === id)
  if (!script || path.basename(id) !== id) {
    throw new Error('Unknown script: ' + id)
  }
  return script
}

// opens a script in a text editor. Not shell.openPath: on Windows that would run the .js file with Windows Script Host.
function editUserscript (id) {
  const file = path.join(userscriptDir, getInstalledUserscript(id).id)
  if (process.platform === 'win32') {
    execFile('notepad.exe', [file], function () {})
  } else if (process.platform === 'darwin') {
    execFile('open', ['-t', file], function () {})
  } else {
    shell.openPath(file)
  }
}

function createUserscript () {
  const id = getNewUserscriptFileName('New script')
  writeUserscriptFile(path.join(userscriptDir, id), [
    '// ==UserScript==',
    '// @name        ' + id.replace(/\.user\.js$/, ''),
    '// @namespace   min',
    '// @version     1.0',
    '// @description What this script does',
    '// @match       https://example.com/*',
    '// @grant       none',
    '// ==/UserScript==',
    '',
    '(function () {',
    "  'use strict'",
    '',
    '  // your code here',
    '})()',
    ''
  ].join('\n'))
  getUserscriptRegistry()[id] = { enabled: true, updatedAt: Date.now() }
  saveUserscriptRegistry()
  loadUserscripts()
  editUserscript(id)
  return id
}

async function removeUserscript (id) {
  const script = getInstalledUserscript(id)
  await shell.trashItem(path.join(userscriptDir, script.id))
  delete getUserscriptRegistry()[script.id]
  saveUserscriptRegistry()
  deleteUserscriptValues(script.id)
  loadUserscripts()
}

function setUserscriptEnabled (id, enabled) {
  const script = getInstalledUserscript(id)
  const registry = getUserscriptRegistry()
  registry[script.id] = Object.assign(registry[script.id] || {}, { enabled: !!enabled })
  saveUserscriptRegistry()
  loadUserscripts()
}

async function checkUserscriptForUpdate (script, entry) {
  const downloadURL = script.downloadURL || entry.sourceURL
  const updateURL = script.updateURL || downloadURL
  if (downloadURL === 'none' || updateURL === 'none') {
    return
  }

  let content = (await fetchUserscriptFile(updateURL, false)).data.toString('utf-8')
  let update = compileUserscript(script.id, content, app.getLocale())
  if (!update || compareUserscriptVersions(update.version, script.version) <= 0) {
    delete entry.pendingUpdate
    return
  }
  // @updateURL is often a .meta.js file with only the metadata
  if (updateURL !== downloadURL) {
    content = (await fetchUserscriptFile(downloadURL, false)).data.toString('utf-8')
    update = compileUserscriptForInstall(content)
    if (compareUserscriptVersions(update.version, script.version) <= 0) {
      return
    }
  }

  const edited = !entry.hash || hashUserscriptText(script.content) !== entry.hash
  if (edited || userscriptPermissionsIncreased(getUserscriptPermissionIncrease(script, update))) {
    entry.pendingUpdate = { version: update.version, url: downloadURL, reason: edited ? 'edited' : 'permissions' }
  } else {
    await installUserscript(content, entry.sourceURL, script.id)
  }
}

async function runUserscriptUpdateCheck (force) {
  const registry = getUserscriptRegistry()
  for (const script of loadedUserscripts.slice()) {
    const entry = registry[script.id]
    if (script.legacy || !entry || !entry.sourceURL || (!force && entry.lastUpdateCheck > Date.now() - USERSCRIPT_UPDATE_INTERVAL)) {
      continue
    }
    entry.lastUpdateCheck = Date.now()
    try {
      await checkUserscriptForUpdate(script, entry)
      delete entry.updateError
    } catch (e) {
      console.warn('userscript update check failed for ' + script.id, e)
      entry.updateError = e.message
    }
  }
  saveUserscriptRegistry()
  notifyUserscriptPages()
}

function checkForUserscriptUpdates (force) {
  if (!userscriptUpdateCheck) {
    userscriptUpdateCheck = runUserscriptUpdateCheck(force).finally(function () {
      userscriptUpdateCheck = null
    })
  }
  return userscriptUpdateCheck
}

function scheduleUserscriptUpdateCheck (delay) {
  clearTimeout(userscriptUpdateTimer)
  userscriptUpdateTimer = setTimeout(function () {
    checkForUserscriptUpdates(false).finally(function () {
      if (userscriptsEnabled) {
        scheduleUserscriptUpdateCheck(USERSCRIPT_UPDATE_INTERVAL)
      }
    })
  }, delay)
}

function stopUserscriptUpdateChecks () {
  clearTimeout(userscriptUpdateTimer)
}

/* Opening a .user.js file in a tab shows the install page instead.
   - http(s): download.js's response hook calls this when the response isn't HTML, before the file is shown.
     (The page can't tell us itself: raw.githubusercontent.com, for one, sends a sandbox CSP that turns off the preload.)
   - file: the preload asks once the file is showing (contentTypes is null), and the file's entry is then removed from the tab's history,
     so "back" doesn't open the install page again.
   Returns whether the install page is being opened. */
function promptUserscriptInstall (contents, url, contentTypes) {
  if (!contents || contents.isDestroyed() || !getTabIDFromWebContents(contents)) {
    return false
  }
  try {
    if (!/\.user\.js$/i.test(new URL(url).pathname)) {
      return false
    }
  } catch (e) {
    return false
  }
  if (contentTypes && contentTypes.some(type => type.includes('text/html'))) {
    return false
  }
  const installURL = userscriptInstallPage + '?url=' + encodeURIComponent(url)
  // not loadURL's promise: it rejects when the file's own load is cut short, which is what happens here
  const removeRawFileEntry = function () {
    if (contents.isDestroyed() || contents.getURL() !== installURL) {
      return
    }
    contents.removeListener('did-finish-load', removeRawFileEntry)
    const history = contents.navigationHistory
    const index = history.getActiveIndex() - 1
    if (index >= 0 && history.getEntryAtIndex(index).url === url) {
      history.removeEntryAtIndex(index)
    }
  }
  contents.on('did-finish-load', removeRawFileEntry)
  setTimeout(() => contents.removeListener('did-finish-load', removeRawFileEntry), 30 * 1000)
  setImmediate(function () {
    if (!contents.isDestroyed()) {
      contents.loadURL(installURL).catch(function () {})
    }
  })
  return true
}

ipc.on('userscripts-install-prompt', function (event) {
  const frame = event.senderFrame
  if (frame && !frame.parent && frame.url.startsWith('file:')) {
    promptUserscriptInstall(event.sender, frame.url, null)
  }
})

/* The install page and the list in Settings talk to this through the preload (js/preload/userscripts.js), as {action, args} */

const userscriptManagementPages = ['min://app/pages/settings/', 'min://app/pages/userscriptInstall/']

function notifyUserscriptPages () {
  Object.values(viewMap).forEach(function (view) {
    if (!view.webContents.isDestroyed() && userscriptManagementPages.some(page => view.webContents.getURL().startsWith(page))) {
      view.webContents.send('userscripts-page-changed')
    }
  })
}

const userscriptPageActions = {
  list: () => getUserscriptManagementList(),
  'install-info': args => getUserscriptInstallInfo(args.url, args.id),
  install: function (args, event) {
    const pending = pendingUserscriptInstalls.get(args.url)
    if (!pending || pending.expires < Date.now()) {
      throw new Error('The script changed, reload this page to review it again.')
    }
    pendingUserscriptInstalls.delete(args.url)
    return installUserscript(pending.content, /^https?:/i.test(args.url) ? args.url : '', args.id)
  },
  'set-enabled': args => setUserscriptEnabled(args.id, args.enabled),
  remove: args => removeUserscript(args.id),
  edit: args => editUserscript(args.id),
  create: () => createUserscript(),
  'show-folder': function () {
    fs.mkdirSync(userscriptDir, { recursive: true })
    return shell.openPath(userscriptDir)
  },
  'check-updates': () => checkForUserscriptUpdates(true).then(getUserscriptManagementList),
  leave: function (args, event) {
    // not goBack(): it skips pages that navigated away without a click, which can be the page that linked to the script
    const history = event.sender.navigationHistory
    if (history.getActiveIndex() > 0) {
      history.goToIndex(history.getActiveIndex() - 1)
    } else {
      const win = getWindowFromViewContents(event.sender) || windows.getCurrent()
      getWindowWebContents(win).send('view-ipc', { id: getTabIDFromWebContents(event.sender), name: 'close-window', data: [] })
    }
  }
}

ipc.handle('userscripts-page', function (event, request) {
  const frame = event.senderFrame
  if (!frame || frame.parent || !userscriptManagementPages.some(page => frame.url.startsWith(page))) {
    throw new Error('Not allowed')
  }
  const action = request && userscriptPageActions[request.action]
  if (!action) {
    throw new Error('Unknown action')
  }
  return action(request.args || {}, event)
})
