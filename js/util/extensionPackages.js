/* Chrome extension packages: reading .crx files (CRX3), checking their signature, unpacking their zip, and describing
   what an extension asks for. Concatenated into main.build.js (used by main/extensions.js) and unit-tested in
   test/extensionPackages.test.js. No dependencies beyond Node's zlib and crypto. */

const extensionZlib = require('zlib')
const extensionCrypto = require('crypto')

// minimal protobuf reader: {fieldNumber: [values]}, where length-delimited values are Buffers
function readExtensionProtobuf (buffer) {
  const fields = {}
  let offset = 0
  function readVarint () {
    let result = 0
    let shift = 0
    while (true) {
      if (offset >= buffer.length) {
        throw new Error('truncated protobuf')
      }
      const byte = buffer[offset++]
      result += (byte & 0x7f) * Math.pow(2, shift)
      if (!(byte & 0x80)) {
        return result
      }
      shift += 7
    }
  }
  while (offset < buffer.length) {
    const tag = readVarint()
    const field = Math.floor(tag / 8)
    const wireType = tag & 7
    let value
    if (wireType === 0) {
      value = readVarint()
    } else if (wireType === 2) {
      const length = readVarint()
      if (offset + length > buffer.length) {
        throw new Error('truncated protobuf')
      }
      value = buffer.subarray(offset, offset + length)
      offset += length
    } else if (wireType === 1) {
      offset += 8
      continue
    } else if (wireType === 5) {
      offset += 4
      continue
    } else {
      throw new Error('unsupported protobuf wire type ' + wireType)
    }
    if (!fields[field]) {
      fields[field] = []
    }
    fields[field].push(value)
  }
  return fields
}

// Chrome extension ids are the first 16 bytes of a hash, written with the letters a-p instead of hex digits
function extensionIdFromBytes (bytes) {
  return Array.from(bytes.subarray(0, 16).toString('hex')).map(c => String.fromCharCode(97 + parseInt(c, 16))).join('')
}

function extensionIdFromPublicKey (publicKey) {
  return extensionIdFromBytes(extensionCrypto.createHash('sha256').update(publicKey).digest())
}

// SHA-256 of the Chrome Web Store's publisher key (Chromium's kPublisherKeyHash): every file the store serves is signed with it
const EXTENSION_WEBSTORE_KEY_HASH = '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf'
const EXTENSION_WEBSTORE_UPDATE_URL = 'https://clients2.google.com/service/update2/crx'

/*
Reads a CRX3 file: "Cr24", version 3, the header length, a protobuf header (key proofs and the extension id), then a zip.
Each signature covers the header's signed data and the zip, so a changed file fails the check. Every signature must
verify (as in Chrome), and one must be the developer's: the key whose hash is the extension id.
Returns {id, publicKey, zip, fromWebStore}; throws if the file isn't a valid, correctly signed CRX3.
*/
function parseCrx (data) {
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'Cr24') {
    throw new Error('Not a Chrome extension file (.crx)')
  }
  if (data.readUInt32LE(4) !== 3) {
    throw new Error('Unsupported .crx version ' + data.readUInt32LE(4) + ' (only CRX3 is supported)')
  }
  const headerLength = data.readUInt32LE(8)
  if (12 + headerLength > data.length) {
    throw new Error('The .crx file is truncated')
  }
  const header = readExtensionProtobuf(data.subarray(12, 12 + headerLength))
  const zip = data.subarray(12 + headerLength)
  const signedHeaderData = header[10000] && header[10000][0]
  if (!signedHeaderData) {
    throw new Error('The .crx file has no signed header')
  }
  const crxId = (readExtensionProtobuf(signedHeaderData)[1] || [])[0]
  if (!crxId || crxId.length !== 16) {
    throw new Error('The .crx file has no extension id')
  }
  const id = extensionIdFromBytes(crxId)

  // what the signatures cover
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32LE(signedHeaderData.length)
  const signedContent = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), lengthBytes, signedHeaderData, zip])

  // RSA (field 2) and ECDSA (field 3) proofs, both SHA-256
  let publicKey = null
  const keyHashes = []
  for (const proof of (header[2] || []).concat(header[3] || [])) {
    const fields = readExtensionProtobuf(proof)
    const key = fields[1] && fields[1][0]
    const signature = fields[2] && fields[2][0]
    if (!key || !signature) {
      throw new Error('The .crx file has an incomplete signature')
    }
    if (!extensionCrypto.verify('sha256', signedContent, extensionCrypto.createPublicKey({ key, format: 'der', type: 'spki' }), signature)) {
      throw new Error('The .crx file\'s signature doesn\'t match its contents')
    }
    keyHashes.push(extensionCrypto.createHash('sha256').update(key).digest('hex'))
    if (extensionIdFromPublicKey(key) === id) {
      publicKey = key
    }
  }
  if (!publicKey) {
    throw new Error('The .crx file isn\'t signed by its developer key')
  }
  return { id, publicKey, zip, fromWebStore: keyHashes.includes(EXTENSION_WEBSTORE_KEY_HASH) }
}

