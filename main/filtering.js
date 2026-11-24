var defaultFilteringSettings = {
  blockingLevel: 1,
  contentTypes: [],
  exceptionDomains: []
}

var enabledFilteringOptions = {
  blockingLevel: 0,
  contentTypes: [], // script, image
  exceptionDomains: []
}

const globalParamsToRemove = [
  // analytics & campaign
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  // microsoft
  'msclkid',
  // google
  'gclid',
  'dclid',
  // facebook
  'fbclid',
  // yandex
  'yclid',
  '_openstat',
  // adobe
  'icid',
  // instagram
  'igshid',
  // mailchimp
  'mc_eid'
]
const siteParamsToRemove = {
  'www.amazon.com': [
    '_ref',
    'ref_',
    'pd_rd_r',
    'pd_rd_w',
    'pf_rd_i',
    'pf_rd_m',
    'pf_rd_p',
    'pf_rd_r',
    'pf_rd_s',
    'pf_rd_t',
    'pd_rd_wg'
  ],
  'www.ebay.com': [
    '_trkparms'
  ]
}

const trackingParamFastRegex = /[?&](?:utm_(?:source|medium|campaign|term|content)|msclkid|[gdy]clid|fbclid|_openstat|icid|igshid|mc_eid|_ref|ref_|p[df]_rd_[rwimspstwg]+|_trkparms)=/i

// for tracking the number of blocked requests
var unsavedBlockedRequests = 0

setInterval(function () {
  if (unsavedBlockedRequests > 0) {
    var current = settings.get('filteringBlockedCount')
    if (!current) {
      current = 0
    }
    settings.set('filteringBlockedCount', current + unsavedBlockedRequests)
    unsavedBlockedRequests = 0
  }
}, 60000)

// electron uses different names for resource types than ABP
// electron: https://github.com/electron/electron/blob/34c4c8d5088fa183f56baea28809de6f2a427e02/shell/browser/net/atom_network_delegate.cc#L30
// abp: https://adblockplus.org/filter-cheatsheet#filter-options
var electronABPElementTypeMap = {
  mainFrame: 'document',
  subFrame: 'subdocument',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  object: 'object',
  xhr: 'xmlhttprequest',
  other: 'other' // ?
}

var parser = require('./ext/abp-filter-parser-modified/abp-filter-parser.js')
var { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron')
// the registrable domain (cnn.com for edition.cnn.com), which the engine needs to pick a site's rules; Ghostery uses it too
var { getDomain: getRegistrableDomain } = require('tldts-experimental')
var parsedFilterData = {}
var adblockerEngine = null
var adblockerEnginePromise = null
var adblockerUpdateTimeout = null
// Two kinds of the lists' rules the main engine can't apply, each in a small engine of its own, built from the lists'
// text as it downloads (js/util/adblockExtraRules.js) and saved next to the engine as text (getExtraRulesCachePath):
// - pop-up rules ($popup): Ghostery's parser refuses the option (about 3,370 rules of Min's lists, 2026-11-14), and it
//   never counts a page request as third-party, which many of them need. Each rule's type options become $other, a type
//   nothing else asks this engine about, and filterPopups asks about the pop-up's address as a request of that type from
//   the opener's page.
// - tracking-parameter rules ($removeparam, 274): the main engine has them, but its optimizer merges the generic ones
//   ($removeparam=gclid, =fbclid, =srsltid...) into one rule that keeps a single parameter name, so most never applied
//   (measured 2026-11-17). This engine is built without optimizations.
var popupRulesEngine = null
var removeparamRulesEngine = null
// Procedural hiding rules (uBlock Origin's :has-text(), :upward(), :remove()..., 567 in Min's lists): the engine keeps them
// only when built with loadExtendedSelectors (since 2026-11-17), and gives a page each one as a parsed selector, which the
// page's preload evaluates with Ghostery's evaluator (js/preload/default.js, applyExtendedRules)
const ADBLOCKER_ENGINE_CONFIG = { loadExtendedSelectors: true }

// the downloaded engine is cached on disk, and refreshed once it's older than this
// (uBlock Origin's YouTube fixes change almost daily)
const ADBLOCKER_ENGINE_MAX_AGE = 2 * 24 * 60 * 60 * 1000
// how long to wait before trying again after a failed download
const ADBLOCKER_RETRY_DELAY = 60 * 60 * 1000

// uBlock Origin's default lists, downloaded from their maintainers.
// Ghostery's built-in presets use a copy of these that has stopped updating and is missing the newer yearly lists.
// uBlock Origin starts a new filters-<year>.txt every year, which needs to be added here.
const UBO_LISTS_URL = 'https://ublockorigin.github.io/uAssets/filters/'
const ADBLOCKER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
  UBO_LISTS_URL + 'filters.txt',
  UBO_LISTS_URL + 'badware.txt',
  UBO_LISTS_URL + 'privacy.txt',
  UBO_LISTS_URL + 'quick-fixes.txt',
  UBO_LISTS_URL + 'resource-abuse.txt',
  UBO_LISTS_URL + 'unbreak.txt'
].concat(['2020', '2021', '2022', '2023', '2024', '2025', '2026'].map(function (year) {
  return UBO_LISTS_URL + 'filters-' + year + '.txt'
}))

