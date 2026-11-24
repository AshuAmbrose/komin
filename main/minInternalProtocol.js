const { pathToFileURL } = require('url')

// Every page and file Min serves from min:// gets this rule (upstream's 29cb4d31, taken 2026-11-24); most pages add a
// stricter one of their own (a <meta> in their HTML). Suite internal-pages opens each under them.
const defaultCSP = "script-src 'self'; style-src 'self'; object-src 'none'; form-action 'self';"
// The translation service and its Bergamot worker compile WebAssembly, which the rule above refuses (upstream's version
// broke translation: suite internal-pages), so only their files may
const translationCSP = "script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; object-src 'none'; form-action 'self';"

function getInternalPageCSP (relativePath) {
  const file = relativePath.split(path.sep).join('/')
  return file.startsWith('pages/translateService/') || file.startsWith('node_modules/@browsermt/') ? translationCSP : defaultCSP
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'min',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    }
  }
])

function registerBundleProtocol (ses) {
  ses.protocol.handle('min', async (req) => {
    let { host, pathname } = new URL(req.url)

    if (pathname.charAt(0) === '/') {
      pathname = pathname.substring(1)
    }

    if (host !== 'app') {
      return new Response('bad', {
        status: 400,
        headers: { 'content-type': 'text/html' }
      })
    }

    // NB, this checks for paths that escape the bundle, e.g.
    // app://bundle/../../secret_file.txt
    const pathToServe = path.resolve(__dirname, pathname)
    const relativePath = path.relative(__dirname, pathToServe)
    const isSafe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)

    if (!isSafe) {
      return new Response('bad', {
        status: 400,
        headers: { 'content-type': 'text/html' }
      })
    }

    const response = await net.fetch(pathToFileURL(pathToServe).toString())

    const headers = { 'content-security-policy': getInternalPageCSP(relativePath) }
    // a file without a known type keeps none (a null would become the type "null")
    if (response.headers.get('content-type')) {
      headers['content-type'] = response.headers.get('content-type')
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    })
  })
}

app.on('session-created', (ses) => {
  if (ses !== session.defaultSession) {
    registerBundleProtocol(ses)
  }
})
