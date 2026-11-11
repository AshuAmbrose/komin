// Switches changes made on the branch chore/unlocked-remeasure (2026-11-09 and 10) back to master's behaviour for one run,
// so a measurement can compare the two: repo files are patched with t.patchFile (dist/preload.js, main.build.js) and put
// back when the run ends. Set MIN_TEST_OLD to a comma-separated list of these names; a measurement script calls
// require('./old-behaviour')(t), which returns the names it switched (record them in the result).
//   scriptletsAfterStart   the start scriptlets come a round trip later, run by main (master's inject-cosmetic-filters),
//                          not from the preload before the page's own scripts (cosmetic-filters-start); the generic rules
//                          still run, their watcher from DOMContentLoaded whatever hideAdSpacesWhileLoading says
//   domainWithoutWWW       site rules get the hostname without "www." (master), not the registrable domain (pitfall 52)
//   noExtensionTabList     Min's tab list for extensions off (main/extensionTabs.js, startExtensionTabSync)
//   minimizedFocusedInUse  a minimized window that Windows left focused counts as in use (master)
// When the generic rules' watcher starts is the setting hideAdSpacesWhileLoading since 2026-11-11 (off, the default, is
// master's DOMContentLoaded): measurement scripts seed it in the run's settings instead (the switch watcherFromParsed
// did it before).
function replaceAll (t, file, pairs, append) {
  t.patchFile(file, function (text) {
    let s = text.replace(/\r\n/g, '\n')
    for (const [from, to] of pairs) {
      if (!s.includes(from)) throw new Error(file + ': "' + from.trim() + '" not found (has the code moved?)')
      s = s.split(from).join(to)
    }
    return append ? s + '\n' + append + '\n' : s
  })
}

const SWITCHES = {
  scriptletsAfterStart: function (t) {
    replaceAll(t, 'dist/preload.js', [
      ["var minCosmetics = ipc.sendSync('cosmetic-filters-start', window.location.href)",
        "ipc.send('cosmetic-filters-start-old', window.location.href)\n  var minCosmetics = { scriptlets: null, dom: true }"]
    ])
    replaceAll(t, 'main.build.js', [], "ipc.on('cosmetic-filters-start-old', function (event, url) { if (cosmeticFiltersApply(event, url) && adblockerEngine) { injectCosmeticFiltersForSender(adblockerEngine, event.sender, url) } })")
  },
  domainWithoutWWW: t => replaceAll(t, 'main.build.js', [
    ['return getRegistrableDomain(hostname) || removeWWW(hostname)', 'return removeWWW(hostname)']
  ]),
  noExtensionTabList: t => replaceAll(t, 'main.build.js', [
    ['  startExtensionTabSync()\n', '\n']
  ]),
  minimizedFocusedInUse: t => replaceAll(t, 'main.build.js', [
    ['BaseWindow.getFocusedWindow() === newWin && !newWin.isMinimized()', 'BaseWindow.getFocusedWindow() === newWin'],
    ['const minInUse = focusedWindow !== null && !focusedWindow.isMinimized()', 'const minInUse = focusedWindow !== null']
  ])
}

module.exports = function oldBehaviour (t, names = (process.env.MIN_TEST_OLD || '').split(',')) {
  const list = names.map(s => s.trim()).filter(Boolean)
  for (const name of list) {
    if (!SWITCHES[name]) throw new Error('MIN_TEST_OLD: unknown switch ' + name + ' (known: ' + Object.keys(SWITCHES).join(', ') + ')')
  }
  list.forEach(name => SWITCHES[name](t))
  return list
}
module.exports.names = Object.keys(SWITCHES)
