# A plain window that covers other windows, for covered-window.js: like a game or another program in front of Min.
#   -Mode full: every monitor.   -Mode rect -X -Y -W -H: that rectangle, in physical screen pixels.
# Closes itself after -Seconds (the suite usually closes it sooner). Prints "shown" once it's on screen.
param([string]$Mode = 'full', [int]$Seconds = 10, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0)
# physical pixels, so a rectangle from Electron's screen.dipToScreenRect lands where it should at any display scaling
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CoverDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[CoverDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(40, 44, 52)
if ($Mode -eq 'rect') {
  $form.Bounds = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
} else {
  $form.Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $Seconds) * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
$form.Add_Shown({ [Console]::Out.WriteLine('shown'); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($form)