function getAdblockerCachePath () {
  return path.join(app.getPath('userData'), 'adblocker-engine-v2.bin')
}

// Electron's net.fetch (Chromium's network code, Min's proxy setting), not Node's fetch: Node 24's undici can throw an
// uncaught assertion while downloading the lists, and Electron then freezes the main process behind an error dialog.
// net.fetch only works once the app is ready, and a new profile's first download starts while main is still loading
// (settings.listen calls back at once), so wait for it.
function fetchAdblockerList (url) {
  return app.whenReady().then(function () {
    return net.fetch(url, { credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(60 * 1000) })
  })
}

function getExtraRulesCachePath () {
  return path.join(app.getPath('userData'), 'adblocker-extra-rules.txt')
}

// getAdblockExtraRules and splitAdblockExtraRules: js/util/adblockExtraRules.js

function setExtraRules (rules) {
  const { popup, removeparam } = splitAdblockExtraRules(rules)
  popupRulesEngine = popup.length > 0 ? ElectronBlocker.parse(popup.join('\n')) : null
  removeparamRulesEngine = removeparam.length > 0 ? ElectronBlocker.parse(removeparam.join('\n'), { enableOptimizations: false }) : null
}

// the request's address without the lists' tracking parameters, or null. A request one of the lists' exceptions
// covers (@@||site^) keeps them, as in the main engine
function removeListedParams (request, mainResult) {
  if (!removeparamRulesEngine) {
    return mainResult && mainResult.rewrite ? mainResult.rewrite.url : null
  }
  const { rewrite } = removeparamRulesEngine.match(request)
  if (!rewrite) {
    return null
  }
  const exceptions = adblockerEngine && adblockerEngine.exceptions
  if (exceptions && typeof exceptions.match === 'function' && exceptions.match(request, adblockerEngine.isFilterExcluded.bind(adblockerEngine))) {
    return null
  }
  return rewrite.url
}

function downloadAdblockerEngine () {
  // the lists' text passes here on its way to the engine, for their pop-up and tracking-parameter rules
  const extraRules = new Map()
  const fetchKeepingExtraRules = function (url) {
    return fetchAdblockerList(url).then(function (response) {
      if (!ADBLOCKER_LISTS.includes(url)) {
        return response
      }
      return response.text().then(function (text) {
        extraRules.set(url, getAdblockExtraRules(text))
        return { text: () => Promise.resolve(text) }
      })
    })
  }
  return ElectronBlocker.fromLists(fetchKeepingExtraRules, ADBLOCKER_LISTS, ADBLOCKER_ENGINE_CONFIG).then(function (engine) {
    adblockerEngine = engine
    const rules = Array.from(extraRules.values()).flat()
    setExtraRules(rules)
    fs.promises.writeFile(getAdblockerCachePath(), Buffer.from(engine.serialize())).catch(function () {})
    fs.promises.writeFile(getExtraRulesCachePath(), rules.join('\n')).catch(function () {})
    scheduleAdblockerUpdate(ADBLOCKER_ENGINE_MAX_AGE)
    return engine
  })
}

