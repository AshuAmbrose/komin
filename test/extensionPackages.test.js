const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const zlib = require('zlib')

const {
  EXTENSION_WEBSTORE_KEY_HASH,
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
  getExtensionShortcutCombo,
  extensionUsesNetworkFiltering
} = require('../js/util/extensionPackages.js')

// a zip with the given {name: content} files; deflated unless the name ends in ".stored"
function makeZip (files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const stored = name.endsWith('.stored')
    const body = stored ? data : zlib.deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const centralData = Buffer.concat(centrals)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(Object.keys(files).length, 8)
  endRecord.writeUInt16LE(Object.keys(files).length, 10)
  endRecord.writeUInt32LE(centralData.length, 12)
  endRecord.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralData, endRecord])
}

function protobufField (field, bytes) {
  const tag = field * 8 + 2
  const varint = n => { const out = []; while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128) } out.push(n); return Buffer.from(out) }
  return Buffer.concat([varint(tag), varint(bytes.length), bytes])
}

// a CRX3 file signed with a new RSA key; returns {crx, id}. options.extraKey adds an ECDSA signature from another key
// (as the Web Store adds its own), options.badExtraSignature makes that one invalid.
function makeCrx (zip, options = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicDer = publicKey.export({ type: 'spki', format: 'der' })
  const crxId = crypto.createHash('sha256').update(publicDer).digest().subarray(0, 16)
  const signedHeaderData = protobufField(1, crxId)
  const lengthBytes = Buffer.alloc(4)
  lengthBytes.writeUInt32LE(signedHeaderData.length)
  const signedContent = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), lengthBytes, signedHeaderData, zip])
  const signature = crypto.sign('sha256', signedContent, privateKey)
  const proofs = [protobufField(2, Buffer.concat([protobufField(1, publicDer), protobufField(2, signature)]))]
  let extraKeyHash = null
  if (options.extraKey) {
    const extra = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const extraDer = extra.publicKey.export({ type: 'spki', format: 'der' })
    const extraSignature = crypto.sign('sha256', options.badExtraSignature ? Buffer.from('something else') : signedContent, extra.privateKey)
    proofs.push(protobufField(3, Buffer.concat([protobufField(1, extraDer), protobufField(2, extraSignature)])))
    extraKeyHash = crypto.createHash('sha256').update(extraDer).digest('hex')
  }
  const header = Buffer.concat([
    ...proofs,
    protobufField(10000, signedHeaderData)
  ])
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'latin1')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return { crx: Buffer.concat([prefix, header, options.replaceZip || zip]), id: extensionIdFromPublicKey(publicDer), publicDer, extraKeyHash }
}

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
