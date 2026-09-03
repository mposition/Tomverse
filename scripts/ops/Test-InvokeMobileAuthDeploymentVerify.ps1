<#
.SYNOPSIS
    Smoke test for Invoke-MobileAuthDeploymentVerify.ps1's security promises.

.DESCRIPTION
    The verify wrapper handles more secret-ish material than the keyring one:
    two rings plus two live credentials, one of which is a refresh token that
    rotates a family. The promises are the same shape and so are all absences --
    nothing secret in a parameter, nothing secret in any stream, nothing left on
    the environment, and the verifier's exit code returned rather than
    swallowed. Absences are what review is worst at seeing.

    Same technique as the keyring smoke test: `Read-Host` and `npm` are shadowed
    with functions, so the wrapper runs for real without a network, a key or an
    npm process.

.EXAMPLE
    ./scripts/ops/Test-InvokeMobileAuthDeploymentVerify.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$global:LASTEXITCODE = 0

$wrapper = Join-Path $PSScriptRoot "Invoke-MobileAuthDeploymentVerify.ps1"
if (-not (Test-Path $wrapper)) { throw "wrapper not found: $wrapper" }

$MANAGED = @(
    "MOBILE_AUTH_SIGNING_KEYS",
    "MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID",
    "MOBILE_AUTH_RETIRED_SIGNING_KEYS",
    "MOBILE_AUTH_REFRESH_PEPPERS",
    "MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID",
    "MOBILE_AUTH_RETIRED_REFRESH_PEPPERS",
    "MOBILE_AUTH_TOKEN_ISSUER",
    "MOBILE_AUTH_TOKEN_AUDIENCE",
    "MOBILE_AUTH_VERIFY_ACCESS_TOKEN",
    "MOBILE_AUTH_VERIFY_REFRESH_TOKEN",
    "MOBILE_AUTH_VERIFY_SECRET_DIGEST",
    "MOBILE_AUTH_VERIFY_PEPPER_KID",
    "MOBILE_AUTH_VERIFY_MODE"
)

$ALLOWED_PARAMETERS = @(
    "ActiveSigningKeyId",
    "ActiveRefreshPepperId",
    "TokenIssuer",
    "TokenAudience",
    "SecretDigest",
    "PepperKid",
    "RetiredSigningKeys",
    "RetiredRefreshPeppers",
    "Mode",
    "UsePreinjectedRings"
)

# Recognisable, and not real.
$SECRETS = @{
    1 = "TEST-SIGNING-RING-b7f1c2"
    2 = "TEST-PEPPER-RING-9d4a03"
    3 = "TEST-ACCESS-TOKEN-5e0ba1"
    4 = "TEST-REFRESH-TOKEN-cc74f9"
}

$global:results = @()
$global:promptCount = 0
$global:promptSecure = @()
$global:npmArgs = $null
$global:npmExit = 0
$global:npmSawMode = $null

function Assert-Case {
    param([string] $Name, [bool] $Ok, [string] $Detail = "")
    $global:results += [pscustomobject]@{ Name = $Name; Ok = $Ok }
    $mark = if ($Ok) { "PASS" } else { "FAIL" }
    Write-Host ("{0}  {1}{2}" -f $mark, $Name, $(if ($Detail) { " -- $Detail" } else { "" }))
}

function Read-Host {
    param([string] $Prompt, [switch] $AsSecureString)
    $global:promptCount++
    $global:promptSecure += [bool]$AsSecureString.IsPresent
    $value = $SECRETS[[math]::Min($global:promptCount, 4)]
    return (ConvertTo-SecureString -String $value -AsPlainText -Force)
}

function npm {
    $global:npmArgs = $args -join " "
    $global:npmSawMode = $env:MOBILE_AUTH_VERIFY_MODE
    Write-Output "stub npm: $($global:npmArgs)"
    $global:LASTEXITCODE = $global:npmExit
}

