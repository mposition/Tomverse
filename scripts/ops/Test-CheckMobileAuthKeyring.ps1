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
$global:promptSecure = @()
$global:npmArgs = $null
$global:npmSawSigningRing = $null
$global:npmSawPepperRing = $null
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
    # Whether the wrapper asked for a SecureString is the contract here, not a
    # detail of the shim: without -AsSecureString the operator's ring is echoed
    # to the screen as they type it, and every other case still passes.
    $global:promptSecure += [bool]$AsSecureString.IsPresent
    if ($global:throwOnPrompt -eq $global:promptCount) {
        throw "simulated interruption at prompt $($global:promptCount)"
    }
    $value = if ($global:promptCount -eq 1) { $SIGNING_SECRET } else { $PEPPER_SECRET }
    return (ConvertTo-SecureString -String $value -AsPlainText -Force)
}

# Shadows the npm application. Records what it was asked to do.
function npm {
    $global:npmArgs = $args -join " "
    # What the check would actually read. The pre-injected mode exists so that
    # `op run`'s value survives to here instead of being overwritten by a
    # prompt, and that is only observable at the moment the check is called.
    $global:npmSawSigningRing = $env:MOBILE_AUTH_SIGNING_KEYS
    $global:npmSawPepperRing = $env:MOBILE_AUTH_REFRESH_PEPPERS
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
    param(
        [int] $NpmExit = 0,
        [int] $ThrowOnPrompt = 0,
        [switch] $Preinjected,
        [hashtable] $Inject
    )

    $global:promptCount = 0
    $global:promptSecure = @()
    $global:npmArgs = $null
    $global:npmSawSigningRing = $null
    $global:npmSawPepperRing = $null
    $global:npmExit = $NpmExit
    $global:throwOnPrompt = $ThrowOnPrompt
    Clear-Managed
    if ($Inject) {
        foreach ($name in $Inject.Keys) {
            Set-Item -Path ("Env:\{0}" -f $name) -Value $Inject[$name]
        }
    }

    # *>&1 and not 2>&1 6>&1: a secret reaches the operator's screen through
    # whichever stream printed it, so the leak check has to read all of them.
    # Warning, verbose and debug (3, 4, 5) were the gap -- Write-Warning $secret
    # showed the value on screen and case 4a saw nothing.
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
            -RequireConfigured -UsePreinjectedRings:$Preinjected *>&1 | Out-String
    }
    catch {
        $threw = $true
        $output = $_ | Out-String
    }

    [pscustomobject]@{
        Output    = $output
        Threw     = $threw
        # A script that dies on an unhandled error exits non-zero when it is
        # run as `pwsh -File`; read here it would be whatever the last run
        # left, which can read as success.
        ExitCode  = $(if ($threw) { 1 } else { $LASTEXITCODE })
        Leftover  = (Get-LeftoverManaged)
        NpmArgs   = $global:npmArgs
        SawSigning = $global:npmSawSigningRing
        SawPepper = $global:npmSawPepperRing
        Prompts   = $global:promptCount
        Secure    = @($global:promptSecure)
    }
}

# 1. The parameter surface is exactly this, and a name is never guessed at.
#    Matching "looks like a secret" would pass a parameter called
#    -SigningKeyRing, so the list is closed instead: anything new has to be
#    added here deliberately, which is the moment to ask whether it is a secret.
$ALLOWED_PARAMETERS = @(
    "ActiveSigningKeyId",
    "ActiveRefreshPepperId",
    "TokenIssuer",
    "TokenAudience",
    "RetiredSigningKeys",
    "RetiredRefreshPeppers",
    "RequireConfigured",
    "UsePreinjectedRings"
)

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
Assert-Case "1a. the wrapper parses" (@($parseErrors).Count -eq 0) `
    ("errors: {0}" -f (@($parseErrors | ForEach-Object { $_.Message }) -join "; "))

# ParamBlock, not Get-Command: the AST gives the script's own parameters
# without PowerShell's common ones mixed in.
$declared = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
$unexpected = @($declared | Where-Object { $ALLOWED_PARAMETERS -notcontains $_ })
$missing = @($ALLOWED_PARAMETERS | Where-Object { $declared -notcontains $_ })
Assert-Case "1b. the parameter surface is exactly the allowed list" `
    (($unexpected.Count -eq 0) -and ($missing.Count -eq 0)) `
    ("unexpected: [{0}] missing: [{1}]" -f ($unexpected -join ", "), ($missing -join ", "))

# 2. Exit code of the underlying check is returned. Also: prompted twice,
#    and the flag reached the check.
$ok = Invoke-Wrapper -NpmExit 0
Assert-Case "2a. success returns 0" ($ok.ExitCode -eq 0) ("exit={0}" -f $ok.ExitCode)
Assert-Case "2b. prompted for both rings" ($ok.Prompts -eq 2) ("prompts={0}" -f $ok.Prompts)
Assert-Case "2c. -RequireConfigured reached the check" `
    ($ok.NpmArgs -like "*--require-configured*") ("npm args: {0}" -f $ok.NpmArgs)