// -1, 0 or 1; extension versions are one to four dot-separated numbers
function compareExtensionVersions (a, b) {
  const partsA = String(a || '0').split('.').map(n => parseInt(n, 10) || 0)
  const partsB = String(b || '0').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    if ((partsA[i] || 0) !== (partsB[i] || 0)) {
      return (partsA[i] || 0) > (partsB[i] || 0) ? 1 : -1
    }
  }
  return 0
}

// the address that answers whether these extensions ({id, version}) have updates; Chrome's update protocol (gupdate)
function getExtensionUpdateCheckURL (updateURL, extensions, chromeVersion) {
  return updateURL + (updateURL.includes('?') ? '&' : '?') + 'response=updatecheck&acceptformat=crx3&prodversion=' + encodeURIComponent(chromeVersion) +
    extensions.map(extension => '&x=' + encodeURIComponent('id=' + extension.id + '&v=' + extension.version + '&uc')).join('')
}

// the address of an extension's current .crx in the Chrome Web Store
function getWebStoreDownloadURL (id, chromeVersion) {
  return EXTENSION_WEBSTORE_UPDATE_URL + '?response=redirect&acceptformat=crx3&prodversion=' + encodeURIComponent(chromeVersion) +
    '&x=' + encodeURIComponent('id=' + id + '&installsource=ondemand&uc')
}

// an update check's XML answer: {id: {status ('ok' when there's an update, else 'noupdate' or an error), version, codebase, hashSha256}}
function parseExtensionUpdateResponse (xml) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }
  function readAttributes (text) {
    const attributes = {}
    for (const match of text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes[match[1]] = (match[2] !== undefined ? match[2] : match[3]).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, function (entity, name) {
        if (name[0] === '#') {
          return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10))
        }
        return entities[name] !== undefined ? entities[name] : entity
      })
    }
    return attributes
  }
  const result = {}
  for (const app of String(xml).matchAll(/<app\b([^>]*)>([\s\S]*?)<\/app>/g)) {
    const appAttributes = readAttributes(app[1])
    const check = app[2].match(/<updatecheck\b([^>]*?)\/?>/)
    if (!appAttributes.appid || !check) {
      continue
    }
    const attributes = readAttributes(check[1])
    result[appAttributes.appid] = {
      status: attributes.status || appAttributes.status || '',
      version: attributes.version || '',
      codebase: attributes.codebase || '',
      hashSha256: (attributes.hash_sha256 || '').toLowerCase()
    }
  }
  return result
}

const EXTENSION_MAX_UNPACKED_SIZE = 512 * 1024 * 1024
const EXTENSION_MAX_ZIP_ENTRIES = 20000

// a zip entry's name as a safe relative path, or null for a name that would escape the folder
function safeExtensionZipPath (name) {
  const parts = name.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.')
  if (parts.length === 0 || parts.some(part => part === '..' || /^[a-zA-Z]:/.test(part)) || name.startsWith('/')) {
    return null
  }
  return parts.join('/')
}