function scheduleAdblockerUpdate (delay) {
  clearTimeout(adblockerUpdateTimeout)
  adblockerUpdateTimeout = setTimeout(function () {
    // don't download anything while blocking is turned off, just check again later
    if (!(enabledFilteringOptions.blockingLevel > 0)) {
      scheduleAdblockerUpdate(ADBLOCKER_RETRY_DELAY)
      return
    }
    downloadAdblockerEngine().catch(function (err) {
      console.warn('Failed to update adblocker engine:', err)
      scheduleAdblockerUpdate(ADBLOCKER_RETRY_DELAY)
    })
  }, delay)
}

function loadCachedAdblockerEngine () {
  const cachePath = getAdblockerCachePath()
  const extraRules = fs.promises.readFile(getExtraRulesCachePath(), 'utf8').catch(() => null)
  return Promise.all([fs.promises.readFile(cachePath), fs.promises.stat(cachePath), extraRules]).then(function ([data, stat, extraRulesText]) {
    adblockerEngine = ElectronBlocker.deserialize(new Uint8Array(data))
    if (extraRulesText !== null) {
      setExtraRules(extraRulesText.split('\n').filter(Boolean))
    }
    // keep using the cached copy for now, and refresh it in the background once it's stale (at once, in a minute, for an
    // engine saved before 2026-11-17: no extra rules, no procedural rules)
    const age = Date.now() - stat.mtimeMs
    const older = extraRulesText === null || !(adblockerEngine.config && adblockerEngine.config.loadExtendedSelectors)
    scheduleAdblockerUpdate(older ? 60 * 1000 : Math.max(60 * 1000, ADBLOCKER_ENGINE_MAX_AGE - age))
    return adblockerEngine
  })
}

function loadBundledAdblockerEngine () {
  // offline fallback: build the engine from the copy of EasyList that ships with the app
  return fs.promises.readFile(path.join(__dirname, 'ext/filterLists/easylist+easyprivacy-noelementhiding.txt'), 'utf8').then(function (text) {
    adblockerEngine = ElectronBlocker.parse(text, ADBLOCKER_ENGINE_CONFIG)
    setExtraRules(getAdblockExtraRules(text))
    return adblockerEngine
  })
}

function initFilterList () {
  // discard old data if the list is being re-initialized
  parsedFilterData = {}

  if (!adblockerEngine && !adblockerEnginePromise) {
    // older versions cached an engine built from Ghostery's outdated list copy
    fs.promises.unlink(path.join(app.getPath('userData'), 'adblocker-engine.bin')).catch(function () {})

    adblockerEnginePromise = loadCachedAdblockerEngine()
      .catch(function () {
        return downloadAdblockerEngine()
      })
      .catch(function (err) {
        console.warn('Failed to download adblocker engine, using the bundled filter list:', err)
        scheduleAdblockerUpdate(ADBLOCKER_RETRY_DELAY)
        return loadBundledAdblockerEngine()
      })
      .catch(function (err) {
        console.warn('Failed to initialize adblocker engine:', err)
        adblockerEnginePromise = null
        return null
      })
  }

  fs.readFile(path.join(__dirname, 'ext/filterLists/minFilters.txt'),
    'utf8', function (err, data) {
      if (err) {
        return
      }
      parser.parse(data, parsedFilterData)
    }
  )

  fs.readFile(path.join(app.getPath('userData'), 'customFilters.txt'),
    'utf8', function (err, data) {
      if (!err && data) {
        parser.parse(data, parsedFilterData)
      }
    })
}

function removeWWW (domain) {
  return domain.replace(/^www\./i, '')
}

function requestIsThirdParty (baseDomain, requestURL) {
  baseDomain = removeWWW(baseDomain)
  var requestDomain = removeWWW(parser.getUrlHost(requestURL))

  return !(parser.isSameOriginHost(baseDomain, requestDomain) || parser.isSameOriginHost(requestDomain, baseDomain))
}

function requestDomainIsException (domain) {
  return enabledFilteringOptions.exceptionDomains.includes(removeWWW(domain))
}

