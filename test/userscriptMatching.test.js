const test = require('node:test')
const assert = require('node:assert')

const {
  parseUserscriptMetadata,
  getUserscriptMetadataBlock,
  getUserscriptGrants,
  compileUserscriptMatchPattern,
  compileUserscriptGlob,
  userscriptMatchesURL,
  userscriptCanConnect,
  compareUserscriptVersions,
  userscriptRunsEverywhere,
  getUserscriptPermissionIncrease,
  userscriptPermissionsIncreased,
  compileUserscript
} = require('../js/util/userscriptMatching.js')

function matchPattern (pattern, url) {
  return compileUserscriptMatchPattern(pattern)(new URL(url))
}

function glob (pattern, url) {
  return compileUserscriptGlob(pattern)(new URL(url))
}

function scriptRunsOn (content, url, filename = 'test.user.js') {
  return userscriptMatchesURL(compileUserscript(filename, content).matcher, url)
}

function header (lines) {
  return '// ==UserScript==\n' + lines.map(line => '// ' + line).join('\n') + '\n// ==/UserScript==\nconsole.log(1)\n'
}

test('metadata: parses repeated keys, flags, tabs and CRLF', function () {
  const metadata = parseUserscriptMetadata('// ==UserScript==\r\n// @name\tMy  script \r\n// @match https://a.com/*\r\n//@match https://b.com/*\r\n// @noframes\r\n// ==/UserScript==\r\n// @match https://after.com/*\r\n')
  assert.deepStrictEqual(metadata, {
    name: ['My  script'],
    match: ['https://a.com/*', 'https://b.com/*'],
    noframes: ['']
  })
})

test('metadata: none, or an empty block, means a legacy script', function () {
  assert.strictEqual(parseUserscriptMetadata('console.log(1)'), null)
  assert.strictEqual(parseUserscriptMetadata('// ==UserScript==\n// ==/UserScript==\n'), null)
})

test('match pattern: scheme', function () {
  assert.strictEqual(matchPattern('*://example.com/*', 'http://example.com/'), true)
  assert.strictEqual(matchPattern('*://example.com/*', 'https://example.com/'), true)
  assert.strictEqual(matchPattern('*://example.com/*', 'file:///example.com/'), false)
  assert.strictEqual(matchPattern('https://example.com/*', 'http://example.com/'), false)
  assert.strictEqual(matchPattern('http*://example.com/*', 'https://example.com/a'), true)
  assert.strictEqual(matchPattern('file:///*', 'file:///C:/notes.txt'), true)
})

test('match pattern: host', function () {
  assert.strictEqual(matchPattern('*://*.example.com/*', 'https://example.com/'), true)
  assert.strictEqual(matchPattern('*://*.example.com/*', 'https://a.b.example.com/'), true)
  assert.strictEqual(matchPattern('*://*.example.com/*', 'https://notexample.com/'), false)
  assert.strictEqual(matchPattern('*://*.example.com/*', 'https://example.com.evil.net/'), false)
  assert.strictEqual(matchPattern('*://example.com/*', 'https://www.example.com/'), false)
  assert.strictEqual(matchPattern('*://EXAMPLE.com/*', 'https://example.COM/'), true)
  assert.strictEqual(matchPattern('*://*/*', 'https://anything.org/x'), true)
})

test('match pattern: the host must be the URL host, not text elsewhere in the URL', function () {
  // the old matcher only looked for the pattern's pieces anywhere in the URL
  assert.strictEqual(matchPattern('*://example.com/*', 'https://evil.net/?next=https://example.com/'), false)
  assert.strictEqual(matchPattern('*://example.com/*', 'https://example.com@evil.net/'), false)
})

test('match pattern: port', function () {
  assert.strictEqual(matchPattern('http://localhost/*', 'http://localhost:8080/'), true)
  assert.strictEqual(matchPattern('http://localhost:8080/*', 'http://localhost:8080/'), true)
  assert.strictEqual(matchPattern('http://localhost:8080/*', 'http://localhost:9000/'), false)
  assert.strictEqual(matchPattern('http://localhost:80/*', 'http://localhost/'), true)
  assert.strictEqual(matchPattern('http://localhost:*/*', 'http://localhost:1234/'), true)
})

