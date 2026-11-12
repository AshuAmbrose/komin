/* Simple input prompt. */

// each prompt window's options and answer, by its webContents id. One shared pair let two prompts open at once (two
// sites asking to sign in) both show the second one's text, so a password typed for one site went to the other
// (security review B5)
const openPrompts = new Map()

function createPrompt (options, callback) {
  const { parent, width = 360, height = 140 } = options

  var promptWindow = new BrowserWindow({
    width: width,
    height: height,
    parent: parent != null ? parent : windows.getCurrent(),
    show: false,
    modal: true,
    alwaysOnTop: true,
    title: options.title,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      preload:  __dirname + '/pages/prompt/prompt.js'
    }
  })

  const promptId = promptWindow.webContents.id
  openPrompts.set(promptId, { options, answer: undefined })

  promptWindow.on('closed', () => {
    promptWindow = null
    const entry = openPrompts.get(promptId)
    openPrompts.delete(promptId)
    callback(entry ? entry.answer : undefined)
  })

  // Load the HTML dialog box
  promptWindow.loadURL('min://app/pages/prompt/index.html')
  promptWindow.once('ready-to-show', () => { promptWindow.show() })
}

ipc.on('show-prompt', function (options, callback) {
  createPrompt(options, callback)
})

ipc.on('open-prompt', function (event) {
  const entry = openPrompts.get(event.sender.id)
  if (!entry) {
    event.returnValue = JSON.stringify({})
    return
  }
  const promptOptions = entry.options
  event.returnValue = JSON.stringify({
    label: promptOptions.text,
    ok: promptOptions.ok,
    values: promptOptions.values,
    cancel: promptOptions.cancel,
    darkMode: settings.get('darkMode')
  })
})

ipc.on('close-prompt', function (event, data) {
  const entry = openPrompts.get(event.sender.id)
  if (entry) {
    entry.answer = data
  }
})

ipc.on('prompt', function (event, data) {
  createPrompt(data, function (result) {
    event.returnValue = result
  })
})
