using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;

class Program {
    [DllImport("psapi.dll")]
    static extern int EmptyWorkingSet(IntPtr hwProc);

    static void Main(string[] args) {
        HashSet<int> excludePids = new HashSet<int>();
        List<string> targets = new List<string>();
        int explicitPidsCount = 0;

        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "--exclude" && i + 1 < args.Length) {
                string[] parts = args[++i].Split(new char[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var part in parts) {
                    int pid;
                    if (int.TryParse(part.Trim(), out pid)) {
                        excludePids.Add(pid);
                    }
                }
            } else {
                int explicitPid;
                if (int.TryParse(args[i], out explicitPid)) {
                    explicitPidsCount++;
                    try {
                        var p = Process.GetProcessById(explicitPid);
                        EmptyWorkingSet(p.Handle);
                    } catch {}
                } else {
                    targets.Add(args[i]);
                }
            }
        }

        if (targets.Count == 0 && explicitPidsCount == 0 && excludePids.Count == 0) {
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
