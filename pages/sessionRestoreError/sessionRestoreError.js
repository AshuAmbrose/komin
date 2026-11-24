var backupLoc = new URLSearchParams(window.location.search).get('backupLoc')

var backupInfoEl = document.getElementById('backup-info')
backupInfoEl.textContent = l('sessionRestoreErrorBackupInfo').replace('%l', backupLoc)
