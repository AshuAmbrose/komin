const test = require('node:test')
const assert = require('node:assert')

const { getAdblockExtraRules, splitAdblockExtraRules } = require('../js/util/adblockExtraRules.js')

test('pop-up rules: type options become $other, other options stay', function () {
  assert.deepStrictEqual(getAdblockExtraRules([
    '||evilsite.com^$popup',
    '||affforce.com^$doc,popup',
    '&fp_sid=pop$popup,third-party',
    '||ads.example^$popup,domain=news.example|blog.example',
    '@@||ok.example^$popup'
  ].join('\n')), [
    '||evilsite.com^$other',
    '||affforce.com^$other',
    '&fp_sid=pop$third-party,other',
    '||ads.example^$domain=news.example|blog.example,other',
    '@@||ok.example^$other'
  ])
})

test('tracking-parameter rules are kept as they are', function () {
  assert.deepStrictEqual(getAdblockExtraRules('$removeparam=gclid\n||reddit.com^$document,removeparam=ref\n@@||site.example^$removeparam'), [
    '$removeparam=gclid',
    '||reddit.com^$document,removeparam=ref',
    '@@||site.example^$removeparam'
  ])
})

test('everything else is left out: other network rules, hiding rules, comments, ~popup', function () {
  assert.deepStrictEqual(getAdblockExtraRules([
    '! a comment',
    '[Adblock Plus 2.0]',
    '||ads.example^$script',
    'example.com##.ad',
    'example.com#@#.ad',
    'example.com#$#body { overflow: auto }',
    '||ads.example^$~popup',
    '',
    '$popup'
  ].join('\r\n')), [])
})

test('the two kinds apart again', function () {
  const rules = getAdblockExtraRules('||evilsite.com^$popup\n$removeparam=fbclid')
  assert.deepStrictEqual(splitAdblockExtraRules(rules), { popup: ['||evilsite.com^$other'], removeparam: ['$removeparam=fbclid'] })
})
