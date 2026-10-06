const fs = require('fs')
const path = require('path')
const archiver = require('archiver')
const builder = require('electron-builder')
const Arch = builder.Arch

const packageFile = require('./../package.json')
const version = packageFile.version

const createPackage = require('./createPackage.js')

const args = process.argv.slice(2)
const isDev = args.includes('--dev')
const archArg = args.find(arg => arg.startsWith('--arch='))
const targetArchName = archArg ? archArg.split('=')[1] : null

async function afterPackageBuilt (packagePath) {
  /* create output directory if it doesn't exist */
  if (!fs.existsSync('dist/app')) {
    fs.mkdirSync('dist/app')
  }

  let archSuffix

  if (packagePath.includes('ia32')) {
    archSuffix = '-ia32'
  } else if (packagePath.includes('arm64')) {
    archSuffix = '-arm64'
  } else {
    archSuffix = ''
  }

  const appTitle = isDev ? 'Min-Dev' : 'Min'
  const appDisplayName = isDev ? 'Min Dev' : 'Min'
  const appPackageName = isDev ? 'min-dev' : 'min'
  const appExeName = isDev ? 'Min-Dev.exe' : 'Min.exe'

  /* create zip files */
  const zipName = `${appTitle}-v${version}-windows${archSuffix}.zip`
  var output = fs.createWriteStream(path.join('dist/app', zipName))
  var archive = archiver('zip', {
    zlib: { level: 9 }
  })
  archive.directory(packagePath, `${appTitle}-v${version}`)
  archive.pipe(output)
  await archive.finalize()

  /* create installer */
  const installer = require('electron-installer-windows')

  const installerDest = path.join('dist/app', (isDev ? 'min-dev-installer' : 'min-installer') + archSuffix)

  if (fs.existsSync(installerDest)) {
    fs.rmSync(installerDest, { recursive: true, force: true })
  }

  const options = {
    src: packagePath,
    dest: installerDest,
    icon: 'icons/icon256.ico',
    animation: 'icons/windows-installer.gif',
    licenseUrl: 'https://github.com/minbrowser/min/blob/master/LICENSE.txt',
    noMsi: true,
    ...(isDev ? {
      name: appPackageName,
      productName: appDisplayName,
      exe: appExeName
    } : {})
  }

  console.log('Creating package (this may take a while)')

  fs.copyFileSync('LICENSE.txt', path.join(packagePath, 'LICENSE'))

  await installer(options)
    .then(function () {
      const files = fs.readdirSync(installerDest)
      const setupExe = files.find(f => f.endsWith('-setup.exe'))
      if (setupExe) {
        const destInstaller = path.join('dist/app', `${appPackageName}-${version}${archSuffix}-setup.exe`)
        fs.renameSync(path.join(installerDest, setupExe), destInstaller)
        console.log(`Installer successfully created at ${destInstaller}`)
      } else {
        console.warn(`Could not find setup exe in ${installerDest}.`)
      }
    })
    .catch(err => {
      console.error(err, err.stack)
      process.exit(1)
    })
}

const archesToBuild = []

if (targetArchName) {
  switch (targetArchName) {
    case 'x64':
      archesToBuild.push(Arch.x64)
      break
    case 'ia32':
      archesToBuild.push(Arch.ia32)
      break
    case 'arm64':
      archesToBuild.push(Arch.arm64)
      break
    default:
      console.error(`Unknown arch: ${targetArchName}`)
      process.exit(1)
  }
} else if (isDev) {
  // For development builds, only build x64 by default
  archesToBuild.push(Arch.x64)
} else {
  // creating multiple packages simultaneously causes errors in electron-rebuild, so do one arch at a time instead
  archesToBuild.push(Arch.x64, Arch.ia32, Arch.arm64)
}

;(async () => {
  for (const arch of archesToBuild) {
    const unpackedDir = createPackage.toPath('win32', arch)
    if (unpackedDir && fs.existsSync(unpackedDir)) {
      console.log(`Cleaning previous unpacked directory: ${unpackedDir}`)
      fs.rmSync(unpackedDir, { recursive: true, force: true })
    }

    const packageOptions = isDev ? {
      productName: 'Min-Dev',
      extraMetadata: {
        name: 'min-dev',
        productName: 'Min Dev'
      }
    } : {}

    console.log(`Packaging win32 ${Arch[arch] || arch}...`)
    const packagePath = await createPackage('win32', { arch: arch, packageOptions: packageOptions })
    await afterPackageBuilt(packagePath)
  }
})()
