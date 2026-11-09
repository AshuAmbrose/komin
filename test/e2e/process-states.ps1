# For every process of a Min build in this repo (electron.exe for the dev build, Min.exe for the package): its kind, priority
# class, Windows "Efficiency mode" (EcoQoS) state and working set. Output: JSON.
# priority: 64 idle, 16384 below normal, 32 normal, 32768 above normal. ecoState 1 = EcoQoS on.
param([string]$Name = "electron.exe", [string]$Root = "")
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ProcessQuery {
    [StructLayout(LayoutKind.Sequential)]
    public struct PowerThrottling { public uint Version; public uint ControlMask; public uint StateMask; }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PowerThrottling info, int size);
    [DllImport("kernel32.dll")]
    public static extern uint GetPriorityClass(IntPtr process);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
"@
$result = @()
Get-CimInstance Win32_Process -Filter "Name='$Name'" | Where-Object { $_.ExecutablePath -like "$Root*" } | ForEach-Object {
    $kind = 'browser'
    if ($_.CommandLine -match '--type=([a-z-]+)') { $kind = $Matches[1] }
    if ($_.CommandLine -match '--extension-process') { $kind = $kind + ':extension' }
    if ($_.CommandLine -match '--utility-sub-type=([A-Za-z.]+)') { $kind = $kind + ':' + $Matches[1] }
    $handle = [ProcessQuery]::OpenProcess(0x1000, $false, $_.ProcessId)
    $info = New-Object ProcessQuery+PowerThrottling
    $info.Version = 1
    $ok = [ProcessQuery]::GetProcessInformation($handle, 4, [ref]$info, 12)
    $priority = [ProcessQuery]::GetPriorityClass($handle)
    [ProcessQuery]::CloseHandle($handle) | Out-Null
    $result += [pscustomobject]@{ pid = $_.ProcessId; kind = $kind; priority = $priority; ecoControl = $info.ControlMask; ecoState = $info.StateMask; queried = $ok; workingSetMB = [math]::Round($_.WorkingSetSize / 1MB) }
}
$result | ConvertTo-Json -Compress
