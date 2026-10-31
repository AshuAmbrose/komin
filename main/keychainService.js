/* Uses Electron's safeStorage to encrypt a password file - encryption key gets stored in the system keychain */

const safeStorage = require('electron').safeStorage
const passwordFilePath = path.join(userDataPath, 'passwordStore')

/*
file format:
{
  version: 1,
  credentials: [
    {
      domain:,
      username:,
      password:
    }
  ]
}
*/

/*
safeStorage's async methods (the sync ones are deprecated in Electron 45 and go away in 46).
Files written with the old encryptString can still be read with decryptStringAsync.
Because reading and writing are now async, changes run one at a time so they don't overwrite each other.
*/
let passwordFileQueue = Promise.resolve()

function queuePasswordFileOperation (operation) {
  const result = passwordFileQueue.then(operation)
  passwordFileQueue = result.catch(function () {})
  return result
}

async function readSavedPasswordFile () {
  let file
  try {
    file = fs.readFileSync(passwordFilePath)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(e)
      throw new Error(e)
    }
  }
  if (file) {
    const decrypted = await safeStorage.decryptStringAsync(file)
    const content = JSON.parse(decrypted.result)
    // the key changed (rotated, or a stronger one is available), so save it again with the new one
    if (decrypted.shouldReEncrypt) {
      await writeSavedPasswordFile(content)
    }
    return content
  } else {
    return {
      version: 1,
      credentials: []
    }
  }
}

async function writeSavedPasswordFile (content) {
  fs.writeFileSync(passwordFilePath, await safeStorage.encryptStringAsync(JSON.stringify(content)))
}

async function credentialStoreSetPasswordBulk (accounts) {
  const fileContent = await readSavedPasswordFile()

  fileContent.credentials = accounts
  await writeSavedPasswordFile(fileContent)
}

async function credentialStoreSetPassword (account) {
  const fileContent = await readSavedPasswordFile()

  // delete duplicate credentials
  for (let i = 0; i < fileContent.credentials.length; i++) {
    if (fileContent.credentials[i].domain === account.domain && fileContent.credentials[i].username === account.username) {
      fileContent.credentials.splice(i, 1)
      i--
    }
  }

  fileContent.credentials.push(account)
  await writeSavedPasswordFile(fileContent)
}

ipc.handle('credentialStoreSetPasswordBulk', async function (event, accounts) {
  return queuePasswordFileOperation(() => credentialStoreSetPasswordBulk(accounts))
})

ipc.handle('credentialStoreSetPassword', async function (event, account) {
  return queuePasswordFileOperation(() => credentialStoreSetPassword(account))
})

ipc.handle('credentialStoreDeletePassword', async function (event, account) {
  return queuePasswordFileOperation(async function () {
    const fileContent = await readSavedPasswordFile()

    // delete matching credentials
    for (let i = 0; i < fileContent.credentials.length; i++) {
      if (fileContent.credentials[i].domain === account.domain && fileContent.credentials[i].username === account.username) {
        fileContent.credentials.splice(i, 1)
        i--
      }
    }

    return writeSavedPasswordFile(fileContent)
  })
})

ipc.handle('credentialStoreGetCredentials', async function () {
  return queuePasswordFileOperation(async () => (await readSavedPasswordFile()).credentials)
})
