/* send bookmarks data.  */

function isVisible (el) {
  // https://github.com/jquery/jquery/blob/305f193aa57014dc7d8fa0739a3fefd47166cd44/src/css/hiddenVisibleSelectors.js
  return el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)
}

function extractPageText (doc, win) {
  if (!doc || !doc.body) {
    return ''
  }
  var maybeNodes = []
  var initialChildren = doc.body.childNodes
  for (var k = initialChildren.length - 1; k >= 0; k--) {
    maybeNodes.push(initialChildren[k])
  }
  var textNodes = []

  var ignore = 'link, style, script, noscript, .hidden, .visually-hidden, .visuallyhidden, [role=presentation], [hidden], [style*="display:none"], [style*="display: none"], .ad, .dialog, .modal, select, svg, details:not([open]), header, nav, footer'

  while (maybeNodes.length) {
    var node = maybeNodes.pop()

    // if the node should be ignored, skip it and all of it's child nodes
    if (node.matches && node.matches(ignore)) {
      continue
    }

    // if the node is a text node, add it to the list of text nodes

    if (node.nodeType === 3) {
      textNodes.push(node)
      continue
    }

    if (!isVisible(node)) {
      continue
    }

    // otherwise, add the node's text nodes to the list of text, and the other child nodes to the list of nodes to check
    var childNodes = node.childNodes
    var cnl = childNodes.length

    for (var i = cnl - 1; i >= 0; i--) {
      maybeNodes.push(childNodes[i])
    }
  }

  var text = ''

  var tnl = textNodes.length

  // combine the text of all of the accepted text nodes together
  for (var j = 0; j < tnl; j++) {
    text += textNodes[j].textContent + ' '
  }

  // special meta tags

  var mt = doc.head ? doc.head.querySelector('meta[name=description]') : null

  if (mt) {
    text += ' ' + mt.content
  }

  text = text.trim()

  text = text.replace(/[\n\t]/g, ' ') // remove useless newlines/tabs that increase filesize

  text = text.replace(/\s{2,}/g, ' ') // collapse multiple spaces into one
  return text
}

function getPageData (cb) {
  var runExtraction = function () {
    var text = extractPageText(document, window)

    // try to also extract text for same-origin iframes (such as the reader mode frame)

    var frames = document.querySelectorAll('iframe')

    for (var x = 0; x < frames.length; x++) {
      try {
        text += '. ' + extractPageText(frames[x].contentDocument, frames[x].contentWindow)
      } catch (e) {}
    }

    // limit the amount of text that is collected

    text = text.substring(0, 300000)

    cb({
      extractedText: text
    })
  }

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(runExtraction, { timeout: 2000 })
  } else {
    requestAnimationFrame(runExtraction)
  }
}

// send the data when the page loads
if (process.isMainFrame) {
  window.addEventListener('load', function (e) {
    setTimeout(function () {
      getPageData(function (data) {
        ipc.send('pageData', data)
      })
    }, 500)
  })

  setTimeout(function () {
    // https://stackoverflow.com/a/52809105
    electron.webFrame.executeJavaScript(`
      history.pushState = ( f => function pushState(){
        var ret = f.apply(this, arguments);
        window.postMessage('_minInternalLocationChange', '*')
        return ret;
    })(history.pushState);
    
    history.replaceState = ( f => function replaceState(){
        var ret = f.apply(this, arguments);
        window.postMessage('_minInternalLocationReplacement', '*')
        return ret;
    })(history.replaceState);
  `)
  }, 0)

  window.addEventListener('message', function (e) {
    if (e.data === '_minInternalLocationChange') {
      setTimeout(function () {
        getPageData(function (data) {
          ipc.send('pageData', data)
        })
      }, 500)
    }
  })
}
