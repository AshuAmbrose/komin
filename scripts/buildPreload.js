const path = require('path')
const fs = require('fs')

const outFile = path.resolve(__dirname, '../dist/preload.js')

const modules = [
  'js/preload/default.js',
  'js/preload/textExtractor.js',
  'js/preload/readerDetector.js',
  'js/preload/siteUnbreak.js',
  'js/preload/mediaTracker.js',
  'js/preload/userscripts.js',
  'js/preload/webStore.js',
  'js/util/settings/settingsPreload.js',
  'js/preload/passwordFill.js',
  'js/preload/translate.js',
]

/* Ghostery's page watcher (DOMMonitor, for the generic hiding rules in js/preload/default.js): its standalone build from
   @ghostery/adblocker-content (Mozilla Public License 2.0), unchanged, wrapped so it gives its functions to
   ghosteryContent instead of the preload's own module objects. */
function ghosteryContentScript () {
  const folder = path.dirname(require.resolve('@ghostery/adblocker-content/package.json'))
  const code = fs.readFileSync(path.join(folder, 'dist/adblocker.umd.min.js'), 'utf-8').replace(/\/\/# sourceMappingURL=.*$/m, '')
  return 'var ghosteryContent = (function () {\nvar exports = {}\nvar module = { exports: exports }\n' + code + '\nreturn module.exports\n})();\n'
}

/* Ghostery's evaluator for procedural hiding rules (@ghostery/adblocker-extended-selectors, Mozilla Public License 2.0):
   its standalone build, unchanged, inside a function the preload only calls on a page that has such rules
   (applyExtendedRules in js/preload/default.js), so other pages don't compile it. */
function ghosteryExtendedSelectorsScript () {
  const folder = path.dirname(require.resolve('@ghostery/adblocker-extended-selectors/package.json'))
  const code = fs.readFileSync(path.join(folder, 'dist/adblocker.umd.min.js'), 'utf-8').replace(/\/\/# sourceMappingURL=.*$/m, '')
  return 'function loadGhosteryExtendedSelectors () {\nif (!loadGhosteryExtendedSelectors.loaded) {\nvar exports = {}\nvar module = { exports: exports }\n' + code + '\nloadGhosteryExtendedSelectors.loaded = module.exports\n}\nreturn loadGhosteryExtendedSelectors.loaded\n}\n'
}

function buildPreload() {
  /* concatenate modules */
  let output = ghosteryContentScript() + ghosteryExtendedSelectorsScript()
  modules.forEach(function (script) {
    output += fs.readFileSync(path.resolve(__dirname, '../', script)) + ';\n'
  })

  fs.writeFileSync(outFile, output, 'utf-8')
}

if (module.parent) {
  module.exports = buildPreload
} else {
  buildPreload()
}
