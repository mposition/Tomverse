<#
.SYNOPSIS
    Smoke test for Check-MobileAuthKeyring.ps1's four security promises.

.DESCRIPTION
    Check-MobileAuthKeyring.ps1 exists so that a production signing key never
    reaches PSReadLine's history file. That promise is an absence, and an
    absence is what review is worst at seeing -- so it gets a test.

    Four contracts, one case each:

      1. Neither ring is a parameter. A parameter value sits in the command
         line, and the command line is what gets saved.
      2. The underlying check's exit code is what the wrapper returns. A
         wrapper that swallows a failure is worse than no wrapper.
      3. All eight MOBILE_AUTH_* variables are gone afterwards -- on success,
         on failure, and when the run is interrupted.
      4. Neither secret appears in the output. Lengths only.

    Case 4's interruption is driven by making the second prompt throw, which is
    the same terminating-error path Ctrl-C takes into `finally`. A real Ctrl-C
    is a keyboard event and stays a manual check; the runbook says which two
    things to eyeball on first use.

    The wrapper is exercised for real: this script shadows `Read-Host` and
    `npm` with functions, and PowerShell resolves functions before cmdlets and
    before applications, so the child scope the wrapper runs in picks them up.
    Nothing here touches the network, a real key, or npm.

.EXAMPLE
    ./scripts/ops/Test-CheckMobileAuthKeyring.ps1

    Prints one line per case and exits non-zero if any failed.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Strict mode makes an unset $LASTEXITCODE an error, and the interruption case
# reaches the check's caller without ever running a process.
$global:LASTEXITCODE = 0

$wrapper = Join-Path $PSScriptRoot "Check-MobileAuthKeyring.ps1"
if (-not (Test-Path $wrapper)) {
    throw "wrapper not found: $wrapper"
}

$MANAGED = @(
    "MOBILE_AUTH_SIGNING_KEYS",
    "MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID",
    "MOBILE_AUTH_RETIRED_SIGNING_KEYS",
    "MOBILE_AUTH_REFRESH_PEPPERS",
    "MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID",
    "MOBILE_AUTH_RETIRED_REFRESH_PEPPERS",
    "MOBILE_AUTH_TOKEN_ISSUER",
    "MOBILE_AUTH_TOKEN_AUDIENCE"
)

# Recognisable, and not a real key: a leak shows up as itself.
$SIGNING_SECRET = "TEST-SIGNING-RING-b7f1c2"
$PEPPER_SECRET = "TEST-PEPPER-RING-9d4a03"

$global:results = @()
$global:promptCount = 0
$global:npmArgs = $null
$global:npmExit = 0
$global:throwOnPrompt = 0

function Assert-Case {
    param([string] $Name, [bool] $Ok, [string] $Detail = "")

    $global:results += [pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }
    $mark = if ($Ok) { "PASS" } else { "FAIL" }
    Write-Host ("{0}  {1}{2}" -f $mark, $Name, $(if ($Detail) { " -- $Detail" } else { "" }))
}

# Shadows the cmdlet inside the wrapper's scope: PowerShell resolves functions
# before cmdlets, and before applications for `npm` below.
function Read-Host {
    param([string] $Prompt, [switch] $AsSecureString)

    $global:promptCount++
    if ($global:throwOnPrompt -eq $global:promptCount) {
        throw "simulated interruption at prompt $($global:promptCount)"
    }
    $value = if ($global:promptCount -eq 1) { $SIGNING_SECRET } else { $PEPPER_SECRET }
    return (ConvertTo-SecureString -String $value -AsPlainText -Force)
}

# Shadows the npm application. Records what it was asked to do.
function npm {
    $global:npmArgs = $args -join " "
    Write-Output "stub npm: $($global:npmArgs)"
    # $LASTEXITCODE is what the wrapper reads to decide its own exit code, and
    # it resolves to the global one from inside the wrapper's scope.
    $global:LASTEXITCODE = $global:npmExit
}

