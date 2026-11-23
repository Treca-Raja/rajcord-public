using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class RajcordAudioWaitChain
{
    // The WCT lock union includes WCHAR[128], LARGE_INTEGER and BOOL.
    [StructLayout(LayoutKind.Explicit, Size = 280)]
    private struct NativeNode
    {
        [FieldOffset(0)] public int Type;
        [FieldOffset(4)] public int Status;
        [FieldOffset(8)] public int ProcessId;
        [FieldOffset(12)] public int ThreadId;
    }

    public sealed class Node
    {
        public int Type { get; set; }
        public int Status { get; set; }
        public int? ProcessId { get; set; }
        public int? ThreadId { get; set; }
    }

    public sealed class Result
    {
        public int ThreadId { get; set; }
        public int Error { get; set; }
        public bool Cycle { get; set; }
        public Node[] Nodes { get; set; }
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr OpenThreadWaitChainSession(int flags, IntPtr callback);

    [DllImport("advapi32.dll")]
    private static extern void CloseThreadWaitChainSession(IntPtr session);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetThreadWaitChain(IntPtr session, UIntPtr context, int flags,
        int threadId, ref int count, [Out] NativeNode[] nodes, out bool cycle);

    [DllImport("kernel32.dll")]
    public static extern int GetCurrentThreadId();

    public static Result Read(int threadId)
    {
        const int WctThreadType = 8;
        const int WctOutOfProcFlag = 1;
        const int WctMaxNodeCount = 16;
        IntPtr session = OpenThreadWaitChainSession(0, IntPtr.Zero);
        if (session == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var result = new Result { ThreadId = threadId };
            int count = WctMaxNodeCount;
            var nodes = new NativeNode[count];
            if (!GetThreadWaitChain(session, UIntPtr.Zero, WctOutOfProcFlag,
                threadId, ref count, nodes, out bool cycle))
            {
                result.Error = Marshal.GetLastWin32Error();
                return result;
            }

            result.Cycle = cycle;
            result.Nodes = new Node[count];
            for (int i = 0; i < count; i++)
            {
                var node = new Node { Type = nodes[i].Type, Status = nodes[i].Status };
                if (node.Type == WctThreadType)
                {
                    node.ProcessId = nodes[i].ProcessId;
                    node.ThreadId = nodes[i].ThreadId;
                }
                result.Nodes[i] = node;
            }
            return result;
        }
        finally
        {
            CloseThreadWaitChainSession(session);
        }
    }
}
