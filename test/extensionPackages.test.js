const test = require('node:test')
const assert = require('node:assert')

const {
  EXTENSION_WEBSTORE_KEY_HASH,
  readExtensionProtobuf,
  extensionIdFromPublicKey,
  parseCrx,
  compareExtensionVersions,
  isValidExtensionVersion,
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
} = require('../js/util/extensionPackages.js')

const { makeZip, makeCrx, protobufField } = require('./e2e/make-crx.js')

test('protobuf: varints and length-delimited fields', function () {
  const fields = readExtensionProtobuf(Buffer.concat([Buffer.from([0x08, 0x96, 0x01]), protobufField(2, Buffer.from('hi'))]))
  assert.strictEqual(fields[1][0], 150)
  assert.strictEqual(fields[2][0].toString(), 'hi')
})

test('extension ids: a-p letters from the key hash', function () {
  const id = extensionIdFromPublicKey(Buffer.from('key'))
  assert.match(id, /^[a-p]{32}$/)
  assert.strictEqual(id, extensionIdFromPublicKey(Buffer.from('key')))
})

test('crx: a correctly signed file gives its id, key and zip', function () {
  const zip = makeZip({ 'manifest.json': '{"name":"x"}' })
  const { crx, id, publicDer } = makeCrx(zip)
  const parsed = parseCrx(crx)
  assert.strictEqual(parsed.id, id)
  assert.ok(parsed.publicKey.equals(publicDer))
  assert.ok(parsed.zip.equals(zip))
  assert.strictEqual(parsed.fromWebStore, false)
})

