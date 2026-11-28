$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class TestDesktop
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, StandardInput, StandardOutput, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr duplicate,
        uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static IntPtr InheritStandardHandle(int handle)
    {
        const uint DuplicateSameAccess = 2;
        IntPtr process = GetCurrentProcess();
        IntPtr duplicate;
        if (!DuplicateHandle(process, GetStdHandle(handle), process, out duplicate, 0, true, DuplicateSameAccess))
            throw new Win32Exception();
        return duplicate;
    }

    public static int Run(string executable, string command, string directory)
    {
        const uint DesktopAccess = 0x01ff;
        const uint UseStandardHandles = 0x100;
        const uint CreateNoWindow = 0x08000000;
        const uint Infinite = 0xffffffff;
        string name = "TomverseDesktopTest-" + Guid.NewGuid().ToString("N");
        IntPtr desktop = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, DesktopAccess, IntPtr.Zero);
        if (desktop == IntPtr.Zero) throw new Win32Exception();

        var startup = new StartupInfo {
            Size = (uint)Marshal.SizeOf(typeof(StartupInfo)),
            // Child processes inherit the test desktop without switching the active desktop.
            Desktop = name,
            Flags = UseStandardHandles
        };
        try
        {
            startup.StandardInput = InheritStandardHandle(-10);
            startup.StandardOutput = InheritStandardHandle(-11);
            startup.StandardError = InheritStandardHandle(-12);
            ProcessInfo child;
            if (!CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, CreateNoWindow,
                IntPtr.Zero, directory, ref startup, out child))
                throw new Win32Exception();
            CloseHandle(child.Thread);
            try
            {
                uint exitCode;
                if (WaitForSingleObject(child.Process, Infinite) != 0 || !GetExitCodeProcess(child.Process, out exitCode))
                    throw new Win32Exception();
                return (int)exitCode;
            }
            finally
            {
                CloseHandle(child.Process);
            }
        }
        finally
        {
            if (startup.StandardInput != IntPtr.Zero) CloseHandle(startup.StandardInput);
            if (startup.StandardOutput != IntPtr.Zero) CloseHandle(startup.StandardOutput);
            if (startup.StandardError != IntPtr.Zero) CloseHandle(startup.StandardError);
            CloseDesktop(desktop);
        }
    }
}
'@

exit [TestDesktop]::Run($env:TOMVERSE_TEST_NODE, $env:TOMVERSE_TEST_COMMAND_LINE, (Get-Location).Path)
