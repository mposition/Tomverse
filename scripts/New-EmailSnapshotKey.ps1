<#
.SYNOPSIS
  Builds an EMAIL_SNAPSHOT_KEYS value. Same strength as `openssl rand -base64 32`.

.DESCRIPTION
  The keyring the standard email lane seals its render snapshots with.
  Contract: docs/policy/email-notifications.md section 10.3.
  Procedure: docs/ops/email-snapshot-keyring.md.

  The secret is printed and never written anywhere. Clear the console after
  pasting it: PowerShell keeps no record of output, but PSReadLine does record
  the command line, so do not pass a secret as an argument you would rather not
  keep -- and note that -ExistingKeys is exactly such an argument.

  This is the only place that generates the value. A second recipe pasted into
  a runbook is a second set of rules about a key nobody can re-derive.

.PARAMETER Version
  The label for the new key. Defaults to v1. Colons and commas are the
  keyring's own separators and are refused.

.PARAMETER ExistingKeys
  When rotating, the current EMAIL_SNAPSHOT_KEYS value, exactly as stored. The
  new pair is appended and the whole value is returned.

  Existing keys are never dropped. A version removed from the keyring does not
  delete the rows it sealed -- it makes them permanently unreadable, which is
  worse and is silent. Legal-class records keep theirs for seven years.

.EXAMPLE
  .\New-EmailSnapshotKey.ps1

.EXAMPLE
  .\New-EmailSnapshotKey.ps1 -Version v2 -ExistingKeys "v1:AAAA...="
#>
[CmdletBinding()]
param(
    [string] $Version = 'v1',
    [string] $ExistingKeys = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Version)) {
    throw 'Version must not be empty.'
}
if ($Version -ne $Version.Trim()) {
    throw "Version '$Version' has surrounding whitespace, which the parser strips and an operator would not see."
}
if ($Version -match '[:,]') {
    throw "Version '$Version' contains ':' or ',', which are the keyring's separators."
}

# 32 bytes, matching `openssl rand -base64 32`. RandomNumberGenerator is the
# cryptographic source on Windows PowerShell 5.1 and PowerShell 7 alike.
# Get-Random is NOT one and must never be substituted here.
$bytes = New-Object 'System.Byte[]' 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $rng.GetBytes($bytes)
} finally {
    $rng.Dispose()
}
$secret = [System.Convert]::ToBase64String($bytes)
[System.Array]::Clear($bytes, 0, $bytes.Length)

# Base64 uses A-Z a-z 0-9 + / = and so can never contain a separator. Asserted
# rather than assumed: the whole keyring is unreadable if this is ever false.
if ($secret -match '[:,]') {
    throw 'The generated secret contains a separator. Refusing to emit a keyring that cannot be parsed back.'
}

$pair = '{0}:{1}' -f $Version, $secret

if ([string]::IsNullOrWhiteSpace($ExistingKeys)) {
    $keys = $pair
    $versions = @($Version)
} else {
    $existing = $ExistingKeys.Trim()
    $versions = @()
    foreach ($entry in $existing.Split(',')) {
        $separator = $entry.IndexOf(':')
        if ($separator -le 0) { continue }
        $versions += $entry.Substring(0, $separator).Trim()
    }
    if ($versions.Count -eq 0) {
        throw 'ExistingKeys held no readable `version:secret` pair. Pass the stored value exactly as it is.'
    }
    if ($versions -contains $Version) {
        throw "Version '$Version' is already in the keyring. Rotating adds a version; it never replaces one."
    }
    $keys = '{0},{1}' -f $existing, $pair
    $versions += $Version
}

Write-Host ''
Write-Host 'EMAIL_SNAPSHOT_KEYS' -ForegroundColor Cyan
Write-Host $keys
Write-Host ''

if ($versions.Count -gt 1) {
    Write-Host 'EMAIL_SNAPSHOT_KEY_VERSION' -ForegroundColor Cyan
    Write-Host $Version
    Write-Host ''
    Write-Host "$($versions.Count) versions in the keyring. Save both variables together -- saved apart, the deploy in between seals under the wrong version or under none." -ForegroundColor Yellow
} else {
    Write-Host 'One key: leave EMAIL_SNAPSHOT_KEY_VERSION unset. There is nothing to choose between.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Paste into Railway, redeploy, then check /api/ready reports emailSnapshotKeyring true.' -ForegroundColor DarkGray
Write-Host 'Nothing was written to disk. Clear this console.' -ForegroundColor DarkGray
Write-Host ''