// ses: the session of the tab opening the popup; openerURL: its page's address. Rules about the page a pop-up comes from
// ($third-party, domain=) are about the opener: until 2026-11-17 the pop-up's own address stood in for it, so a third-party
// rule of Min's older matcher never applied (suite popups)
function filterPopups (url, ses, openerURL) {
  if (!/^https?:\/\//i.test(url)) {
    return true
  }
  // an extension blocks ads in normal tabs instead (main/extensions.js)
  if (ses && typeof isExtensionNetworkFilteringOn === 'function' && isExtensionNetworkFilteringOn(ses)) {
    return true
  }

  const domain = parser.getUrlHost(url)
  const openerIsWeb = /^https?:\/\//i.test(openerURL || '')
  const openerDomain = openerIsWeb ? parser.getUrlHost(openerURL) : domain
  if (enabledFilteringOptions.blockingLevel > 0 && !requestDomainIsException(domain) && !requestDomainIsException(openerDomain)) {
    if (adblockerEngine) {
      const req = fromElectronDetails({
        id: 0,
        url: url,
        resourceType: 'mainFrame',
        referrer: openerIsWeb ? openerURL : 'https://' + domain
      })
      const { match } = adblockerEngine.match(req)
      if (match) {
        unsavedBlockedRequests++
        return false
      }
    }
    // the lists' $popup rules (popupRulesEngine)
    if (popupRulesEngine && openerIsWeb) {
      const { match } = popupRulesEngine.match(fromElectronDetails({ id: 0, url: url, resourceType: 'other', referrer: openerURL }))
      if (match) {
        unsavedBlockedRequests++
        return false
      }
    }
    if (
      enabledFilteringOptions.blockingLevel === 2 ||
      (enabledFilteringOptions.blockingLevel === 1 && requestIsThirdParty(openerDomain, url))
    ) {
      if (parser.matches(parsedFilterData, url, { domain: openerDomain, elementType: 'popup' })) {
        unsavedBlockedRequests++
        return false
      }
    }
  }

  return true
}

function removeTrackingParams (url) {
  if (!url || !url.includes('?') || !trackingParamFastRegex.test(url)) {
    return url
  }
  try {
    var urlObj = new URL(url)
    const toDelete = []
    for (const [key] of urlObj.searchParams) {
      if (globalParamsToRemove.includes(key) ||
        (siteParamsToRemove[urlObj.hostname] &&
          siteParamsToRemove[urlObj.hostname].includes(key))) {
        toDelete.push(key)
      }
    }
    if (toDelete.length === 0) {
      return url
    }
    for (const key of toDelete) {
      urlObj.searchParams.delete(key)
    }
    return urlObj.toString()
  } catch (e) {
    console.warn(e)
    return url
  }
}