// [{path, data}] for the files in a zip (stored or deflated entries; no zip64), with limits against zip bombs
function readExtensionZip (zip) {
  let end = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end === -1) {
    throw new Error('The extension\'s zip is damaged (no end record)')
  }
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  if (count > EXTENSION_MAX_ZIP_ENTRIES || offset === 0xffffffff) {
    throw new Error('The extension\'s zip is too large')
  }
  const files = []
  let total = 0
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('The extension\'s zip is damaged (bad directory entry)')
    }
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) {
      continue
    }
    const filePath = safeExtensionZipPath(name)
    if (!filePath) {
      throw new Error('The extension\'s zip has an unsafe file name: ' + name)
    }
    total += size
    if (total > EXTENSION_MAX_UNPACKED_SIZE) {
      throw new Error('The extension is too large')
    }
    if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('The extension\'s zip is damaged (bad file entry)')
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) {
      data = raw
    } else if (method === 8) {
      data = extensionZlib.inflateRawSync(raw, { maxOutputLength: size + 1 })
    } else {
      throw new Error('The extension\'s zip uses an unsupported compression method (' + method + ')')
    }
    if (data.length !== size) {
      throw new Error('The extension\'s zip is damaged (wrong size for ' + name + ')')
    }
    files.push({ path: filePath, data })
  }
  return files
}

// the manifest's name or description, resolving "__MSG_key__" from the extension's default locale messages
function getExtensionManifestText (manifest, field, messages) {
  const text = manifest[field] || ''
  const message = text.match(/^__MSG_(.+)__$/)
  if (!message) {
    return text
  }
  const key = Object.keys(messages || {}).find(k => k.toLowerCase() === message[1].toLowerCase())
  return key ? messages[key].message : text
}

// permissions that mean "can read and change every site"
const EXTENSION_ALL_SITES = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', 'file:///*']