test('match pattern: path includes the query, not the fragment', function () {
  assert.strictEqual(matchPattern('https://example.com/watch*', 'https://example.com/watch?v=1'), true)
  assert.strictEqual(matchPattern('https://example.com/a', 'https://example.com/a#top'), true)
  assert.strictEqual(matchPattern('https://example.com/a', 'https://example.com/a/b'), false)
  assert.strictEqual(matchPattern('https://example.com/*.png', 'https://example.com/i/x.png'), true)
  assert.strictEqual(matchPattern('https://example.com/a.b', 'https://example.com/aXb'), false)
  assert.strictEqual(matchPattern('https://example.com', 'https://example.com/any/path'), true)
})

test('match pattern: <all_urls>, and invalid patterns are rejected', function () {
  assert.strictEqual(matchPattern('<all_urls>', 'https://a.com/'), true)
  assert.strictEqual(matchPattern('<all_urls>', 'min://app/index.html'), false)
  assert.strictEqual(compileUserscriptMatchPattern('https://exa*mple.com/*'), null)
  assert.strictEqual(compileUserscriptMatchPattern('https:///*'), null)
  assert.strictEqual(compileUserscriptMatchPattern('example.com'), null)
})

test('include glob: wildcards and case', function () {
  assert.strictEqual(glob('*', 'https://a.com/'), true)
  assert.strictEqual(glob('https://*.example.com/*', 'https://www.example.com/page'), true)
  assert.strictEqual(glob('https://example.com/*', 'HTTPS://EXAMPLE.COM/x'), true)
  assert.strictEqual(glob('https://example.com', 'https://example.com/'), false)
  assert.strictEqual(glob('https://example.com/a?b', 'https://example.com/a?b'), true)
  assert.strictEqual(glob('https://example.com/a?b', 'https://example.com/ab'), false)
})

test('include glob: .tld', function () {
  assert.strictEqual(glob('*://*.google.tld/*', 'https://www.google.com/'), true)
  assert.strictEqual(glob('*://*.google.tld/*', 'https://www.google.co.uk/search'), true)
  assert.strictEqual(glob('*://*.google.tld/*', 'https://www.google.de/'), true)
  assert.strictEqual(glob('*://*.google.tld/*', 'https://www.google.evil.com/'), false)
})

test('include: regular expressions', function () {
  assert.strictEqual(glob('/^https:\\/\\/example\\.com\\/\\d+$/', 'https://example.com/42'), true)
  assert.strictEqual(glob('/^https:\\/\\/example\\.com\\/\\d+$/', 'https://example.com/x'), false)
  assert.strictEqual(glob('/EXAMPLE/i', 'https://example.com/'), true)
  assert.strictEqual(compileUserscriptGlob('/(/'), null)
})

test('script: @match, @include, @exclude and @exclude-match together', function () {
  const script = header([
    '@match https://example.com/*',
    '@include https://other.org/*',
    '@exclude https://example.com/private/*',
    '@exclude-match https://example.com/admin*'
  ])
  assert.strictEqual(scriptRunsOn(script, 'https://example.com/'), true)
  assert.strictEqual(scriptRunsOn(script, 'https://other.org/x'), true)
  assert.strictEqual(scriptRunsOn(script, 'https://example.com/private/1'), false)
  assert.strictEqual(scriptRunsOn(script, 'https://example.com/admin/users'), false)
  assert.strictEqual(scriptRunsOn(script, 'https://unrelated.net/'), false)
})

test('script: without @match or @include it runs everywhere, but only on http, https and file', function () {
  const script = header(['@name Everywhere'])
  assert.strictEqual(scriptRunsOn(script, 'https://a.com/'), true)
  assert.strictEqual(scriptRunsOn(script, 'file:///C:/a.html'), true)
  assert.strictEqual(scriptRunsOn(script, 'min://app/pages/settings/index.html'), false)
  assert.strictEqual(scriptRunsOn(script, 'about:blank'), false)
  assert.strictEqual(scriptRunsOn(script, 'not a url'), false)
})

