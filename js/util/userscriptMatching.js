/* Userscript metadata parsing, URL matching and permissions.
   Shared by the main process (concatenated into main.build.js, used by main/userscripts*.js), the UI (context-menu scripts) and test/userscriptMatching.test.js.
   Follows Tampermonkey/Violentmonkey: @match takes Chrome match patterns, @include/@exclude take globs or /regular expressions/. */

// userscripts only ever run on these schemes
const USERSCRIPT_SCHEMES = ['http:', 'https:', 'file:']
const USERSCRIPT_RUN_AT = ['document-start', 'document-body', 'document-end', 'document-idle', 'context-menu']

// the Greasemonkey functions Min provides. "@grant GM_getValue" and "@grant GM.getValue" both grant getValue.
// GM_info, GM.info and unsafeWindow are always available.
const USERSCRIPT_APIS = [
  'getValue', 'setValue', 'deleteValue', 'listValues', 'getValues', 'setValues', 'deleteValues',
  'addValueChangeListener', 'removeValueChangeListener',
  'addStyle', 'addElement', 'xmlhttpRequest', 'download', 'openInTab', 'setClipboard', 'notification',
  'registerMenuCommand', 'unregisterMenuCommand', 'getResourceText', 'getResourceURL', 'log'
]
const USERSCRIPT_API_BY_NAME = Object.fromEntries(USERSCRIPT_APIS.map(api => [api.toLowerCase(), api]))

const USERSCRIPT_METADATA_START = /^\/\/\s*==UserScript==$/
const USERSCRIPT_METADATA_END = /^\/\/\s*==\/UserScript==$/

// parses the "// ==UserScript==" block into {key: [values]}, or returns null if there isn't one
function parseUserscriptMetadata (content) {
  const lines = content.split(/\r?\n/)
  let metadata = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!metadata) {
      if (USERSCRIPT_METADATA_START.test(line)) {
        metadata = {}
      }
      continue
    }
    if (USERSCRIPT_METADATA_END.test(line)) {
      break
    }
    const parts = line.match(/^\/\/\s*@(\S+)(?:\s+(.*))?$/)
    if (parts) {
      if (!metadata[parts[1]]) {
        metadata[parts[1]] = []
      }
      metadata[parts[1]].push((parts[2] || '').trim())
    }
  }
  if (metadata && Object.keys(metadata).length > 0) {
    return metadata
  }
  return null
}

// the metadata block as written, for GM_info.scriptMetaStr
function getUserscriptMetadataBlock (content) {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex(line => USERSCRIPT_METADATA_START.test(line.trim()))
  if (start === -1) {
    return ''
  }
  const end = lines.findIndex((line, i) => i > start && USERSCRIPT_METADATA_END.test(line.trim()))
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n')
}

// the APIs a script may use, from its @grant values. A script without @grant gets the ones its code mentions, as in Tampermonkey.
function getUserscriptGrants (grantValues, content) {
  const names = grantValues || content.match(/\bGM[_.][A-Za-z]+/g) || []
  const grants = new Set()
  names.forEach(function (name) {
    const api = USERSCRIPT_API_BY_NAME[name.toLowerCase().replace(/^gm[_.]/, '')]
    if (api) {
      grants.add(api)
    }
  })
  return Array.from(grants).sort()
}

/*
Whether GM_xmlhttpRequest from a page on pageHostname may reach hostname.
connects are the script's @connect values: a domain (which includes its subdomains), an IP address, "localhost", "self" (the page's host) or "*" (anything).
The page's own host is always allowed.
*/
function userscriptCanConnect (connects, hostname, pageHostname) {
  hostname = hostname.toLowerCase()
  if (hostname === (pageHostname || '').toLowerCase()) {
    return true
  }
  return connects.some(function (entry) {
    entry = entry.toLowerCase().replace(/^\*\./, '')
    if (entry === '*') {
      return true
    }
    if (entry === 'self') {
      return false
    }
    return hostname === entry || hostname.endsWith('.' + entry)
  })
}

// compares @version strings like Tampermonkey: numeric parts by number, and a release is newer than a pre-release (1.0 > 1.0b). Returns -1, 0 or 1.
function compareUserscriptVersions (a, b) {
  const partsA = String(a || '0').trim().split('.')
  const partsB = String(b || '0').trim().split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = (partsA[i] || '0').match(/^(\d*)(.*)$/)
    const partB = (partsB[i] || '0').match(/^(\d*)(.*)$/)
    const numberA = parseInt(partA[1] || '0', 10)
    const numberB = parseInt(partB[1] || '0', 10)
    if (numberA !== numberB) {
      return numberA > numberB ? 1 : -1
    }
    if (partA[2] !== partB[2]) {
      if (!partA[2] || !partB[2]) {
        return partA[2] ? -1 : 1
      }
      return partA[2] > partB[2] ? 1 : -1
    }
  }
  return 0
}