function handleRequest (details, callback) {
  /* eslint-disable standard/no-callback-literal */

  // Fast-path domain extraction via initiator/referrer without synchronous webContents lookup
  let domain
  if (details.initiator) {
    domain = parser.getUrlHost(details.initiator)
  } else if (details.referrer) {
    domain = parser.getUrlHost(details.referrer)
  } else if (details.webContentsId) {
    try {
      const wc = webContents.fromId(details.webContentsId)
      if (wc && !wc.isDestroyed()) {
        domain = parser.getUrlHost(wc.getURL())
      }
    } catch (e) {}
  }

  const isExceptionDomain = domain && requestDomainIsException(domain)

  const filteringOn = enabledFilteringOptions.blockingLevel > 0 && !isExceptionDomain
  let modifiedURL = filteringOn ? removeTrackingParams(details.url) : details.url
  const isWebRequest = details.url.startsWith('http://') || details.url.startsWith('https://')

  // A page's own address loses the lists' tracking parameters too ($removeparam, removeListedParams; ignored until
  // 2026-11-17, suite adblock-network). Pages themselves are never blocked here.
  if (isWebRequest && details.resourceType === 'mainFrame' && filteringOn && adblockerEngine) {
    const request = fromElectronDetails(details.referrer ? details : Object.assign({}, details, { referrer: details.initiator || (domain ? 'https://' + domain : '') }))
    const cleaned = removeListedParams(request, adblockerEngine.match(request))
    if (cleaned) {
      modifiedURL = removeTrackingParams(cleaned)
    }
  }

  if (!isWebRequest || details.resourceType === 'mainFrame') {
    callback({
      cancel: false,
      requestHeaders: details.requestHeaders,
      redirectURL: (modifiedURL !== details.url) ? modifiedURL : undefined
    })
    return
  }

  // block javascript and images if needed

  if (enabledFilteringOptions.contentTypes.length > 0) {
    for (var i = 0; i < enabledFilteringOptions.contentTypes.length; i++) {
      if (details.resourceType === enabledFilteringOptions.contentTypes[i]) {
        callback({
          cancel: true,
          requestHeaders: details.requestHeaders
        })
        return
      }
    }
  }

  if (enabledFilteringOptions.blockingLevel > 0 && !isExceptionDomain) {
    if (adblockerEngine) {
      const request = fromElectronDetails(
        details.referrer ? details : Object.assign({}, details, { referrer: details.initiator || (domain ? 'https://' + domain : '') })
      )
      if (adblockerEngine.config.guessRequestTypeFromUrl === true && request.type === 'other') {
        request.guessTypeOfRequest()
      }
      const result = adblockerEngine.match(request)
      const { redirect, match } = result
      // the lists' tracking parameters ($removeparam), as for pages above; applied below if nothing blocks the request
      if (!redirect && !match) {
        const cleaned = removeListedParams(request, result)
        if (cleaned) {
          modifiedURL = removeTrackingParams(cleaned)
        }
      }
      if (redirect) {
        unsavedBlockedRequests++
        callback({
          cancel: false,
          requestHeaders: details.requestHeaders,
          redirectURL: redirect.dataUrl
        })
        return
      }
      if (match) {
        unsavedBlockedRequests++
        callback({
          cancel: true,
          requestHeaders: details.requestHeaders
        })
        return
      }
    }

    if (
      (enabledFilteringOptions.blockingLevel === 1 && (!domain || requestIsThirdParty(domain, details.url))) ||
      (enabledFilteringOptions.blockingLevel === 2)
    ) {
      var matchesFilters = parser.matches(parsedFilterData, details.url, {
        domain: domain,
        elementType: electronABPElementTypeMap[details.resourceType]
      })
      if (matchesFilters) {
        unsavedBlockedRequests++

        callback({
          cancel: true,
          requestHeaders: details.requestHeaders
        })
        return
      }
    }
  }

  callback({
    cancel: false,
    requestHeaders: details.requestHeaders,
    redirectURL: (modifiedURL !== details.url) ? modifiedURL : undefined
  })
  /* eslint-enable standard/no-callback-literal */
}

