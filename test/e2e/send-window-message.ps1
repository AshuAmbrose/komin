# Sends one window message to a window and prints what came back, for checks that need something only Windows sends.
# session-restore.js uses it for WM_QUERYENDSESSION (0x11): the question Windows asks every window before it shuts down,
# restarts or signs out. Sent on its own it ends nothing.
#   -Hwnd: the window's handle as a number (Electron: win.getNativeWindowHandle())   -Msg: the message number
param([long]$Hwnd, [int]$Msg, [long]$WParam = 0, [long]$LParam = 0)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MinWindowMessage {
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
}
'@
$result = [IntPtr]::Zero
# SMTO_ABORTIFHUNG (2), at most 5 s
$sent = [MinWindowMessage]::SendMessageTimeout([IntPtr]$Hwnd, [uint32]$Msg, [IntPtr]$WParam, [IntPtr]$LParam, 2, 5000, [ref]$result)
[pscustomobject]@{ sent = ($sent -ne [IntPtr]::Zero); result = $result.ToInt64() } | ConvertTo-Json -Compress
