// Builds zip and signed CRX3 files for tests: the unit tests (test/extensionPackages.test.js) and suites that install a
// crafted extension (security-checks.js). No packages needed: Node's zlib and crypto.
const crypto = require('crypto')
const zlib = require('zlib')
const { extensionIdFromPublicKey } = require('../../js/util/extensionPackages.js')

// a zip with the given {name: content} files, in that order; deflated unless the name ends in ".stored"
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

// a new RSA key pair for signing; pass it as options.keys to sign several versions of one extension (one id)
function makeCrxKeys () {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
}

// A CRX3 file signed with an RSA key (a new one unless options.keys is given); returns {crx, id, publicDer, extraKeyHash}.
// options.extraKey adds an ECDSA signature from another key (as the Web Store adds its own), options.badExtraSignature
// makes that one invalid, options.replaceZip puts another zip after the signed header.
function makeCrx (zip, options = {}) {
  const { publicKey, privateKey } = options.keys || makeCrxKeys()
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

module.exports = { makeZip, makeCrx, makeCrxKeys, protobufField }