function applyFilteringCSPHeaders (details, responseHeaders) {
  if (
    adblockerEngine &&
    enabledFilteringOptions.blockingLevel > 0 &&
    (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') &&
    (details.url.startsWith('http://') || details.url.startsWith('https://'))
  ) {
    const domain = parser.getUrlHost(details.url)
    if (!domain || !requestDomainIsException(domain)) {
      const rawCSP = adblockerEngine.getCSPDirectives(fromElectronDetails(details))
      if (rawCSP !== undefined) {
        const cspHeaderName = 'content-security-policy'
        const policies = rawCSP.split(';').map(csp => csp.trim())
        const headers = Object.assign({}, responseHeaders || {})
        for (const [name, values] of Object.entries(headers)) {
          if (name.toLowerCase() === cspHeaderName) {
            policies.push(...values)
            delete headers[name]
          }
        }
        headers[cspHeaderName] = [policies.join(';')]
        return headers
      }
    }
  }
  return null
}

function setFilteringSettings (settings) {
  if (!settings) {
    settings = {}
  }

  for (var key in defaultFilteringSettings) {
    if (settings[key] === undefined) {
      settings[key] = defaultFilteringSettings[key]
    }
  }

  if (settings.blockingLevel > 0 && !(enabledFilteringOptions.blockingLevel > 0)) { // we're enabling tracker filtering
    initFilterList()
  }

  enabledFilteringOptions.contentTypes = settings.contentTypes
  enabledFilteringOptions.blockingLevel = settings.blockingLevel
  enabledFilteringOptions.exceptionDomains = settings.exceptionDomains.map(d => removeWWW(d))
}

function registerFiltering (ses) {
  ses.webRequest.onBeforeRequest(handleRequest)
}

app.once('ready', function () {
  registerFiltering(session.defaultSession)
})

app.on('session-created', registerFiltering)

settings.listen('filtering', function (value) {
  // migrate from old settings (<v1.9.0)
  if (value && typeof value.trackers === 'boolean') {
    if (value.trackers === true) {
      value.blockingLevel = 2
    } else if (value.trackers === false) {
      value.blockingLevel = 0
    }
    delete value.trackers
    settings.set('filtering', value)
  }

  setFilteringSettings(value)
})

// the domain the engine picks a site's rules by: the registrable domain, not just the hostname without "www.", or rules
// written for cnn.com would never apply on edition.cnn.com (pitfall 52)
function getCosmeticDomain (hostname) {
  return getRegistrableDomain(hostname) || removeWWW(hostname)
}

// an extension blocks ads in normal tabs instead (main/extensions.js)
function extensionFiltersSender (sender) {
  return typeof isExtensionNetworkFilteringOn === 'function' && isExtensionNetworkFilteringOn(sender.session)
}

// Inserts the page's hiding CSS and runs its scriptlets. With scriptsToCaller, returns the scriptlets instead of running
// them, for the page's preload to run before the page's own scripts (getCosmeticsForPageStart, below), and the page's
// procedural rules (extended); with stylesToCaller, returns the CSS instead of inserting it (a frame inside the page:
// insertCSS only reaches a tab's top frame, so the frame's preload inserts it). Returns {active, scriptlets, styles,
// extended}: active false when no hiding applies to the page (an extension's job, or an exception rule).
function injectCosmeticFiltersForSender (engine, sender, url, scriptsToCaller, stylesToCaller) {
  if (!engine || !sender || sender.isDestroyed() || extensionFiltersSender(sender)) {
    return { active: false, scriptlets: null }
  }
  const hostname = parser.getUrlHost(url)
  const { active, styles, scripts, extended } = engine.getCosmeticsFilters({
    domain: getCosmeticDomain(hostname),
    hostname: hostname,
    url: url,
    getBaseRules: true,
    getInjectionRules: true,
    // procedural rules go to the page's preload; none when Min runs them itself (after the engine loaded)
    getExtendedRules: scriptsToCaller === true,
    getRulesFromHostname: true,
    getRulesFromDOM: false
  })
  if (active === false) {
    return { active: false, scriptlets: null }
  }
  const extendedForCaller = scriptsToCaller && Array.isArray(extended) && extended.length > 0 ? extended.map(rule => ({ ast: rule.ast, attribute: rule.attribute || null, directive: rule.directive || null })) : null
  const stylesForCaller = stylesToCaller && styles && styles.length > 0 ? styles : null
  if (styles && styles.length > 0 && !stylesToCaller) {
    sender.insertCSS(styles, { cssOrigin: 'user' }).catch(function () {})
  }
  if (scripts && scripts.length > 0) {
    // each scriptlet bundles its own copy of uBO's helper functions, so run each one in its own scope.
    // Ghostery's onInjectCosmeticFilters runs them as separate top-level scripts instead, where the copies
    // overwrite each other and break the page (e.g. Function.prototype.toString recursing forever on YouTube).
    // scriptletGlobals is still shared between them, as it is in uBO, so they can share one snapshot of the
    // page's native functions instead of wrapping each other's wrappers
    const combined = '(() => {\nconst minScriptletGlobals = {};\n' + scripts.map(function (s) {
      return '((scriptletGlobals) => {\ntry {\n' + s + '\n} catch (e) {}\n})(minScriptletGlobals);'
    }).join('\n') + '\n})();'
    if (scriptsToCaller) {
      return { active: true, scriptlets: combined, styles: stylesForCaller, extended: extendedForCaller }
    }
    sender.executeJavaScript(combined).catch(function () {})
  }
  return { active: true, scriptlets: null, styles: stylesForCaller, extended: extendedForCaller }
}

function cosmeticFiltersApply (event, url) {
  if (enabledFilteringOptions.blockingLevel === 0 || !url) {
    return false
  }
  if (!(url.startsWith('http://') || url.startsWith('https://'))) {
    return false
  }
  const domain = parser.getUrlHost(url)
  if (domain && requestDomainIsException(domain)) {
    return false
  }
  return !!event.sender && !event.sender.isDestroyed()
}

// whether a message came from its tab's top frame
function cosmeticSenderIsTopFrame (event) {
  const mainFrame = event.sender && !event.sender.isDestroyed() && event.sender.mainFrame
  return !!mainFrame && event.processId === mainFrame.processId && event.frameId === mainFrame.routingId
}

// whether hiding applies to the frame a message came from: a tab's top frame, or since 2026-11-17 a frame inside its page,
// unless blocking is off for the page's site (the shield button). Until then frames got no hiding CSS and no scriptlets
// (AdGuard's test pages, uBlock Origin does both; suite adblock-cosmetic)
function cosmeticSenderApplies (event) {
  if (cosmeticSenderIsTopFrame(event)) {
    return true
  }
  const pageURL = event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : ''
  if (!/^https?:\/\//i.test(pageURL)) {
    return false
  }
  const pageDomain = parser.getUrlHost(pageURL)
  return !(pageDomain && requestDomainIsException(pageDomain))
}

// For a page's preload as the page starts: the ad blocker's part of the answer to the frame's one request, page-start
// (main/userscripts.js; sync: the page waits for it, about 1 ms on YouTube). Inserts the hiding CSS and returns
// {scriptlets, dom, whileLoading}: the scriptlets to run now, whether to report the page's classes, ids and links (dom),
// and whether to start that while the page is still arriving (the setting hideAdSpacesWhileLoading, off unless true:
// it costs about 3–5 MB a tab) rather than once it's parsed. null when no hiding applies: not a tab's top frame, not
// http(s), blocking off, or off for this site.
function getCosmeticsForPageStart (event, url) {
  if (!cosmeticSenderApplies(event) || !cosmeticFiltersApply(event, url)) {
    return null
  }
  const topFrame = cosmeticSenderIsTopFrame(event)
  const whileLoading = settings.get('hideAdSpacesWhileLoading') === true
  if (adblockerEngine) {
    // a frame inside the page gets its CSS in the answer (styles), for its preload to insert
    const result = injectCosmeticFiltersForSender(adblockerEngine, event.sender, url, true, !topFrame)
    return { scriptlets: result.scriptlets, dom: result.active, whileLoading, styles: result.styles || null, extended: result.extended || null }
  }
  if (adblockerEnginePromise && topFrame) {
    // the engine is still loading (just after startup): it all comes once it's ready, a round trip later
    adblockerEnginePromise.then(function (engine) {
      if (engine && event.sender && !event.sender.isDestroyed()) {
        injectCosmeticFiltersForSender(engine, event.sender, url)
      }
    })
    return { scriptlets: null, dom: !extensionFiltersSender(event.sender), whileLoading }
  }
  return null
}

// Generic hiding rules. The engine keeps most generic rules (EasyList's ##.ad-slot and the like) in lookups by class, id
// and link, and only returns them for the ones a page has. The page's preload reports those (all of them once the
// document is parsed, then new ones as the page changes; js/preload/default.js), as Ghostery's own content script does,
// and gets the matching rules as CSS.
const COSMETIC_DOM_LIMIT = 5000
function cosmeticDomList (value) {
  return Array.isArray(value) ? value.filter(s => typeof s === 'string' && s.length > 0 && s.length < 1000).slice(0, COSMETIC_DOM_LIMIT) : []
}

ipc.on('cosmetic-filters-dom', function (event, url, found) {
  // a frame's preload reports: the tab's top frame, or a frame inside its page
  if (!adblockerEngine || !found || !cosmeticSenderApplies(event) || !cosmeticFiltersApply(event, url) || extensionFiltersSender(event.sender)) {
    return
  }
  try {
    const hostname = parser.getUrlHost(url)
    const { active, styles } = adblockerEngine.getCosmeticsFilters({
      domain: getCosmeticDomain(hostname),
      hostname: hostname,
      url: url,
      classes: cosmeticDomList(found.classes),
      ids: cosmeticDomList(found.ids),
      hrefs: cosmeticDomList(found.hrefs),
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true
    })
    if (active !== false && styles && styles.length > 0) {
      if (cosmeticSenderIsTopFrame(event)) {
        event.sender.insertCSS(styles, { cssOrigin: 'user' }).catch(function () {})
      } else {
        // only the frame itself can insert into a frame (js/preload/default.js)
        event.reply('cosmetic-filters-css', styles)
      }
    }
  } catch (e) {
    console.warn('generic cosmetic filters failed for ' + url, e)
  }
})
