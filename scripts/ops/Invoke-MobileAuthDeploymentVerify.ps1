<#
.SYNOPSIS
    Runs the post-deploy verification without putting a key or a live token in
    your shell history.

.DESCRIPTION
    `npm run verify:mobile-auth-deployment` needs four secret-ish values and two
    rings. Two of the four are live credentials -- an access token and a refresh
    token from a controlled exchange -- and a refresh token is a bearer secret
    that rotates a family. None of them belongs on a command line, where
    PSReadLine's history file keeps it.

    So the same shape as Check-MobileAuthKeyring.ps1: the rings and the two
    tokens are read with `Read-Host -AsSecureString`, converted in memory only,
    put on the environment for one process, and removed in a `finally` -- which
    runs on Ctrl-C and on a failure as well as on success. `secretDigest` and
    `pepperKid` are ordinary parameters: they are stored values, not secrets,
    and reading them off the command line is how you check you copied the right
    row.

    Read-only. It verifies and nothing else -- no deploy, no promotion. The
    promotion to Active is a decision a person makes after reading this.

    **The exchange you collected is a real session. Revoke it when you are
    done.** This script cannot do that for you.

.PARAMETER SecretDigest
    MobileRefreshRotation.secretDigest from the row that exchange created.

.PARAMETER PepperKid
    MobileRefreshRotation.pepperKid from the same row.

.PARAMETER ActiveSigningKeyId
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID -- the candidate's, not the deployment's.

.PARAMETER ActiveRefreshPepperId
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID

.PARAMETER TokenIssuer
    MOBILE_AUTH_TOKEN_ISSUER

.PARAMETER TokenAudience
    MOBILE_AUTH_TOKEN_AUDIENCE

.PARAMETER RetiredSigningKeys
    MOBILE_AUTH_RETIRED_SIGNING_KEYS

.PARAMETER RetiredRefreshPeppers
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS

.PARAMETER Mode
    rotation (default) or emergency. It decides what a failure tells you to do:
    an emergency has no trustworthy Active to roll back to, so being told to
    roll back there means restoring the ring the procedure abandoned.

.PARAMETER UsePreinjectedRings
    Take the two rings from the environment instead of prompting -- what
    `op run` provides. The two tokens are still prompted for: they come from an
    exchange you just made, not from the store.

.EXAMPLE
    ./scripts/ops/Invoke-MobileAuthDeploymentVerify.ps1 `
      -ActiveSigningKeyId sign-2 -ActiveRefreshPepperId pep-2 `
      -TokenIssuer https://tomverse.app -TokenAudience tomverse-mobile-api `
      -RetiredSigningKeys "sign-1@2026-09-02T10:00:00Z" `
      -SecretDigest "<from the row>" -PepperKid pep-2
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $ActiveSigningKeyId,
    [Parameter(Mandatory = $true)][string] $ActiveRefreshPepperId,
    [Parameter(Mandatory = $true)][string] $TokenIssuer,
    [Parameter(Mandatory = $true)][string] $TokenAudience,
    [Parameter(Mandatory = $true)][string] $SecretDigest,
    [Parameter(Mandatory = $true)][string] $PepperKid,
    [string] $RetiredSigningKeys = "",
    [string] $RetiredRefreshPeppers = "",
    [ValidateSet("rotation", "emergency")][string] $Mode = "rotation",
    [switch] $UsePreinjectedRings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# A non-zero exit from the verifier is its answer, not an accident.
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Non-zero unless the verifier says otherwise.
$exit = 1
$missing = @()

function Read-SecretValue {
    param([Parameter(Mandatory = $true)][string] $Prompt)

    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$assigned = @(
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

try {
    if ($UsePreinjectedRings) {
        # The outer @() matters: a Where-Object matching nothing yields $null,
        # and $null.Count throws under Set-StrictMode.
        $missing = @(
            @(
                "MOBILE_AUTH_SIGNING_KEYS",
                "MOBILE_AUTH_REFRESH_PEPPERS"
            ) | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) }
        )
    }
    else {
        $env:MOBILE_AUTH_SIGNING_KEYS = Read-SecretValue -Prompt "MOBILE_AUTH_SIGNING_KEYS (candidate ring)"
        $env:MOBILE_AUTH_REFRESH_PEPPERS = Read-SecretValue -Prompt "MOBILE_AUTH_REFRESH_PEPPERS (candidate ring)"
    }

    if ($missing.Count -gt 0) {
        Write-Host ("FAIL -UsePreinjectedRings was passed but {0} is empty. Nothing injected it." -f ($missing -join " and "))
        Write-Host "     Run this under 'op run', or drop the switch to be prompted."
        $exit = 1
    }
    else {
        # Live credentials from the exchange, so prompted like the rings.
        $env:MOBILE_AUTH_VERIFY_ACCESS_TOKEN = Read-SecretValue -Prompt "access token from the controlled exchange"
        $env:MOBILE_AUTH_VERIFY_REFRESH_TOKEN = Read-SecretValue -Prompt "refresh token from the same exchange"

        $env:MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = $ActiveSigningKeyId
        $env:MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = $ActiveRefreshPepperId
        $env:MOBILE_AUTH_RETIRED_SIGNING_KEYS = $RetiredSigningKeys
        $env:MOBILE_AUTH_RETIRED_REFRESH_PEPPERS = $RetiredRefreshPeppers
        $env:MOBILE_AUTH_TOKEN_ISSUER = $TokenIssuer
        $env:MOBILE_AUTH_TOKEN_AUDIENCE = $TokenAudience
        $env:MOBILE_AUTH_VERIFY_SECRET_DIGEST = $SecretDigest
        $env:MOBILE_AUTH_VERIFY_PEPPER_KID = $PepperKid
        $env:MOBILE_AUTH_VERIFY_MODE = $Mode

        # Lengths, never values.
        Write-Host ("MOBILE_AUTH_SIGNING_KEYS length: {0}" -f $env:MOBILE_AUTH_SIGNING_KEYS.Length)
        Write-Host ("MOBILE_AUTH_REFRESH_PEPPERS length: {0}" -f $env:MOBILE_AUTH_REFRESH_PEPPERS.Length)
        Write-Host ("MOBILE_AUTH_VERIFY_ACCESS_TOKEN length: {0}" -f $env:MOBILE_AUTH_VERIFY_ACCESS_TOKEN.Length)
        Write-Host ("MOBILE_AUTH_VERIFY_REFRESH_TOKEN length: {0}" -f $env:MOBILE_AUTH_VERIFY_REFRESH_TOKEN.Length)

        npm run verify:mobile-auth-deployment
        $exit = $LASTEXITCODE
    }
}
finally {
    # Runs on success, on failure and on Ctrl-C. A refresh token left on an
    # interactive session's environment is a live credential lying about.
    foreach ($name in $assigned) {
        Remove-Item -Path ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Revoke the exchange session you collected this evidence from."
Write-Host ("exit={0}" -f $exit)
exit $exit
