// Unpacks an extension's .crx so its code can be read (how Dark Reader's popup waited on a missing function was found this
// way). Uses Min's own CRX reader (js/util/extensionPackages.js), so a file Min would refuse fails here too.
// usage: node test/e2e/extract-crx.js <extension id | path to a .crx> [folder]
//   an id is taken from the suites' cache (%TEMP%\min-e2e-cache\crx), downloaded from Chrome's update server if it isn't
//   there yet; the default folder is test/e2e/results/crx/<id>-<version> (not committed). Nothing is run or installed.
const fs = require('fs')
const path = require('path')
const harness = require('./harness')
const { parseCrx, readExtensionZip } = require('../../js/util/extensionPackages.js')

;(async () => {
  const [source, folderArg] = process.argv.slice(2)
  if (!source) {
    console.error('usage: node test/e2e/extract-crx.js <extension id | path to a .crx> [folder]')
    process.exit(2)
  }
  let file = source
  if (/^[a-p]{32}$/.test(source)) {
    await harness.downloadExtensions([source])
    file = harness.crxPath(source)
  }
  const crx = parseCrx(fs.readFileSync(file))
  const files = readExtensionZip(crx.zip)
  const manifest = JSON.parse(files.find(f => f.path === 'manifest.json').data.toString('utf8').replace(/^\uFEFF/, ''))
  const folder = path.resolve(folderArg || path.join(__dirname, 'results', 'crx', crx.id + '-' + manifest.version))
  fs.rmSync(folder, { recursive: true, force: true })
  for (const { path: name, data } of files) {
    const target = path.join(folder, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
  }
  console.log(manifest.name + ' ' + manifest.version + ' (Manifest V' + manifest.manifest_version + ', id ' + crx.id + (crx.fromWebStore ? ', signed by the Chrome Web Store' : '') + '): ' + files.length + ' files in ' + folder)
})().catch(e => {
  console.error(String(e.stack || e))
  process.exit(1)
})