function Clear-Managed {
    foreach ($name in $MANAGED) {
        Remove-Item -Path ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

function Get-LeftoverManaged {
    return ,@($MANAGED | Where-Object { Test-Path ("Env:\{0}" -f $_) })
}

function Invoke-Wrapper {
    param([int] $NpmExit = 0, [string] $Mode = "rotation", [switch] $Preinjected, [hashtable] $Inject)

    $global:promptCount = 0
    $global:promptSecure = @()
    $global:npmArgs = $null
    $global:npmSawMode = $null
    $global:npmExit = $NpmExit
    Clear-Managed
    if ($Inject) {
        foreach ($name in $Inject.Keys) { Set-Item -Path ("Env:\{0}" -f $name) -Value $Inject[$name] }
    }

    $output = $null
    $threw = $false
    try {
        $output = & $wrapper `
            -ActiveSigningKeyId "sign-2" `
            -ActiveRefreshPepperId "pep-2" `
            -TokenIssuer "https://example.invalid" `
            -TokenAudience "tomverse-mobile-api" `
            -SecretDigest "0123456789abcdef" `
            -PepperKid "pep-2" `
            -Mode $Mode `
            -UsePreinjectedRings:$Preinjected *>&1 | Out-String
    }
    catch {
        $threw = $true
        $output = $_ | Out-String
    }

    [pscustomobject]@{
        Output   = $output
        ExitCode = $(if ($threw) { 1 } else { $LASTEXITCODE })
        Leftover = (Get-LeftoverManaged)
        NpmArgs  = $global:npmArgs
        SawMode  = $global:npmSawMode
        Prompts  = $global:promptCount
        Secure   = @($global:promptSecure)
    }
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper, [ref]$tokens, [ref]$parseErrors)
Assert-Case "1a. the wrapper parses" (@($parseErrors).Count -eq 0) `
    ("errors: {0}" -f (@($parseErrors | ForEach-Object { $_.Message }) -join "; "))

$declared = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
$unexpected = @($declared | Where-Object { $ALLOWED_PARAMETERS -notcontains $_ })
$missingParams = @($ALLOWED_PARAMETERS | Where-Object { $declared -notcontains $_ })
# Neither ring, and neither live token, may be a parameter: a parameter value
# is in the command line, and the command line is what gets saved.
Assert-Case "1b. the parameter surface is exactly the allowed list" `
    (($unexpected.Count -eq 0) -and ($missingParams.Count -eq 0)) `
    ("unexpected: [{0}] missing: [{1}]" -f ($unexpected -join ", "), ($missingParams -join ", "))

$ok = Invoke-Wrapper -NpmExit 0
Assert-Case "2a. success returns 0" ($ok.ExitCode -eq 0) ("exit={0}" -f $ok.ExitCode)
Assert-Case "2b. four prompts: two rings and two live credentials" ($ok.Prompts -eq 4) `
    ("prompts={0}" -f $ok.Prompts)
Assert-Case "2c. every prompt asked for a SecureString" `
    ((@($ok.Secure).Count -eq 4) -and (@($ok.Secure | Where-Object { -not $_ }).Count -eq 0)) `
    ("secure flags: {0}" -f (@($ok.Secure) -join ", "))
Assert-Case "2d. the verifier was called" ($ok.NpmArgs -like "*verify:mobile-auth-deployment*") `
    ("npm args: {0}" -f $ok.NpmArgs)

$bad = Invoke-Wrapper -NpmExit 1
Assert-Case "2e. failure returns non-zero" ($bad.ExitCode -ne 0) ("exit={0}" -f $bad.ExitCode)

Assert-Case "3a. cleared after success" ($ok.Leftover.Count -eq 0) ("left: {0}" -f ($ok.Leftover -join ", "))
Assert-Case "3b. cleared after failure" ($bad.Leftover.Count -eq 0) ("left: {0}" -f ($bad.Leftover -join ", "))

# The mode decides what a failure tells the operator to do, so it has to reach
# the verifier rather than being accepted and dropped.
$emergency = Invoke-Wrapper -Mode "emergency"
Assert-Case "4a. the mode reaches the verifier" ($emergency.SawMode -eq "emergency") `
    ("verifier saw: {0}" -f $emergency.SawMode)

$leaked = @()
foreach ($run in @($ok, $bad, $emergency)) {
    foreach ($secret in $SECRETS.Values) {
        if ($run.Output -like "*$secret*") { $leaked += $secret }
    }
}
Assert-Case "5a. no ring and no live token appears in any stream" ($leaked.Count -eq 0) `
    ("leaked: {0}" -f ($leaked.Count))
Assert-Case "5b. the access token's length is reported" `
    ($ok.Output -match ("MOBILE_AUTH_VERIFY_ACCESS_TOKEN length: {0}\b" -f $SECRETS[3].Length)) ""
Assert-Case "5c. the refresh token's length is reported" `
    ($ok.Output -match ("MOBILE_AUTH_VERIFY_REFRESH_TOKEN length: {0}\b" -f $SECRETS[4].Length)) ""
# The exchange is a real session and this script cannot end it.
Assert-Case "5d. the operator is told to revoke the exchange" `
    ($ok.Output -match "Revoke the exchange session") ""

$injected = Invoke-Wrapper -Preinjected -Inject @{
    MOBILE_AUTH_SIGNING_KEYS = "INJECTED-SIGNING-e31f80"
    MOBILE_AUTH_REFRESH_PEPPERS = "INJECTED-PEPPER-4c9d22"
}
# Two prompts, not four: the rings come from op run, the tokens from the
# exchange the operator just made.
Assert-Case "6a. pre-injected mode prompts only for the two live credentials" `
    ($injected.Prompts -eq 2) ("prompts={0}" -f $injected.Prompts)
Assert-Case "6b. pre-injected mode still clears the environment" `
    ($injected.Leftover.Count -eq 0) ("left: {0}" -f ($injected.Leftover -join ", "))

$notInjected = Invoke-Wrapper -Preinjected
Assert-Case "6c. a missing injection fails without prompting or verifying" `
    (($notInjected.ExitCode -ne 0) -and ($null -eq $notInjected.NpmArgs) -and
     ($notInjected.Prompts -eq 0) -and ($notInjected.Output -match "Nothing injected it")) `
    ("exit={0} prompts={1}" -f $notInjected.ExitCode, $notInjected.Prompts)

$failed = @($global:results | Where-Object { -not $_.Ok })
Write-Host ""
Write-Host ("{0} case(s), {1} failed" -f $global:results.Count, $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
