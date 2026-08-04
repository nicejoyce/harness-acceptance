param(
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class HarnessProcessTree
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct ProcessEntry32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static int[] Descendants(int rootProcessId)
    {
        var children = new Dictionary<int, List<int>>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == InvalidHandleValue) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var entry = new ProcessEntry32();
            entry.dwSize = (uint)Marshal.SizeOf(entry);
            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    int parent = unchecked((int)entry.th32ParentProcessID);
                    int process = unchecked((int)entry.th32ProcessID);
                    if (!children.ContainsKey(parent)) children[parent] = new List<int>();
                    children[parent].Add(process);
                }
                while (Process32Next(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }

        var ordered = new List<int>();
        Visit(rootProcessId, children, ordered);
        return ordered.ToArray();
    }

    private static void Visit(int processId, Dictionary<int, List<int>> children, List<int> ordered)
    {
        List<int> direct;
        if (!children.TryGetValue(processId, out direct)) return;
        foreach (int child in direct)
        {
            Visit(child, children, ordered);
            ordered.Add(child);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$result = [HarnessProcessTree]::Descendants($RootProcessId)
ConvertTo-Json -Compress -InputObject @($result)
