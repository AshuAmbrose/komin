# Is the display likely off? (AGENTS.md pitfall 54) Chromium counts every page as hidden while it is, like a locked screen.
# Windows turns the display off after a time without keyboard or mouse input (Min's own windows don't count as input).
# Prints JSON: seconds since the last input, the display timeout for the current power source (0 = never), and whether
# the first is past the second. The harness records it in every result file (display).
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class MinIdle {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static double Seconds() { var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i); GetLastInputInfo(ref i); return ((uint)Environment.TickCount - i.dwTime) / 1000.0; }
}
'@
$idle = [math]::Round([MinIdle]::Seconds())
$onMains = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline'
$label = if ($onMains) { 'Current AC Power Setting Index' } else { 'Current DC Power Setting Index' }
$line = powercfg /query SCHEME_CURRENT SUB_VIDEO VIDEOIDLE | Select-String $label
$timeout = if ($line) { [Convert]::ToInt32(($line.ToString() -split ':')[-1].Trim(), 16) } else { -1 }
$likelyOff = $timeout -gt 0 -and $idle -ge $timeout
[pscustomobject]@{ secondsSinceInput = $idle; offAfterSeconds = $timeout; onMains = $onMains; likelyOff = $likelyOff } | ConvertTo-Json -Compress