Assert-Case "2e. both prompts asked for a SecureString" `
    ((@($ok.Secure).Count -eq 2) -and (@($ok.Secure | Where-Object { -not $_ }).Count -eq 0)) `
    ("secure flags: {0}" -f (@($ok.Secure) -join ", "))

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
# Both, separately: the wrapper prints two lines and one of them going missing
# is exactly the kind of edit that reads as harmless.
Assert-Case "4b. the signing ring's length is reported" `
    ($ok.Output -match ("MOBILE_AUTH_SIGNING_KEYS length: {0}\b" -f $SIGNING_SECRET.Length)) ""
Assert-Case "4c. the pepper ring's length is reported" `
    ($ok.Output -match ("MOBILE_AUTH_REFRESH_PEPPERS length: {0}\b" -f $PEPPER_SECRET.Length)) ""

# 5. Pre-injected rings: the mode `op run` uses.
$INJECTED_SIGNING = "INJECTED-SIGNING-e31f80"
$INJECTED_PEPPER = "INJECTED-PEPPER-4c9d22"
$injected = Invoke-Wrapper -Preinjected -Inject @{
    MOBILE_AUTH_SIGNING_KEYS  = $INJECTED_SIGNING
    MOBILE_AUTH_REFRESH_PEPPERS = $INJECTED_PEPPER
}
Assert-Case "5a. pre-injected mode does not prompt" ($injected.Prompts -eq 0) `
    ("prompts={0}" -f $injected.Prompts)
# The regression this mode was added for: the prompts used to overwrite what
# `op run` injected, so the check ran against the operator's typing instead.
Assert-Case "5b. the injected rings reach the check unchanged" `
    (($injected.SawSigning -eq $INJECTED_SIGNING) -and ($injected.SawPepper -eq $INJECTED_PEPPER)) `
    ("check saw signing=[{0}] pepper=[{1}]" -f $injected.SawSigning, $injected.SawPepper)
Assert-Case "5c. pre-injected mode still clears the environment" `
    ($injected.Leftover.Count -eq 0) ("left: {0}" -f ($injected.Leftover -join ", "))

# An empty injection is a failure, never a silent run against an empty ring.
$notInjected = Invoke-Wrapper -Preinjected
Assert-Case "5d. a missing injection fails without running the check" `
    (($notInjected.ExitCode -ne 0) -and ($null -eq $notInjected.NpmArgs) -and
     ($notInjected.Output -match "Nothing injected it")) `
    ("exit={0} npmArgs=[{1}]" -f $notInjected.ExitCode, $notInjected.NpmArgs)
Assert-Case "5e. a missing injection still clears the environment" `
    ($notInjected.Leftover.Count -eq 0) ("left: {0}" -f ($notInjected.Leftover -join ", "))
Assert-Case "5f. neither injected ring appears in the output" `
    ((-not ($injected.Output -like "*$INJECTED_SIGNING*")) -and (-not ($injected.Output -like "*$INJECTED_PEPPER*"))) ""

$failed = @($global:results | Where-Object { -not $_.Ok })
Write-Host ""
Write-Host ("{0} case(s), {1} failed" -f $global:results.Count, $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
