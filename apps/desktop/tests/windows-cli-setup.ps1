param(
    [Parameter(Mandatory = $true)][string]$WindowHandle,
    [Parameter(Mandatory = $true)][ValidateSet("Save", "Upgrade", "Recheck", "Protocol", "ProtocolUnavailable", "ProtocolRecheck")][string]$Stage
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Convert]::ToInt64($WindowHandle, 16)))
$descendants = [Windows.Automation.TreeScope]::Descendants
$cases = $env:TOMVERSE_TEST_CLI_PATH_CASES | ConvertFrom-Json

function Find-Control([string[]]$names, [Windows.Automation.ControlType]$type, [int]$timeout = 8) {
    $nameConditions = foreach ($name in $names) {
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
    }
    $named = if ($names.Count -eq 1) { $nameConditions } else {
        [Windows.Automation.OrCondition]::new([Windows.Automation.Condition[]]$nameConditions)
    }
    $condition = if ($type) {
        $withType = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, $type)
        [Windows.Automation.AndCondition]::new($named, $withType)
    } else { $named }
    $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
    do {
        $matches = $window.FindAll($descendants, $condition)
        if ($matches.Count) {
            return $matches[$matches.Count - 1]
        }
        Start-Sleep -Milliseconds 80
    } while ([DateTime]::UtcNow -lt $deadline)
    $labels = $window.FindAll($descendants, [Windows.Automation.Condition]::TrueCondition) |
        ForEach-Object { $_.Current.Name } | Where-Object { $_ -match 'verified|Check required|Checking|blocked|protocol check' }
    throw "Could not find '$($names -join ' or ')' during CLI path $Stage. Status labels: $($labels -join ' | ')"
}

function Invoke-Button([string]$name) {
    $button = Find-Control $name ([Windows.Automation.ControlType]::Button)
    $invoke = $null
    if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
    } elseif ($button.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$invoke)) {
        $invoke.Toggle()
    } else {
        $patterns = ($button.GetSupportedPatterns().ProgrammaticName -join ", ")
        throw "The '$name' button has no actionable UI Automation pattern. Available patterns: $patterns"
    }
}

function Assert-NoControl([string]$name) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
    if ($window.FindFirst($descendants, $condition)) { throw "The '$name' control should be unavailable." }
}

$textType = [Windows.Automation.ControlType]::Text
$editType = [Windows.Automation.ControlType]::Edit
$middleDot = [char]0x00b7
if ($Stage -notin @("Recheck", "ProtocolRecheck")) {
    Invoke-Button "Settings"
    Invoke-Button "Development CLIs"
}
foreach ($case in $cases) {
    $action = if ($Stage -eq "Save") { "Set path" } else { "Change path" }
    Invoke-Button "$($case.name) $middleDot $action"
    $edit = Find-Control $case.pathLabel $editType
    $value = $edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    if ($Stage -eq "Save") {
        $value.SetValue($case.path)
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        while ($value.Current.Value -cne $case.path -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 80 }
        if ($value.Current.Value -cne $case.path) { throw "The requested CLI path was not entered for $($case.name)." }
    } else {
        if ($value.Current.Value -cne $case.path) { throw "The saved CLI path did not survive the upgrade." }
        if ($Stage -in @("Upgrade", "Protocol", "ProtocolUnavailable")) { $null = Find-Control "Check required" $textType }
    }
    if ($Stage -eq "Protocol") {
        $check = Find-Control "Check local protocol" ([Windows.Automation.ControlType]::Button)
        if ($check.Current.IsEnabled) { throw "The local protocol check must require a verified CLI path." }
    }
    if ($Stage -eq "ProtocolRecheck") {
        $null = Find-Control "Check required" $textType
        Assert-NoControl "Protocol verified"
        $check = Find-Control "Check local protocol" ([Windows.Automation.ControlType]::Button)
        if ($check.Current.IsEnabled) { throw "The modified CLI file must be verified again." }
        Invoke-Button "Development CLIs"
        continue
    }
    Invoke-Button "Check and save"
    if ($Stage -eq "Recheck") {
        $null = Find-Control "Version unverified" $textType 20
    } else {
        $combined = "$($case.verifiedLabel) $middleDot $($case.version)"
        $null = Find-Control @($case.verifiedLabel, $combined) $textType 25
        $null = Find-Control @(" $middleDot $($case.version)", "$middleDot $($case.version)", $combined) $textType
    }
    if ($Stage -eq "Protocol") {
        Invoke-Button "Check local protocol"
        if ($case.protocolStatus -eq "networkBlocked") {
            $null = Find-Control "The local protocol check blocked a network request from the CLI." $textType 70
            Assert-NoControl "Protocol verified"
            Write-Output "$($case.id): network request blocked"
        } else {
            $null = Find-Control "Protocol verified" $textType 70
            $null = Find-Control "Model access requires a connected account." $textType
            if ($case.id -in @("openai", "anthropic")) {
                $modelSummary = $window.FindAll($descendants, [Windows.Automation.Condition]::TrueCondition) |
                    Where-Object { $_.Current.Name -match '^Advertised models \([1-9][0-9]*\+?\)$' } | Select-Object -First 1
                if (!$modelSummary) { throw "The $($case.name) CLI model catalog was not shown." }
            }
            Write-Output "$($case.id): protocol verified"
        }
        Assert-NoControl "Check isolated sign-in"
        $null = Find-Control "Unknown" $textType
    } elseif ($Stage -eq "ProtocolUnavailable") {
        Assert-NoControl "Check local protocol"
    }
    Invoke-Button "Development CLIs"
}
