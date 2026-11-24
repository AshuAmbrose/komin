// What Min's ad-block engine leaves out of the lists it uses (main/filtering.js, ADBLOCKER_LISTS): every list is
// downloaded and read with Ghostery's parser twice, without procedural hiding rules (Ghostery's default, Min's until
// 2026-11-17) and with them (loadExtendedSelectors: :has-text(), :upward(), :xpath()...; Min's since). Counts the rules each way,
// the procedural ones Min skips, and the other rules the engine can't read, by kind. No browser.
// usage: node test/e2e/measure-adblock-lists.js     writes results/measure-adblock-lists.json
/* global AbortSignal */
const fs = require('fs')
const path = require('path')
const { parseFilters, Config } = require('@ghostery/adblocker')

// the same addresses as ADBLOCKER_LISTS in main/filtering.js
const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'main', 'filtering.js'), 'utf8')
const UBO = (SOURCE.match(/const UBO_LISTS_URL = '([^']+)'/) || [])[1]
const block = SOURCE.slice(SOURCE.indexOf('const ADBLOCKER_LISTS'), SOURCE.indexOf('function getAdblockerCachePath'))
const lists = Array.from(block.matchAll(/'(https:[^']+)'/g)).map(m => m[1])
  .concat(Array.from(block.matchAll(/UBO_LISTS_URL \+ '([^']+\.txt)'/g)).map(m => UBO + m[1]))
  .concat(Array.from((block.match(/\[('\d{4}'(?:, '\d{4}')*)\]/) || ['', ''])[1].matchAll(/'(\d{4})'/g)).map(m => UBO + 'filters-' + m[1] + '.txt'))

;(async () => {
  // Min's settings until 2026-11-17 (since then it reads the procedural rules too: extendedConfig)
  const minConfig = new Config()
  const extendedConfig = new Config({ loadExtendedSelectors: true })
  const out = { date: new Date().toISOString(), lists: [] }
  let skippedProcedural = []
  const examples = {} // a few unreadable rules of each kind
  for (const url of lists) {
    let text
    try {
      text = await (await fetch(url, { signal: AbortSignal.timeout(60000) })).text()
    } catch (e) {
      out.lists.push({ url, error: e.message })
      continue
    }
    const asMin = parseFilters(text, minConfig)
    const extended = parseFilters(text, extendedConfig)
    const minCosmetic = asMin.cosmeticFilters.length
    const extendedCosmetic = extended.cosmeticFilters.length
    const procedural = extended.cosmeticFilters.filter(f => f.isExtended && f.isExtended()).map(f => f.toString())
    skippedProcedural = skippedProcedural.concat(procedural)
    // what the unreadable rules are: a network rule by its first option ($csp, $redirect-rule...), a cosmetic one by its
    // marker (##^ is uBlock Origin's HTML filtering, #@#+js an exception for scriptlets...)
    const reasons = {}
    for (const f of extended.notSupportedFilters) {
      let kind
      const option = f.filter.lastIndexOf('$') > 0 && !f.filter.includes('#') ? f.filter.slice(f.filter.lastIndexOf('$') + 1).split(',')[0].split('=')[0] : null
      if (option) {
        kind = 'network $' + option
      } else {
        const marker = (f.filter.match(/#[@?$%]*#[\^+]?/) || ['other'])[0]
        kind = 'cosmetic ' + marker
      }
      reasons[kind] = (reasons[kind] || 0) + 1
      examples[kind] = examples[kind] || []
      if (examples[kind].length < 4) examples[kind].push(f.filter.slice(0, 160))
    }
    out.lists.push({
      url,
      network: asMin.networkFilters.length,
      cosmetic: minCosmetic,
      cosmeticWithProceduralOn: extendedCosmetic,
      proceduralSkippedByMin: procedural.length,
      notReadableEitherWay: extended.notSupportedFilters.length,
      notReadableByKind: reasons
    })
  }
  const sum = key => out.lists.reduce((total, l) => total + (l[key] || 0), 0)
  out.total = {
    network: sum('network'),
    cosmetic: sum('cosmetic'),
    proceduralSkippedByMin: sum('proceduralSkippedByMin'),
    notReadableEitherWay: sum('notReadableEitherWay')
  }
  // which procedural operators those rules use
  const operators = {}
  for (const rule of skippedProcedural) {
    for (const m of rule.matchAll(/:(has-text|upward|xpath|matches-css(?:-before|-after)?|min-text-length|watch-attr|remove|remove-attr|remove-class|style|matches-attr|matches-path|matches-prop|matches-media|others|shadow|has|not|is|-abp-has|-abp-contains|contains)\(/g)) {
      operators[m[1]] = (operators[m[1]] || 0) + 1
    }
  }
  out.proceduralOperators = operators
  out.proceduralExamples = skippedProcedural.slice(0, 15)
  const kinds = {}
  out.lists.forEach(l => Object.entries(l.notReadableByKind || {}).forEach(([k, v]) => { kinds[k] = (kinds[k] || 0) + v }))
  out.notReadableByKind = Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1]))
  out.notReadableExamples = examples
  // what Min's two small engines for pop-up and tracking-parameter rules cost (main/filtering.js, since 2026-11-17): the rules Min saved,
  // from the test cache (a run of adblock-first-start writes them), read as Min reads them at start
  const extraRulesFile = path.join(require('os').tmpdir(), 'min-e2e-cache', 'adblocker-extra-rules.txt')
  if (fs.existsSync(extraRulesFile)) {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron')
    const all = fs.readFileSync(extraRulesFile, 'utf8').split('\n').filter(Boolean)
    const removeparam = all.filter(rule => /[$,]removeparam\b/.test(rule))
    const popup = all.filter(rule => !/[$,]removeparam\b/.test(rule))
    const started = process.hrtime.bigint()
    const popupEngine = ElectronBlocker.parse(popup.join('\n'))
    const removeparamEngine = ElectronBlocker.parse(removeparam.join('\n'), { enableOptimizations: false })
    const parseMs = Number(process.hrtime.bigint() - started) / 1e6
    out.extraRulesEngines = { popupRules: popup.length, removeparamRules: removeparam.length, fileBytes: fs.statSync(extraRulesFile).size, parseMs: Math.round(parseMs), serializedBytes: popupEngine.serialize().length + removeparamEngine.serialize().length }
  }
  fs.writeFileSync(path.join(__dirname, 'results', 'measure-adblock-lists.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify({ lists: out.lists.length, total: out.total, proceduralOperators: operators, notReadableByKind: Object.fromEntries(Object.entries(out.notReadableByKind).slice(0, 15)), extraRulesEngines: out.extraRulesEngines }, null, 2))
})()
