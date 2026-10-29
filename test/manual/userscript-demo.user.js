// ==UserScript==
// @name         Min userscript demo
// @namespace    min-demo
// @version      1.0
// @description  Shows what user scripts can do, on example.com
// @match        https://example.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// ==/UserScript==

// For trying userscripts by hand: open this file in Min as a file:// URL (file:///D:/path/to/test/manual/userscript-demo.user.js) to see the install page.
// On https://example.com it shows a box that counts your visits (GM_getValue/GM_setValue), styled with GM_addStyle,
// a line fetched from api.github.com (GM_xmlhttpRequest, allowed by @connect), and two commands in the page's right-click menu.

(function () {
  'use strict'

  const visits = GM_getValue('visits', 0) + 1
  GM_setValue('visits', visits)

  GM_addStyle(`
    .min-demo { position: fixed; right: 1em; bottom: 1em; padding: 0.75em 1em; max-width: 22em;
      background: #507ac4; color: white; border-radius: 6px; font: 14px sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3) }
    .min-demo div + div { margin-top: 0.4em; opacity: 0.9 }
  `)

  const box = document.createElement('div')
  box.className = 'min-demo'
  const counter = document.createElement('div')
  counter.textContent = 'User script demo: you have opened this page ' + visits + (visits === 1 ? ' time.' : ' times.')
  const github = document.createElement('div')
  github.textContent = 'Asking GitHub about Min…'
  box.append(counter, github)
  document.body.appendChild(box)

  GM_xmlhttpRequest({
    url: 'https://api.github.com/repos/minbrowser/min',
    responseType: 'json',
    onload: function (response) {
      github.textContent = response.response && response.response.stargazers_count
        ? 'Min has ' + response.response.stargazers_count.toLocaleString() + ' stars on GitHub (fetched with GM_xmlhttpRequest).'
        : 'GitHub answered with status ' + response.status + '.'
    },
    onerror: function (response) {
      github.textContent = 'The request failed: ' + response.error
    }
  })

  GM_registerMenuCommand('Reset the visit counter', function () {
    GM_setValue('visits', 0)
    counter.textContent = 'Visit counter reset. Reload the page to count again.'
  })

  GM_registerMenuCommand('Show a notification', function () {
    GM_notification({ title: 'Min userscript demo', text: 'Hello from a user script!' })
  })
})()
