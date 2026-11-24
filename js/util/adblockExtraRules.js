// The lists' rules Min's main ad-block engine can't apply, kept apart for two small engines of their own
// (main/filtering.js, popupRulesEngine and removeparamRulesEngine; section 10.2). Joined into main.build.js before
// main/filtering.js, and required by the tests (test/e2e/measure-adguard-testcases.js), which give Min a list of their own.
//   - pop-up rules ($popup): Ghostery's parser refuses the option, and it never counts a page request as third-party,
//     which many of them need. Each rule's type options become $other, a type nothing else asks that engine about.
//   - tracking-parameter rules ($removeparam), as they are: the main engine's optimizer merges the generic ones into one
//     rule that keeps a single parameter name, so they get an engine built without optimizations.

// a rule's type options; a pop-up rule's are replaced by $other
const ADBLOCK_NETWORK_TYPE_OPTIONS = ['popup', 'doc', 'document', 'subdocument', 'frame', 'script', 'image', 'stylesheet', 'css', 'xhr', 'xmlhttprequest', 'media', 'font', 'object', 'other', 'ping', 'websocket', 'all', 'mainframe', 'main_frame', 'beacon', 'fetch']

// a list's pop-up rules, rewritten, and its tracking-parameter rules, as they are; one rule a line
function getAdblockExtraRules (listText) {
  const rules = []
  listText.split(/\r?\n/).forEach(function (line) {
    const rule = line.trim()
    // comments, list headers and element hiding rules (##, #@#, #?#, #$#, #%#)
    if (!rule || rule[0] === '!' || rule[0] === '[' || /#[@?$%]*#/.test(rule)) {
      return
    }
    const optionsStart = rule.lastIndexOf('$')
    if (optionsStart < 0) {
      return
    }
    const options = rule.slice(optionsStart + 1).split(',')
    if (options.some(option => option === 'removeparam' || option.startsWith('removeparam='))) {
      rules.push(rule)
    } else if (optionsStart > 0 && options.includes('popup')) {
      const kept = options.filter(option => !ADBLOCK_NETWORK_TYPE_OPTIONS.includes(option.replace(/^~/, '')))
      rules.push(rule.slice(0, optionsStart) + '$' + kept.concat('other').join(','))
    }
  })
  return rules
}

// the two kinds apart again: { popup, removeparam }
function splitAdblockExtraRules (rules) {
  const isRemoveparam = rule => /[$,]removeparam\b/.test(rule)
  return { popup: rules.filter(rule => !isRemoveparam(rule)), removeparam: rules.filter(isRemoveparam) }
}

if (typeof module !== 'undefined') {
  module.exports = { getAdblockExtraRules, splitAdblockExtraRules }
}