const USERSCRIPT_EVERYWHERE_PATTERNS = ['<all_urls>', '*', '*://*/*', 'http*://*/*', 'http*', '*://*', '/.*/']

// whether a script runs on every site (no rules, or a catch-all rule)
function userscriptRunsEverywhere (rules) {
  if (!rules.match && !rules.include) {
    return true
  }
  return (rules.match || []).concat(rules.include || []).some(pattern => USERSCRIPT_EVERYWHERE_PATTERNS.includes(pattern))
}

/*
What an update adds to what a script could already do: sites it runs on, domains it can connect to, and APIs.
An update that adds nothing is installed automatically; anything else waits for the user's approval.
*/
function getUserscriptPermissionIncrease (oldScript, newScript) {
  const added = (oldList, newList) => newList.filter(item => !oldList.includes(item))
  const sites = list => (list.match || []).concat(list.include || [])

  const increase = {
    sites: userscriptRunsEverywhere(oldScript.rules) ? [] : added(sites(oldScript.rules), sites(newScript.rules)),
    connects: oldScript.connects.includes('*') ? [] : added(oldScript.connects, newScript.connects),
    grants: added(oldScript.grants, newScript.grants)
  }
  if (!userscriptRunsEverywhere(oldScript.rules) && userscriptRunsEverywhere(newScript.rules) && increase.sites.length === 0) {
    increase.sites = ['*']
  }
  return increase
}

function userscriptPermissionsIncreased (increase) {
  return increase.sites.length > 0 || increase.connects.length > 0 || increase.grants.length > 0
}