test('script: if every @match is invalid it runs nowhere', function () {
  assert.strictEqual(scriptRunsOn(header(['@match not-a-pattern']), 'https://a.com/'), false)
})

test('script: name, localized name, run-at and noframes', function () {
  const script = compileUserscript('a.user.js', header(['@name Hello', '@name:de Hallo', '@run-at document-start', '@noframes']), 'de-DE')
  assert.strictEqual(script.name, 'Hallo')
  assert.strictEqual(script.runAt, 'document-start')
  assert.strictEqual(script.noframes, true)
  assert.strictEqual(script.legacy, false)

  const defaults = compileUserscript('b.user.js', header(['@run-at sometime']), 'en-US')
  assert.strictEqual(defaults.name, 'b.user.js')
  assert.strictEqual(defaults.runAt, 'document-idle')
  assert.strictEqual(defaults.noframes, false)
})

test('legacy scripts: domain-named files and global.js', function () {
  assert.strictEqual(scriptRunsOn('alert(1)', 'https://example.com/', 'example.com.js'), true)
  assert.strictEqual(scriptRunsOn('alert(1)', 'https://www.example.com/', 'www.example.com.js'), true)
  assert.strictEqual(scriptRunsOn('alert(1)', 'https://example.com.evil.net/', 'example.com.js'), false)
  assert.strictEqual(scriptRunsOn('alert(1)', 'https://other.com/', 'example.com.js'), false)
  assert.strictEqual(scriptRunsOn('alert(1)', 'https://anything.net/', 'global.js'), true)
  assert.strictEqual(compileUserscript('example.com.js', 'alert(1)').legacy, true)
  assert.strictEqual(compileUserscript('.js', 'alert(1)'), null)
})

test('grants: GM_ and GM. names, none, unknown, and detection without @grant', function () {
  assert.deepStrictEqual(getUserscriptGrants(['GM_getValue', 'GM.setValue', 'GM.xmlHttpRequest', 'GM_getResourceURL', 'GM.getResourceUrl', 'GM_info', 'unsafeWindow', 'window.close', 'none'], ''), ['getResourceURL', 'getValue', 'setValue', 'xmlhttpRequest'])
  assert.deepStrictEqual(getUserscriptGrants(['none'], 'GM_setValue(1)'), [])
  assert.deepStrictEqual(getUserscriptGrants(undefined, 'GM_addStyle("a"); await GM.getValue("b"); GM_info.script; myGM_fake()'), ['addStyle', 'getValue'])
})

test('script: metadata for GM_info, updates and the install page', function () {
  const content = header([
    '@name Demo',
    '@namespace https://example.com',
    '@version 1.2.3',
    '@description Does things',
    '@description:fr Fait des choses',
    '@author Someone',
    '@grant GM_xmlhttpRequest',
    '@connect api.example.com',
    '@connect  cdn.example.net other.org',
    '@require https://cdn.example.com/lib.js#sha256=abc',
    '@resource logo https://example.com/logo.png',
    '@resource broken',
    '@updateURL https://example.com/demo.meta.js',
    '@downloadURL https://example.com/demo.user.js',
    '@antifeature ads Shows ads'
  ])
  const script = compileUserscript('demo.user.js', content, 'fr-FR')
  assert.strictEqual(script.namespace, 'https://example.com')
  assert.strictEqual(script.version, '1.2.3')
  assert.strictEqual(script.description, 'Fait des choses')
  assert.strictEqual(script.author, 'Someone')
  assert.deepStrictEqual(script.grants, ['xmlhttpRequest'])
  assert.deepStrictEqual(script.connects, ['api.example.com', 'cdn.example.net', 'other.org'])
  assert.deepStrictEqual(script.requires, ['https://cdn.example.com/lib.js#sha256=abc'])
  assert.deepStrictEqual(script.resources, [{ name: 'logo', url: 'https://example.com/logo.png' }])
  assert.strictEqual(script.updateURL, 'https://example.com/demo.meta.js')
  assert.strictEqual(script.downloadURL, 'https://example.com/demo.user.js')
  assert.deepStrictEqual(script.antifeatures, ['ads'])
  assert.ok(getUserscriptMetadataBlock(content).startsWith('// ==UserScript==\n// @name Demo'))
  assert.ok(getUserscriptMetadataBlock(content).endsWith('// ==/UserScript=='))
  assert.deepStrictEqual(compileUserscript('legacy.com.js', 'GM_setValue(1)').grants, [])
})

