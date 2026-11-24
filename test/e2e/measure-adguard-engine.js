// Which rules of AdGuard's test lists (measure-adguard-testcases.js) Ghostery's engine can read at all, with the settings
// Min builds it with. No browser: the lists are fetched and run through the engine's own parser (parseFilters). Each
// list is split by its "! Test case N" comments, so a case that failed in Min can be put down to the engine (it can't
// read the rule) or to Min (it can, but Min doesn't apply it). Reads the groups from the last run's results.
// usage: node test/e2e/measure-adguard-engine.js      writes results/measure-adguard-engine.json
const fs = require('fs')
const path = require('path')
const { parseFilters, Config } = require('@ghostery/adblocker')

const RESULTS = path.join(__dirname, 'results')
const groups = JSON.parse(fs.readFileSync(path.join(RESULTS, 'measure-adguard-testcases-groups.json'), 'utf8'))
const SOURCE = fs.readFileSync(path.join(__dirname, 'measure-adguard-testcases.js'), 'utf8')

// "Test case 3: ...", "Case 3", "Testcase 3 —" → 3
const caseNumber = text => { const m = /(?:test\s*case|case)\s*(\d+)/i.exec(text); return m ? Number(m[1]) : null }

;(async () => {
  const config = new Config() // Min's until 2026-11-17: ElectronBlocker.fromLists with no settings
  // the same with procedural hiding rules (:has-text(), :upward()...), which Min reads since (loadExtendedSelectors)
  const withExtended = new Config({ loadExtendedSelectors: true })
  const out = []
  for (const group of groups) {
    const rulesMatch = SOURCE.match(new RegExp("\\['" + group.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "', '[^']*', '([^']*)'"))
    const rulesURL = rulesMatch && rulesMatch[1] ? 'https://testcases.agrd.dev/' + rulesMatch[1] : ''
    if (!rulesURL) {
      continue
    }
    const text = await (await fetch(rulesURL)).text()
    // the rules under each "! Test case N" comment
    const cases = {}
    let current = 0
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('!')) {
        const n = caseNumber(line)
        if (n !== null) current = n
        continue
      }
      if (line.trim()) {
        // lists without "Test case" comments name the case in the rule itself (#case12.banner)
        const n = current || caseNumber(line) || 0
        ;(cases[n] = cases[n] || []).push(line.trim())
      }
    }
    const result = { title: group.title, adguardChrome: group.adguardChrome, inMin: group.total ? group.passed + '/' + group.total : (group.error || ''), cases: [] }
    for (const [n, rules] of Object.entries(cases)) {
      if (Number(n) === 0) continue
      const parsed = parseFilters(rules.join('\n'), config)
      const unsupported = parsed.notSupportedFilters.map(f => f.filter)
      const unsupportedWithExtended = parseFilters(rules.join('\n'), withExtended).notSupportedFilters.map(f => f.filter)
      const test = (group.tests || []).find(x => caseNumber(x.name) === Number(n))
      result.cases.push({
        case: Number(n),
        passedInMin: test ? test.passed : null,
        rules: rules.length,
        engineReads: rules.length - unsupported.length,
        unsupported,
        // rules the engine reads only with procedural hiding rules on
        readWithExtendedSelectors: unsupported.filter(rule => !unsupportedWithExtended.includes(rule))
      })
    }
    out.push(result)
  }
  // a failed case whose rules the engine reads entirely: Min's integration is the suspect
  const minSuspects = out.flatMap(g => g.cases.filter(c => c.passedInMin === false && c.unsupported.length === 0).map(c => g.title + ' — case ' + c.case))
  const engineLimits = out.flatMap(g => g.cases.filter(c => c.passedInMin === false && c.engineReads === 0).map(c => g.title + ' — case ' + c.case))
  const offInMin = out.flatMap(g => g.cases.filter(c => c.passedInMin === false && c.readWithExtendedSelectors.length > 0).map(c => g.title + ' — case ' + c.case))
  const mixed = out.flatMap(g => g.cases.filter(c => c.passedInMin === false && c.unsupported.length > 0 && c.engineReads > 0).map(c => g.title + ' — case ' + c.case))
  fs.writeFileSync(path.join(RESULTS, 'measure-adguard-engine.json'), JSON.stringify({ date: new Date().toISOString(), minSuspects, engineLimits, mixed, offInMin, groups: out }, null, 2))
  console.log(JSON.stringify({ failedCasesTheEngineReadsFully: minSuspects.length, failedCasesTheEngineCantReadAtAll: engineLimits.length, failedCasesPartlyReadable: mixed.length, failedCasesReadableWithProceduralRulesOn: offInMin.length }, null, 2))
  console.log('\nengine reads every rule, Min still fails:\n  ' + minSuspects.join('\n  '))
})()