function Clear-Managed {
    foreach ($name in $MANAGED) {
        Remove-Item -Path ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

function Get-LeftoverManaged {
    # The comma keeps an empty array an empty array: PowerShell unrolls a bare
    # @() on return into $null, and $null.Count is an error under strict mode.
    return ,@($MANAGED | Where-Object { Test-Path ("Env:\{0}" -f $_) })
}

function Invoke-Wrapper {
    param([int] $NpmExit = 0, [int] $ThrowOnPrompt = 0)

    $global:promptCount = 0
    $global:npmArgs = $null
    $global:npmExit = $NpmExit
    $global:throwOnPrompt = $ThrowOnPrompt
    Clear-Managed

    # 6>&1 captures the information stream too: Write-Host goes there, so
    # without it case 4 would be checking a stream the lengths never reach --
    # and a secret printed with Write-Host would pass unnoticed.
    $output = $null
    $threw = $false
    try {
        $output = & $wrapper `
            -ActiveSigningKeyId "sign-2" `
            -ActiveRefreshPepperId "pep-2" `
            -TokenIssuer "https://example.invalid" `
            -TokenAudience "tomverse-mobile-api" `
            -RetiredSigningKeys "sign-1@2026-09-02T10:00:00Z" `
            -RetiredRefreshPeppers "pep-1@2026-09-02T10:00:00Z" `
            -RequireConfigured 2>&1 6>&1 | Out-String
    }
    catch {
        $threw = $true
        $output = $_ | Out-String
    }

    [pscustomobject]@{
        Output    = $output
        Threw     = $threw
        ExitCode  = $LASTEXITCODE
        Leftover  = (Get-LeftoverManaged)
        NpmArgs   = $global:npmArgs
        Prompts   = $global:promptCount
    }
}

# 1. Neither ring is a parameter.
$declared = (Get-Command $wrapper).Parameters.Keys
$secretParams = @($declared | Where-Object { $_ -match "SigningKeys$|Peppers$" -and $_ -notmatch "^Retired" })
Assert-Case "1. neither ring is a parameter" ($secretParams.Count -eq 0) `
    ("declared: {0}" -f ($declared -join ", "))

# 2. Exit code of the underlying check is returned. Also: prompted twice,
#    and the flag reached the check.
$ok = Invoke-Wrapper -NpmExit 0
Assert-Case "2a. success returns 0" ($ok.ExitCode -eq 0) ("exit={0}" -f $ok.ExitCode)
Assert-Case "2b. prompted for both rings" ($ok.Prompts -eq 2) ("prompts={0}" -f $ok.Prompts)
Assert-Case "2c. -RequireConfigured reached the check" `
    ($ok.NpmArgs -like "*--require-configured*") ("npm args: {0}" -f $ok.NpmArgs)

$bad = Invoke-Wrapper -NpmExit 1
Assert-Case "2d. failure returns non-zero" ($bad.ExitCode -ne 0) ("exit={0}" -f $bad.ExitCode)

# 3. Environment cleared on success, on failure, and on interruption.
Assert-Case "3a. cleared after success" ($ok.Leftover.Count -eq 0) `
    ("left: {0}" -f ($ok.Leftover -join ", "))
Assert-Case "3b. cleared after failure" ($bad.Leftover.Count -eq 0) `
    ("left: {0}" -f ($bad.Leftover -join ", "))

$interrupted = Invoke-Wrapper -ThrowOnPrompt 2
Assert-Case "3c. cleared after interruption at the second prompt" `
    ($interrupted.Leftover.Count -eq 0) ("left: {0}" -f ($interrupted.Leftover -join ", "))

# 4. Neither secret in the output, and the lengths are.
$leaked = @()
foreach ($run in @($ok, $bad, $interrupted)) {
    if ($run.Output -like "*$SIGNING_SECRET*") { $leaked += "signing" }
    if ($run.Output -like "*$PEPPER_SECRET*") { $leaked += "pepper" }
}
Assert-Case "4a. neither secret appears in the output" ($leaked.Count -eq 0) `
    ("leaked: {0}" -f ($leaked -join ", "))
Assert-Case "4b. lengths are reported" `
    ($ok.Output -match ("length: {0}" -f $SIGNING_SECRET.Length)) ""

$failed = @($global:results | Where-Object { -not $_.Ok })
Write-Host ""
Write-Host ("{0} case(s), {1} failed" -f $global:results.Count, $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