function escapeUserscriptRegExp (text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

// a Chrome match pattern (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) as a function of a URL object; null if the pattern is invalid
function compileUserscriptMatchPattern (pattern) {
  if (pattern === '<all_urls>' || pattern === '*') {
    return url => USERSCRIPT_SCHEMES.includes(url.protocol)
  }

  const parts = pattern.match(/^(\*|http\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i)
  if (!parts) {
    return null
  }

  const scheme = parts[1].toLowerCase()
  let schemeMatches = protocol => protocol === scheme + ':'
  if (scheme === '*' || scheme === 'http*') {
    schemeMatches = protocol => protocol === 'http:' || protocol === 'https:'
  }

  let host = parts[2].toLowerCase()
  let port = null
  const portParts = host.match(/^(.*):(\d+|\*)$/)
  if (portParts) {
    host = portParts[1]
    port = portParts[2]
  }

  let hostMatches
  if (scheme === 'file' || host === '*') {
    hostMatches = () => true
  } else if (host.startsWith('*.') && !host.slice(2).includes('*')) {
    const domain = host.slice(2)
    hostMatches = hostname => hostname === domain || hostname.endsWith('.' + domain)
  } else if (host && !host.includes('*')) {
    hostMatches = hostname => hostname === host
  } else {
    return null
  }

  // the path is matched against the path and query; a missing path (invalid in Chrome) is treated as "/*"
  const pathRegExp = new RegExp('^' + (parts[3] || '/*').split('*').map(escapeUserscriptRegExp).join('.*') + '$')

  return function (url) {
    if (!schemeMatches(url.protocol) || !hostMatches(url.hostname)) {
      return false
    }
    if (port !== null && port !== '*') {
      const urlPort = url.port || (url.protocol === 'https:' ? '443' : (url.protocol === 'http:' ? '80' : ''))
      if (urlPort !== port) {
        return false
      }
    }
    return pathRegExp.test(url.pathname + url.search)
  }
}

// ".tld" in an @include glob stands for any top-level domain, e.g. "google.tld" matches google.com and google.co.uk
const USERSCRIPT_TLD_SOURCE = '(?:\\.[a-z]{2,3})?\\.[a-z0-9-]{2,}'

// an @include/@exclude rule (a glob where * matches anything, or a /regular expression/) as a function of a URL object; null if invalid
function compileUserscriptGlob (glob) {
  const regExpParts = glob.match(/^\/(.+)\/([imsu]*)$/)
  let regExp
  try {
    if (regExpParts) {
      regExp = new RegExp(regExpParts[1], regExpParts[2])
    } else {
      regExp = new RegExp('^' + glob.split('*').map(part => escapeUserscriptRegExp(part).replace(/\\\.tld(?=\/|:|$)/g, USERSCRIPT_TLD_SOURCE)).join('.*') + '$', 'i')
    }
  } catch (e) {
    return null
  }
  return url => regExp.test(url.href)
}

/*
rules: {match, include, exclude, excludeMatch}, each an array of strings or undefined.
Returns a matcher for userscriptMatchesURL. A script that declares no @match or @include runs everywhere,
but one whose @match/@include rules are all invalid runs nowhere.
*/
function compileUserscriptRules (rules) {
  const compileAll = function (patterns, compile) {
    return (patterns || []).map(compile).filter(fn => fn !== null)
  }
  return {
    restricted: !!(rules.match || rules.include),
    include: compileAll(rules.match, compileUserscriptMatchPattern).concat(compileAll(rules.include, compileUserscriptGlob)),
    exclude: compileAll(rules.excludeMatch, compileUserscriptMatchPattern).concat(compileAll(rules.exclude, compileUserscriptGlob))
  }
}

function parseUserscriptURL (href) {
  try {
    const url = new URL(href)
    if (USERSCRIPT_SCHEMES.includes(url.protocol)) {
      return url
    }
  } catch (e) {}
  return null
}

// whether userscripts may run on this page at all
function userscriptCanRunOnURL (href) {
  return parseUserscriptURL(href) !== null
}

function userscriptMatchesURL (matcher, href) {
  const url = parseUserscriptURL(href)
  if (!url) {
    return false
  }
  const test = fn => fn(url)
  if (matcher.restricted && !matcher.include.some(test)) {
    return false
  }
  return !matcher.exclude.some(test)
}

/*
Turns a script file into {id, name, runAt, noframes, legacy, content, rules, matcher} plus the metadata Min uses:
namespace, version, description, author, icon, homepage, updateURL, downloadURL, grants, connects, requires, resources ([{name, url}]) and antifeatures.
locale (like "en-US") picks a localized @name:xx and @description:xx.
Files without a metadata block are legacy Min scripts: "example.com.js" runs on example.com and its subdomains, "global.js" everywhere.
Returns null for a file that can't be a script.
*/
function compileUserscript (filename, content, locale) {
  const metadata = parseUserscriptMetadata(content)
  let rules

  if (metadata) {
    rules = {
      match: metadata.match,
      include: metadata.include,
      exclude: metadata.exclude,
      excludeMatch: metadata['exclude-match']
    }
  } else {
    let domain = filename.replace(/\.js$/, '')
    if (domain.startsWith('www.')) {
      domain = domain.slice(4)
    }
    if (!domain) {
      return null
    }
    rules = { match: [domain === 'global' ? '<all_urls>' : '*://*.' + domain + '/*'] }
  }

  const values = key => (metadata && metadata[key]) || []
  const first = (...keys) => keys.map(key => values(key)[0]).find(value => value) || ''
  const language = (locale || '').split('-')[0]
  const localized = key => first(key + ':' + locale, key + ':' + language, key)

  let runAt = 'document-idle'
  if (USERSCRIPT_RUN_AT.includes(first('run-at'))) {
    runAt = first('run-at')
  }

  return {
    id: filename,
    name: localized('name') || filename,
    namespace: first('namespace'),
    version: first('version'),
    description: localized('description'),
    author: first('author'),
    icon: first('icon', 'iconURL', 'defaulticon'),
    homepage: first('homepage', 'homepageURL', 'website', 'source'),
    updateURL: first('updateURL'),
    downloadURL: first('downloadURL'),
    runAt,
    noframes: !!(metadata && metadata.noframes),
    legacy: !metadata,
    grants: metadata ? getUserscriptGrants(metadata.grant, content) : [],
    connects: values('connect').flatMap(value => value.split(/\s+/)).filter(Boolean),
    requires: values('require').filter(Boolean),
    resources: values('resource').map(value => value.match(/^(\S+)\s+(\S+)/)).filter(Boolean).map(parts => ({ name: parts[1], url: parts[2] })),
    antifeatures: values('antifeature').map(value => value.split(/\s+/)[0]).filter(Boolean),
    content,
    rules,
    matcher: compileUserscriptRules(rules)
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseUserscriptMetadata,
    getUserscriptMetadataBlock,
    getUserscriptGrants,
    compileUserscriptMatchPattern,
    compileUserscriptGlob,
    compileUserscriptRules,
    userscriptCanRunOnURL,
    userscriptMatchesURL,
    userscriptCanConnect,
    compareUserscriptVersions,
    userscriptRunsEverywhere,
    getUserscriptPermissionIncrease,
    userscriptPermissionsIncreased,
    compileUserscript
  }
}