test('crx: every signature must verify; the Web Store key is recognized by its hash', function () {
  const zip = makeZip({ 'manifest.json': '{"name":"x"}' })
  const signedTwice = makeCrx(zip, { extraKey: true })
  assert.strictEqual(parseCrx(signedTwice.crx).id, signedTwice.id)
  assert.strictEqual(parseCrx(signedTwice.crx).fromWebStore, false)
  assert.notStrictEqual(signedTwice.extraKeyHash, EXTENSION_WEBSTORE_KEY_HASH)
  assert.throws(() => parseCrx(makeCrx(zip, { extraKey: true, badExtraSignature: true }).crx), /doesn't match/)
  assert.strictEqual(EXTENSION_WEBSTORE_KEY_HASH, '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf')
})

test('versions: numeric parts, missing parts are 0', function () {
  assert.strictEqual(compareExtensionVersions('4.9.134', '4.9.100'), 1)
  assert.strictEqual(compareExtensionVersions('4.9.10', '4.9.100'), -1)
  assert.strictEqual(compareExtensionVersions('2026.10.1', '2026.10.1.0'), 0)
  assert.strictEqual(compareExtensionVersions('1.10', '1.9.9'), 1)
})

test('versions: only what Chrome accepts (it becomes a folder name)', function () {
  for (const version of ['1', '1.0', '4.9.134', '2026.10.1.0', '0.0.1', '65535.0']) {
    assert.strictEqual(isValidExtensionVersion(version), true, version)
  }
  for (const version of ['..', '.', '', '1.', '.1', '1..2', '1.2.3.4.5', '65536', '1.0-beta', '1/2', '1 ', 1, null, undefined]) {
    assert.strictEqual(isValidExtensionVersion(version), false, String(version))
  }
})

test('updates: check and download addresses', function () {
  assert.strictEqual(
    getExtensionUpdateCheckURL('https://clients2.google.com/service/update2/crx', [{ id: 'aaaa', version: '1.0' }, { id: 'bbbb', version: '2' }], '156.0.1'),
    'https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=156.0.1&x=id%3Daaaa%26v%3D1.0%26uc&x=id%3Dbbbb%26v%3D2%26uc'
  )
  assert.ok(getExtensionUpdateCheckURL('https://example.com/u?x=1', [{ id: 'a', version: '1' }], '156').startsWith('https://example.com/u?x=1&response=updatecheck'))
  assert.strictEqual(getWebStoreDownloadURL('aaaa', '156.0.1'), 'https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx3&prodversion=156.0.1&x=id%3Daaaa%26installsource%3Dondemand%26uc')
})

test('updates: the update server\'s answer', function () {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">' +
    '<daystart elapsed_days="7243"/>' +
    '<app appid="eimadpbcbfnmbkopoojfekhnkhdbieeh" cohort="1::" status="ok"><updatecheck _esbAllowlist="true" codebase="https://clients2.googleusercontent.com/crx/blobs/A/B_4_9_134_0.crx?a=1&amp;b=2" hash_sha256="864A73" size="855869" status="ok" version="4.9.134"/></app>' +
    '<app appid="nngceckbapebfimnlniiiahkandclblb" status="ok"><updatecheck status="noupdate"/></app>' +
    '<app appid="cccccccccccccccccccccccccccccccc" status="error-unknownApplication"/>' +
    '</gupdate>'
  assert.deepStrictEqual(parseExtensionUpdateResponse(xml), {
    eimadpbcbfnmbkopoojfekhnkhdbieeh: { status: 'ok', version: '4.9.134', codebase: 'https://clients2.googleusercontent.com/crx/blobs/A/B_4_9_134_0.crx?a=1&b=2', hashSha256: '864a73' },
    nngceckbapebfimnlniiiahkandclblb: { status: 'noupdate', version: '', codebase: '', hashSha256: '' }
  })
  assert.deepStrictEqual(parseExtensionUpdateResponse('not xml'), {})
})

test('updates: what a new version asks for that the old one didn\'t', function () {
  const old = { manifest_version: 3, permissions: ['storage', 'tabs'], host_permissions: ['https://example.com/*'] }
  assert.strictEqual(getExtensionPermissionIncrease(old, old), null)
  assert.strictEqual(getExtensionPermissionIncrease(old, { manifest_version: 3, permissions: ['storage'], host_permissions: [] }), null)
  assert.strictEqual(getExtensionPermissionIncrease(old, Object.assign({}, old, { permissions: ['storage', 'tabs', 'alarms'] })), null)
  assert.deepStrictEqual(getExtensionPermissionIncrease(old, { manifest_version: 3, permissions: ['storage', 'tabs', 'history', 'tabGroups'], host_permissions: ['https://example.com/*', 'https://example.org/*'] }),
    { allSites: false, sites: ['https://example.org'], items: ['extensionPermissionHistory'], other: ['tabGroups'] })
  assert.deepStrictEqual(getExtensionPermissionIncrease(old, Object.assign({}, old, { host_permissions: ['<all_urls>'] })),
    { allSites: true, sites: [], items: [], other: [] })
  assert.strictEqual(getExtensionPermissionIncrease(Object.assign({}, old, { host_permissions: ['<all_urls>'] }), Object.assign({}, old, { host_permissions: ['https://example.org/*'] })), null)
})

test('crx: changed contents, wrong format and other versions are refused', function () {
  const zip = makeZip({ 'manifest.json': '{"name":"x"}' })
  const { crx } = makeCrx(zip, { replaceZip: makeZip({ 'manifest.json': '{"name":"changed"}' }) })
  assert.throws(() => parseCrx(crx), /signature doesn't match/)
  assert.throws(() => parseCrx(Buffer.from('PK\u0003\u0004 not a crx')), /Not a Chrome extension file/)
  const version2 = Buffer.from(makeCrx(zip).crx)
  version2.writeUInt32LE(2, 4)
  assert.throws(() => parseCrx(version2), /only CRX3/)
})

test('zip: deflated and stored files, nested folders', function () {
  const files = readExtensionZip(makeZip({ 'manifest.json': '{"a":1}', 'js/background.js': 'console.log(1)', 'icons/a.stored': 'raw bytes' }))
  assert.deepStrictEqual(files.map(f => f.path), ['manifest.json', 'js/background.js', 'icons/a.stored'])
  assert.strictEqual(files[1].data.toString(), 'console.log(1)')
  assert.strictEqual(files[2].data.toString(), 'raw bytes')
})

test('zip: names that escape the folder are refused', function () {
  assert.strictEqual(safeExtensionZipPath('a/./b.js'), 'a/b.js')
  assert.strictEqual(safeExtensionZipPath('../evil.js'), null)
  assert.strictEqual(safeExtensionZipPath('a/../../evil.js'), null)
  assert.strictEqual(safeExtensionZipPath('/abs.js'), null)
  assert.strictEqual(safeExtensionZipPath('C:/Windows/evil.js'), null)
  assert.strictEqual(safeExtensionZipPath('a\\..\\evil.js'), null)
  // on Windows these name manifest.json itself (an NTFS data stream)
  assert.strictEqual(safeExtensionZipPath('manifest.json::$DATA'), null)
  assert.strictEqual(safeExtensionZipPath('js/a.js:stream'), null)
  assert.throws(() => readExtensionZip(makeZip({ '../evil.js': 'x' })), /unsafe file name/)
  assert.throws(() => readExtensionZip(Buffer.from('not a zip at all, definitely not')), /no end record/)
})

test('manifest text: __MSG_ names come from the default locale', function () {
  const manifest = { name: '__MSG_extName__', description: 'Plain' }
  assert.strictEqual(getExtensionManifestText(manifest, 'name', { extname: { message: 'Bitwarden' } }), 'Bitwarden')
  assert.strictEqual(getExtensionManifestText(manifest, 'description', {}), 'Plain')
  assert.strictEqual(getExtensionManifestText(manifest, 'name', {}), '__MSG_extName__')
})

test('permissions: all sites, listed sites, labeled and other permissions', function () {
  const everything = describeExtensionPermissions({ manifest_version: 3, permissions: ['tabs', 'storage', 'webRequest', 'declarativeNetRequest', 'history', 'somethingNew'], host_permissions: ['<all_urls>'] })
  assert.strictEqual(everything.allSites, true)
  assert.deepStrictEqual(everything.items, ['extensionPermissionTabs', 'extensionPermissionNetwork', 'extensionPermissionHistory'])
  assert.deepStrictEqual(everything.other, ['somethingNew'])

  const some = describeExtensionPermissions({ manifest_version: 3, permissions: ['storage'], content_scripts: [{ matches: ['*://*.example.com/*', 'https://github.com/*'] }] })
  assert.strictEqual(some.allSites, false)
  assert.deepStrictEqual(some.sites, ['*.example.com', 'https://github.com'])
  assert.deepStrictEqual(some.items, [])
})

test('optional permissions: a declared host pattern covers the same or a narrower one', function () {
  const covers = extensionHostPatternCovers
  assert.strictEqual(covers('https://example.com/*', 'https://example.com/*'), true)
  assert.strictEqual(covers('<all_urls>', 'https://example.com/*'), true)
  assert.strictEqual(covers('<all_urls>', 'file:///*'), true)
  assert.strictEqual(covers('*://*/*', 'https://example.com/*'), true)
  assert.strictEqual(covers('*://*/*', 'http://*.example.com/*'), true)
  assert.strictEqual(covers('https://*/*', 'https://example.com/*'), true)
  assert.strictEqual(covers('https://*.example.com/*', 'https://example.com/*'), true)
  assert.strictEqual(covers('https://*.example.com/*', 'https://mail.example.com/*'), true)
  assert.strictEqual(covers('https://*.example.com/*', 'https://*.mail.example.com/*'), true)
  assert.strictEqual(covers('https://example.com/*', 'https://example.com/inbox'), true)
  // not covered: another site, a wider pattern, another scheme, a look-alike host
  assert.strictEqual(covers('https://example.com/*', 'https://other.com/*'), false)
  assert.strictEqual(covers('https://example.com/*', 'https://*.example.com/*'), false)
  assert.strictEqual(covers('https://example.com/*', '<all_urls>'), false)
  assert.strictEqual(covers('https://example.com/*', '*://*/*'), false)
  assert.strictEqual(covers('https://*/*', 'http://example.com/*'), false)
  assert.strictEqual(covers('*://*/*', 'file:///*'), false)
  assert.strictEqual(covers('*://*/*', '<all_urls>'), false)
  assert.strictEqual(covers('https://*.example.com/*', 'https://notexample.com/*'), false)
  assert.strictEqual(covers('https://*.example.com/*', 'https://*/*'), false)
  assert.strictEqual(covers('https://example.com/inbox', 'https://example.com/*'), false)
  assert.strictEqual(covers('https://example.com/*', 'not a pattern'), false)
  assert.strictEqual(covers(undefined, 'https://example.com/*'), false)
})

test('shortcuts: suggested keys as Min key combos', function () {
  assert.strictEqual(getExtensionShortcutCombo('Alt+Shift+D', 'win32'), 'alt+shift+d')
  assert.strictEqual(getExtensionShortcutCombo('Ctrl+Shift+Y', 'win32'), 'ctrl+shift+y')
  assert.strictEqual(getExtensionShortcutCombo('Ctrl+Shift+Y', 'darwin'), 'super+shift+y')
  assert.strictEqual(getExtensionShortcutCombo('MacCtrl+Shift+Y', 'darwin'), 'ctrl+shift+y')
  assert.strictEqual(getExtensionShortcutCombo('Alt+Comma', 'linux'), 'alt+,')
  assert.strictEqual(getExtensionShortcutCombo('Ctrl+Up', 'win32'), 'ctrl+up')
  assert.strictEqual(getExtensionShortcutCombo({ default: 'Alt+A', mac: 'Command+B' }, 'darwin'), 'super+b')
  assert.strictEqual(getExtensionShortcutCombo({ default: 'Alt+A', mac: 'Command+B' }, 'win32'), 'alt+a')
  // not allowed: no Ctrl/Alt/Command, unknown modifiers or keys, nothing
  assert.strictEqual(getExtensionShortcutCombo('Shift+D', 'win32'), null)
  assert.strictEqual(getExtensionShortcutCombo('D', 'win32'), null)
  assert.strictEqual(getExtensionShortcutCombo('Hyper+D', 'win32'), null)
  assert.strictEqual(getExtensionShortcutCombo('Alt+F13', 'win32'), null)
  assert.strictEqual(getExtensionShortcutCombo({ mac: 'Command+B' }, 'win32'), null)
  assert.strictEqual(getExtensionShortcutCombo(undefined, 'win32'), null)
})

test('network filtering: blocking webRequest and DNR, but not plain webRequest', function () {
  assert.strictEqual(extensionUsesNetworkFiltering({ permissions: ['declarativeNetRequest'] }), true)
  assert.strictEqual(extensionUsesNetworkFiltering({ permissions: ['webRequest', 'webRequestBlocking'] }), true)
  assert.strictEqual(extensionUsesNetworkFiltering({ permissions: ['webRequest', 'storage'] }), false)
})
