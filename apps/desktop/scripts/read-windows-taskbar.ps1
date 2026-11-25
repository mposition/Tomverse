[CmdletBinding(DefaultParameterSetName = "Process")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Process")][int]$ProcessId,
    [Parameter(Mandatory = $true, ParameterSetName = "Window")][string]$WindowHandle,
    [Parameter(ParameterSetName = "Window")][string]$Executable,
    [string]$ReferenceIcon
)

$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TaskbarProperties {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey {
        public Guid Format;
        public uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyValue {}

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore {
        uint GetCount();
        PropertyKey GetAt(uint index);
        void GetValue(ref PropertyKey key, out PropertyValue value);
    }

    [DllImport("shell32.dll", PreserveSig = false)]
    private static extern IPropertyStore SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid);

    [DllImport("propsys.dll", PreserveSig = false)]
    [return: MarshalAs(UnmanagedType.LPWStr)]
    private static extern string PropVariantToStringAlloc(ref PropertyValue value);

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropertyValue value);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern uint ExtractIconEx(string path, int index, out IntPtr large, out IntPtr small, uint count);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    public static IntPtr ReadWindowIcon(IntPtr window, uint size) {
        const uint WM_GETICON = 0x007F;
        const uint SMTO_ABORTIFHUNG = 0x0002;
        IntPtr icon;
        if (SendMessageTimeout(window, WM_GETICON, new UIntPtr(size), IntPtr.Zero,
            SMTO_ABORTIFHUNG, 2000, out icon) == IntPtr.Zero || icon == IntPtr.Zero) {
            throw new InvalidOperationException("Windows did not return the requested window icon.");
        }
        return icon;
    }

    public static string Read(IntPtr window, uint id) {
        var iid = typeof(IPropertyStore).GUID;
        var store = SHGetPropertyStoreForWindow(window, ref iid);
        var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = id };
        try {
            PropertyValue value;
            store.GetValue(ref key, out value);
            try { return PropVariantToStringAlloc(ref value); }
            finally { PropVariantClear(ref value); }
        } finally { Marshal.ReleaseComObject(store); }
    }
}
'@

$window = if ($PSCmdlet.ParameterSetName -eq "Window") {
    [IntPtr]([Convert]::ToInt64($WindowHandle, 16))
} else {
    (Get-Process -Id $ProcessId).MainWindowHandle
}
if ($window -eq [IntPtr]::Zero) { throw "The test window is unavailable." }
$details = @{
    appId = [TaskbarProperties]::Read($window, 5)
    icon = [TaskbarProperties]::Read($window, 3)
    command = [TaskbarProperties]::Read($window, 2)
    name = [TaskbarProperties]::Read($window, 4)
}
if ($ReferenceIcon) {
    Add-Type -AssemblyName System.Drawing

    function Convert-IconImage([IntPtr]$Handle) {
        $icon = [System.Drawing.Icon]::FromHandle($Handle)
        $bitmap = $icon.ToBitmap()
        $stream = [System.IO.MemoryStream]::new()
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            [Convert]::ToBase64String($stream.ToArray())
        } finally {
            $stream.Dispose()
            $bitmap.Dispose()
            $icon.Dispose()
        }
    }

    function Read-IconImages([string]$Path) {
        $large = [IntPtr]::Zero
        $small = [IntPtr]::Zero
        try {
            $count = [TaskbarProperties]::ExtractIconEx($Path, 0, [ref]$large, [ref]$small, 1)
            if ($count -eq 0 -or $count -eq [uint32]::MaxValue -or $large -eq [IntPtr]::Zero -or $small -eq [IntPtr]::Zero) {
                throw "Windows could not extract both icon sizes from $Path."
            }
            Convert-IconImage $large
            Convert-IconImage $small
        } finally {
            foreach ($handle in @($large, $small)) {
                if ($handle -ne [IntPtr]::Zero) { [void][TaskbarProperties]::DestroyIcon($handle) }
            }
        }
    }

    $expected = @(Read-IconImages (Resolve-Path -LiteralPath $ReferenceIcon).Path)
    $actual = @(Read-IconImages ($details.icon -replace ',0$', ''))
    $details.iconMatches = ($expected[0] -ceq $actual[0]) -and ($expected[1] -ceq $actual[1])
    $windowLarge = Convert-IconImage ([TaskbarProperties]::ReadWindowIcon($window, 1))
    $windowSmall = Convert-IconImage ([TaskbarProperties]::ReadWindowIcon($window, 0))
    $details.windowIconMatches = ($expected[0] -ceq $windowLarge) -and ($expected[1] -ceq $windowSmall)
    if ($PSCmdlet.ParameterSetName -eq "Process") {
        $Executable = (Get-Process -Id $ProcessId).Path
    }
    if ($Executable) {
        $executableIcons = @(Read-IconImages $Executable)
        $details.executableIconMatches = ($expected[0] -ceq $executableIcons[0]) -and ($expected[1] -ceq $executableIcons[1])
    }
}
$details | ConvertTo-Json -Compress
