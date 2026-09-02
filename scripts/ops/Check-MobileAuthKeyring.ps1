<#
.SYNOPSIS
    Runs the mobile auth keyring check without putting a key in your shell history.

.DESCRIPTION
    `npm run check:mobile-auth-keyring` needs the values you are about to
    deploy, and two of them are secrets: the signing key ring and the pepper
    ring. Typing `$env:MOBILE_AUTH_SIGNING_KEYS = "<the key>"` puts that key in
    PSReadLine's history file, which persists on disk. PSReadLine does filter
    sensitive-looking commands, but it looks for patterns like `apikey`,
    `secret` and `token`, and there is no reason to bet a production signing key
    on a variable name matching one of them.

    So the two secrets are read with `Read-Host -AsSecureString`, converted in
    memory only, put on the environment for one process, and removed in a
    `finally` -- which runs on Ctrl-C and on a failure as well as on success.
    The non-secret values (ids, issuer, audience, retirement lists) are ordinary
    parameters: they are already visible in the Railway dashboard and reading
    them off the command line is how you check you typed them right.

    Precedent for the shape:
    .github/audits/google-image-thinking-cap-eval-2026-08-13.md.

    Read-only. It runs the check and nothing else -- no deploy, no write.

.PARAMETER ActiveSigningKeyId
    MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID

.PARAMETER ActiveRefreshPepperId
    MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID

.PARAMETER TokenIssuer
    MOBILE_AUTH_TOKEN_ISSUER

.PARAMETER TokenAudience
    MOBILE_AUTH_TOKEN_AUDIENCE

.PARAMETER RetiredSigningKeys
    MOBILE_AUTH_RETIRED_SIGNING_KEYS, e.g. "sign-1@2026-09-02T10:00:00Z".

.PARAMETER RetiredRefreshPeppers
    MOBILE_AUTH_RETIRED_REFRESH_PEPPERS.

.PARAMETER RequireConfigured
    Pass for a deployment that serves mobile auth: an entirely unconfigured
    environment then fails instead of passing.

.EXAMPLE
    ./scripts/ops/Check-MobileAuthKeyring.ps1 `
      -ActiveSigningKeyId sign-2 -ActiveRefreshPepperId pep-2 `
      -TokenIssuer https://tomverse.app -TokenAudience tomverse-mobile-api `
      -RetiredSigningKeys "sign-1@2026-09-02T10:00:00Z" `
      -RequireConfigured

    Prompts for the two rings, prints each key's state, and exits non-zero on
    anything the runtime would refuse.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $ActiveSigningKeyId,
    [Parameter(Mandatory = $true)][string] $ActiveRefreshPepperId,
    [Parameter(Mandatory = $true)][string] $TokenIssuer,
    [Parameter(Mandatory = $true)][string] $TokenAudience,
    [string] $RetiredSigningKeys = "",
    [string] $RetiredRefreshPeppers = "",
    [switch] $RequireConfigured
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# PowerShell 7.4+ turns a non-zero native exit code into a terminating error when
# $ErrorActionPreference is Stop. Here a non-zero exit is the answer, not an
# accident: we want to print it and return it, not throw over it.
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# Non-zero unless the check says otherwise: a path that skips the assignment
# must not read as a pass.
$exit = 1

# The two secrets, never as parameters: a parameter value is in the command
# line, and the command line is what gets saved.
function Read-SecretValue {
    param([Parameter(Mandatory = $true)][string] $Prompt)

    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        # Zero the unmanaged copy rather than waiting for the GC.
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
    "MOBILE_AUTH_TOKEN_AUDIENCE"
)

try {
    $env:MOBILE_AUTH_SIGNING_KEYS = Read-SecretValue -Prompt "MOBILE_AUTH_SIGNING_KEYS (id:base64,...)"
    $env:MOBILE_AUTH_REFRESH_PEPPERS = Read-SecretValue -Prompt "MOBILE_AUTH_REFRESH_PEPPERS (id:secret,...)"

    $env:MOBILE_AUTH_ACTIVE_SIGNING_KEY_ID = $ActiveSigningKeyId
    $env:MOBILE_AUTH_ACTIVE_REFRESH_PEPPER_ID = $ActiveRefreshPepperId
    $env:MOBILE_AUTH_RETIRED_SIGNING_KEYS = $RetiredSigningKeys
    $env:MOBILE_AUTH_RETIRED_REFRESH_PEPPERS = $RetiredRefreshPeppers
    $env:MOBILE_AUTH_TOKEN_ISSUER = $TokenIssuer
    $env:MOBILE_AUTH_TOKEN_AUDIENCE = $TokenAudience

    # Lengths, never values -- enough to catch a paste that lost a character.
    Write-Host ("MOBILE_AUTH_SIGNING_KEYS length: {0}" -f $env:MOBILE_AUTH_SIGNING_KEYS.Length)
    Write-Host ("MOBILE_AUTH_REFRESH_PEPPERS length: {0}" -f $env:MOBILE_AUTH_REFRESH_PEPPERS.Length)

    if ($RequireConfigured) {
        npm run check:mobile-auth-keyring -- --require-configured
    }
    else {
        npm run check:mobile-auth-keyring
    }
    $exit = $LASTEXITCODE
}
finally {
    # Runs on success, on failure and on Ctrl-C. Leaving a signing key on the
    # environment of an interactive session is the thing this script is for.
    foreach ($name in $assigned) {
        Remove-Item -Path ("Env:\{0}" -f $name) -ErrorAction SilentlyContinue
    }
}

Write-Host ("exit={0}" -f $exit)
exit $exit