test('connect: listed domains and their subdomains, the page host, self and *', function () {
  assert.strictEqual(userscriptCanConnect(['example.com'], 'example.com', 'page.org'), true)
  assert.strictEqual(userscriptCanConnect(['example.com'], 'api.example.com', 'page.org'), true)
  assert.strictEqual(userscriptCanConnect(['*.example.com'], 'api.example.com', 'page.org'), true)
  assert.strictEqual(userscriptCanConnect(['example.com'], 'badexample.com', 'page.org'), false)
  assert.strictEqual(userscriptCanConnect(['example.com'], 'example.com.evil.net', 'page.org'), false)
  assert.strictEqual(userscriptCanConnect([], 'page.org', 'page.org'), true)
  assert.strictEqual(userscriptCanConnect([], 'other.org', 'page.org'), false)
  assert.strictEqual(userscriptCanConnect(['self'], 'other.org', 'page.org'), false)
  assert.strictEqual(userscriptCanConnect(['localhost'], 'localhost', ''), true)
  assert.strictEqual(userscriptCanConnect(['*'], 'anything.net', 'page.org'), true)
  assert.strictEqual(userscriptCanConnect(['Example.COM'], 'EXAMPLE.com', 'page.org'), true)
})

test('versions: numeric parts, missing parts, pre-releases', function () {
  assert.strictEqual(compareUserscriptVersions('1.10', '1.9'), 1)
  assert.strictEqual(compareUserscriptVersions('1.0', '1'), 0)
  assert.strictEqual(compareUserscriptVersions('1.0.1', '1.0'), 1)
  assert.strictEqual(compareUserscriptVersions('2024.5.1', '2024.12.1'), -1)
  assert.strictEqual(compareUserscriptVersions('1.0b', '1.0'), -1)
  assert.strictEqual(compareUserscriptVersions('1.0b2', '1.0b1'), 1)
  assert.strictEqual(compareUserscriptVersions('', '0.1'), -1)
  assert.strictEqual(compareUserscriptVersions(' 3.1 ', '3.1'), 0)
})

test('updates: only more sites, domains or APIs need approval', function () {
  const script = lines => compileUserscript('a.user.js', header(lines))
  const old = script(['@match https://a.com/*', '@grant GM_getValue', '@connect api.a.com'])

  assert.strictEqual(userscriptPermissionsIncreased(getUserscriptPermissionIncrease(old, script(['@match https://a.com/*', '@grant GM_getValue', '@connect api.a.com']))), false)
  assert.strictEqual(userscriptPermissionsIncreased(getUserscriptPermissionIncrease(old, script(['@match https://a.com/*']))), false)
  assert.deepStrictEqual(getUserscriptPermissionIncrease(old, script(['@match https://a.com/*', '@match https://b.com/*', '@grant GM_getValue', '@connect api.a.com'])).sites, ['https://b.com/*'])
  assert.deepStrictEqual(getUserscriptPermissionIncrease(old, script(['@match https://a.com/*', '@grant GM_getValue', '@grant GM_xmlhttpRequest', '@connect api.a.com'])).grants, ['xmlhttpRequest'])
  assert.deepStrictEqual(getUserscriptPermissionIncrease(old, script(['@match https://a.com/*', '@grant GM_getValue', '@connect *'])).connects, ['*'])
  assert.deepStrictEqual(getUserscriptPermissionIncrease(old, script(['@grant GM_getValue', '@connect api.a.com'])).sites, ['*'])

  const everywhere = script(['@match *://*/*'])
  assert.strictEqual(userscriptRunsEverywhere(everywhere.rules), true)
  assert.strictEqual(userscriptRunsEverywhere(old.rules), false)
  assert.deepStrictEqual(getUserscriptPermissionIncrease(everywhere, script(['@match https://b.com/*'])).sites, [])
})
