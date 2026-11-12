# Keeps the display on while a process runs (run.js passes its own process id), so Windows doesn't turn it off during a
# long run: an idle display counts every page as hidden, like a locked screen (AGENTS.md pitfall 54). It asks Windows
# the way a video player does (SetThreadExecutionState); no setting is changed, and the request ends with this script.
param([int]$WatchPid)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MinKeepDisplayOn {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)
[MinKeepDisplayOn]::SetThreadExecutionState([uint32]2147483651) | Out-Null
while (Get-Process -Id $WatchPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
