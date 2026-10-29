/*
Rebuilds ext/windows/trimMemory.exe from scripts/trimMemory.cs, using the C# compiler that ships with Windows (.NET Framework 4).
It is built as a windowed app (/target:winexe) so starting it doesn't also start a console host process.
Run with: node scripts/buildTrimMemory.js
*/

const { execFileSync } = require('child_process')
const path = require('path')
const fs = require('fs')

if (process.platform !== 'win32') {
  console.log('trimMemory.exe is Windows-only, skipping')
  process.exit(0)
}

const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
if (!fs.existsSync(csc)) {
  console.error('C# compiler not found at ' + csc)
  process.exit(1)
}

const outFile = path.join(__dirname, '../ext/windows/trimMemory.exe')
execFileSync(csc, ['/nologo', '/optimize+', '/target:winexe', '/platform:anycpu', '/out:' + outFile, path.join(__dirname, 'trimMemory.cs')], { stdio: 'inherit' })
console.log('built ' + outFile)
