param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Title,
    [switch]$Close
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class TestWindow
{
    private delegate bool VisitWindow(IntPtr handle, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDesktopWindows(IntPtr desktop, VisitWindow visit, IntPtr data);
    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static IntPtr Find(uint processId, string title)
    {
        IntPtr found = IntPtr.Zero;
        IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
        EnumDesktopWindows(desktop, (window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId || !IsWindowVisible(window)) return true;
            var text = new StringBuilder(title.Length + 2);
            GetWindowText(window, text, text.Capacity);
            if (text.ToString() != title) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$window = [TestWindow]::Find($ProcessId, $Title)
if ($Close) {
    $windowClose = 0x0010
    if ($window -eq [IntPtr]::Zero -or
        -not [TestWindow]::PostMessageW($window, $windowClose, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw "The test window could not be closed."
    }
} elseif ($window -ne [IntPtr]::Zero) {
    $window.ToInt64().ToString("x")
}