/*
What an extension asks for, as message ids for the permission review (localized by the caller), most powerful first.
Unknown permissions are returned by name in "other".
*/
function describeExtensionPermissions (manifest) {
  const permissions = (manifest.permissions || []).filter(p => typeof p === 'string')
  const hosts = manifest.host_permissions || []
  const contentScriptHosts = (manifest.content_scripts || []).flatMap(script => script.matches || [])
  const allHosts = hosts.concat(contentScriptHosts)
  const result = { sites: [], allSites: allHosts.some(h => EXTENSION_ALL_SITES.includes(h)), items: [], other: [] }
  if (!result.allSites) {
    result.sites = Array.from(new Set(allHosts.map(h => h.replace(/^\*:\/\//, '').replace(/\/\*$/, ''))))
  }
  const labels = {
    debugger: 'extensionPermissionDebugger',
    webRequest: 'extensionPermissionNetwork',
    webRequestBlocking: 'extensionPermissionNetwork',
    declarativeNetRequest: 'extensionPermissionNetwork',
    declarativeNetRequestWithHostAccess: 'extensionPermissionNetwork',
    proxy: 'extensionPermissionNetwork',
    history: 'extensionPermissionHistory',
    tabs: 'extensionPermissionTabs',
    webNavigation: 'extensionPermissionTabs',
    bookmarks: 'extensionPermissionBookmarks',
    cookies: 'extensionPermissionCookies',
    clipboardRead: 'extensionPermissionClipboardRead',
    clipboardWrite: 'extensionPermissionClipboardWrite',
    downloads: 'extensionPermissionDownloads',
    notifications: 'extensionPermissionNotifications',
    nativeMessaging: 'extensionPermissionNativeMessaging',
    management: 'extensionPermissionManagement'
  }
  const quiet = ['storage', 'unlimitedStorage', 'alarms', 'activeTab', 'scripting', 'contextMenus', 'offscreen', 'idle', 'fontSettings', 'sidePanel', 'webRequestAuthProvider', 'userScripts', 'privacy', 'declarativeNetRequestFeedback']
  permissions.forEach(function (permission) {
    if (permission.includes('://') || permission === '<all_urls>') {
      return
    }
    if (labels[permission]) {
      if (!result.items.includes(labels[permission])) {
        result.items.push(labels[permission])
      }
    } else if (!quiet.includes(permission)) {
      result.other.push(permission)
    }
  })
  return result
}

// what a new version asks for that the installed one didn't, in describeExtensionPermissions' form, or null if nothing
function getExtensionPermissionIncrease (oldManifest, newManifest) {
  const before = describeExtensionPermissions(oldManifest)
  const after = describeExtensionPermissions(newManifest)
  const increase = {
    allSites: after.allSites && !before.allSites,
    sites: after.allSites || before.allSites ? [] : after.sites.filter(site => !before.sites.includes(site)),
    items: after.items.filter(item => !before.items.includes(item)),
    other: after.other.filter(permission => !before.other.includes(permission))
  }
  return increase.allSites || increase.sites.length || increase.items.length || increase.other.length ? increase : null
}

// Whether a host pattern an extension declared covers one it asks for: the same pattern, or a narrower one
// (chrome.permissions.request may only ask for what the manifest lists). "<all_urls>" covers everything, "*://*/*" every
// http and https site, "https://*.example.com/*" example.com and its subdomains on https.
function extensionHostPatternCovers (declared, requested) {
  if (typeof declared !== 'string' || typeof requested !== 'string') {
    return false
  }
  if (declared === requested || declared === '<all_urls>') {
    return true
  }
  const parse = pattern => /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)$/i.exec(pattern)
  const wide = parse(declared)
  const narrow = parse(requested)
  if (!wide || !narrow) {
    return false
  }
  const [wideScheme, wideHost, widePath] = [wide[1].toLowerCase(), wide[2].toLowerCase(), wide[3]]
  const [scheme, host, path] = [narrow[1].toLowerCase(), narrow[2].toLowerCase(), narrow[3]]
  if (wideScheme !== scheme && !(wideScheme === '*' && (scheme === 'http' || scheme === 'https'))) {
    return false
  }
  if (wideHost !== '*' && wideHost !== host) {
    if (!wideHost.startsWith('*.') || host === '*') {
      return false
    }
    const domain = wideHost.slice(2)
    const asked = host.startsWith('*.') ? host.slice(2) : host
    if (asked !== domain && !asked.endsWith('.' + domain)) {
      return false
    }
  }
  return widePath === '/*' || widePath === path
}

/*
A manifest command's suggested_key ("Alt+Shift+D", or {default, windows, mac, linux}) as a key combo for Min's
js/keybindings.js ("alt+shift+d"), or null if it isn't one Chrome would accept. Chrome's rules: Ctrl, Alt or (on a Mac)
Command must be part of it, Ctrl means Command on a Mac, and the key is a letter, a digit or one of a few named keys.
*/
function getExtensionShortcutCombo (suggestedKey, platform) {
  const platformName = { win32: 'windows', darwin: 'mac', linux: 'linux' }[platform]
  const text = typeof suggestedKey === 'string' ? suggestedKey : suggestedKey && (suggestedKey[platformName] || suggestedKey.default)
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  const parts = text.split('+').map(part => part.trim().toLowerCase())
  const key = parts.pop()
  const modifierNames = { ctrl: platform === 'darwin' ? 'super' : 'ctrl', command: 'super', macctrl: 'ctrl', alt: 'alt', shift: 'shift' }
  const modifiers = parts.map(part => modifierNames[part])
  if (modifiers.some(modifier => !modifier) || !modifiers.some(modifier => modifier !== 'shift')) {
    return null
  }
  const namedKeys = { comma: ',', period: '.', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', insert: 'insert', delete: 'delete', up: 'up', down: 'down', left: 'left', right: 'right' }
  const combinationKey = /^[a-z0-9]$/.test(key) ? key : namedKeys[key]
  if (!combinationKey) {
    return null
  }
  return Array.from(new Set(modifiers)).concat(combinationKey).join('+')
}

// whether the extension filters network requests, which only works while Min's own ad blocker is off (AGENTS.md section 15)
function extensionUsesNetworkFiltering (manifest) {
  const permissions = manifest.permissions || []
  return ['webRequestBlocking', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess'].some(p => permissions.includes(p))
}

if (typeof module !== 'undefined') {
  module.exports = {
    EXTENSION_WEBSTORE_KEY_HASH,
    EXTENSION_WEBSTORE_UPDATE_URL,
    readExtensionProtobuf,
    extensionIdFromPublicKey,
    parseCrx,
    compareExtensionVersions,
    getExtensionUpdateCheckURL,
    getWebStoreDownloadURL,
    parseExtensionUpdateResponse,
    readExtensionZip,
    safeExtensionZipPath,
    getExtensionManifestText,
    describeExtensionPermissions,
    getExtensionPermissionIncrease,
    extensionHostPatternCovers,
    getExtensionShortcutCombo,
    extensionUsesNetworkFiltering
  }
}
