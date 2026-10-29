using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;

// Built into ext/windows/trimMemory.exe by scripts/buildTrimMemory.js.
// Usage:
//   trimMemory.exe <pid> [<pid> ...]                           trim these processes' working sets
//   trimMemory.exe <name> [--exclude <pid,pid>]                trim every process with this name, except the excluded pids
//   trimMemory.exe --memory-priority low|normal <pid> ...      trim, and set the memory priority of the listed pids
//   trimMemory.exe --no-trim --memory-priority normal <pid>    only set the memory priority
class Program {
    [DllImport("psapi.dll")]
    static extern int EmptyWorkingSet(IntPtr hwProc);

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORY_PRIORITY_INFORMATION {
        public uint MemoryPriority;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessInformation(IntPtr hProcess, int processInformationClass, ref MEMORY_PRIORITY_INFORMATION info, int size);

    const int ProcessMemoryPriority = 0;
    const uint MEMORY_PRIORITY_LOW = 2;
    const uint MEMORY_PRIORITY_NORMAL = 5;

    // pages a process loads after this get the new priority; Windows reuses low-priority pages first when memory is needed
    static void SetMemoryPriority(Process p, uint priority) {
        var info = new MEMORY_PRIORITY_INFORMATION();
        info.MemoryPriority = priority;
        SetProcessInformation(p.Handle, ProcessMemoryPriority, ref info, Marshal.SizeOf(info));
    }

    static void Main(string[] args) {
        HashSet<int> excludePids = new HashSet<int>();
        List<string> targets = new List<string>();
        List<int> explicitPids = new List<int>();
        bool trim = true;
        uint? memoryPriority = null;

        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--exclude" && i + 1 < args.Length) {
                string[] parts = args[++i].Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in parts) {
                    int pid;
                    if (int.TryParse(part.Trim(), out pid)) {
                        excludePids.Add(pid);
                    }
                }
            } else if (args[i] == "--no-trim") {
                trim = false;
            } else if (args[i] == "--memory-priority" && i + 1 < args.Length) {
                string level = args[++i];
                memoryPriority = level == "low" ? MEMORY_PRIORITY_LOW : (level == "normal" ? MEMORY_PRIORITY_NORMAL : (uint?)null);
            } else {
                int explicitPid;
                if (int.TryParse(args[i], out explicitPid)) {
                    explicitPids.Add(explicitPid);
                } else {
                    targets.Add(args[i]);
                }
            }
        }

        foreach (var pid in explicitPids) {
            try {
                var p = Process.GetProcessById(pid);
                if (memoryPriority.HasValue) {
                    SetMemoryPriority(p, memoryPriority.Value);
                }
                if (trim) {
                    EmptyWorkingSet(p.Handle);
                }
            } catch {}
        }

        if (targets.Count == 0 && explicitPids.Count == 0 && excludePids.Count == 0) {
            targets.Add("Min-Dev");
            targets.Add("min");
        }

        foreach (var target in targets) {
            foreach (var p in Process.GetProcessesByName(target)) {
                if (!excludePids.Contains(p.Id)) {
                    try {
                        EmptyWorkingSet(p.Handle);
                    } catch {}
                }
            }
        }
    }
}
