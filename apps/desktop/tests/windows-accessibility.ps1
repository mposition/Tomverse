[CmdletBinding(DefaultParameterSetName = "Read")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Read")][string]$WindowHandle,
    [Parameter(Mandatory = $true, ParameterSetName = "Cancel")][int]$ProcessId,
    [Parameter(Mandatory = $true, ParameterSetName = "Cancel")][string]$Title,
    [Parameter(Mandatory = $true, ParameterSetName = "Cancel")][string]$CancelName
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$descendants = [Windows.Automation.TreeScope]::Descendants

function Find-Label($element, [string]$name) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
    $element.FindFirst($descendants, $condition)
}

if ($PSCmdlet.ParameterSetName -eq "Read") {
    $window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Convert]::ToInt64($WindowHandle, 16)))
    $roles = @{}
    foreach ($name in ($env:TOMVERSE_UIA_TEST_LABELS | ConvertFrom-Json)) {
        $entry = Find-Label $window $name
        $roles[$name] = if ($entry) { $entry.Current.ControlType.ProgrammaticName } else { $null }
    }
    $roles | ConvertTo-Json -Compress
    return
}

$filter = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopDialogTest {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$stopAt = [DateTime]::UtcNow.AddSeconds(7)
$buttonClick = 0x00F5
do {
    foreach ($owner in [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $filter)) {
        $dialog = if ($owner.Current.Name -eq $Title) { $owner } else { Find-Label $owner $Title }
        if (!$dialog -or $dialog.Current.ProcessId -ne $ProcessId) { continue }
        $cancel = Find-Label $dialog $CancelName
        if ($cancel -and $cancel.Current.ProcessId -eq $ProcessId) {
            $invoke = $null
            if ($cancel.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
                $invoke.Invoke()
            } elseif (![DesktopDialogTest]::PostMessageW([IntPtr]$cancel.Current.NativeWindowHandle, $buttonClick, [IntPtr]::Zero, [IntPtr]::Zero)) {
                throw "The test application's native Cancel button could not be invoked."
            }
            return
        }
    }
    Start-Sleep -Milliseconds 80
} while ([DateTime]::UtcNow -lt $stopAt)
throw "The test application's native confirmation or Cancel button was not found."
