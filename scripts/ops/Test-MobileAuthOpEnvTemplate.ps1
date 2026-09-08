<#
.SYNOPSIS
    Synthetic check of the op.env template and the wrapper's pre-injected mode.

.DESCRIPTION
    Two things, and it is worth being clear which is which.

    **The template** is checked as a file: every value is a secret reference and
    not a secret, and only the two rings are in it. A plaintext ring committed
    here would be the one mistake this whole arrangement exists to prevent, and
    it would look exactly like a working env file.

    **The injection** is checked by doing what `op run` documents itself as
    doing -- resolving each reference and putting the value on the child
    process's environment -- with **synthetic values**, and then running the
    real wrapper against it. `Read-Host` and `npm` are shadowed with functions,
    so no key, no network and no npm process are involved.

    **This is not a check of `op run` or of the vault.** No 1Password binary is
    invoked and no reference is resolved against anything real. Whether these
    references name entries that exist, and whether the spaces and the em dash
    in their names survive a real resolution, is the separate real-vault step:
    docs/ops/mobile-auth-key-rotation.md section 6, item 1.

.EXAMPLE
    ./scripts/ops/Test-MobileAuthOpEnvTemplate.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if (Test-Path Variable:\PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$global:LASTEXITCODE = 0

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$template = Join-Path $repoRoot "docs/ops/mobile-auth-op-env.template"
$wrapper = Join-Path $PSScriptRoot "Check-MobileAuthKeyring.ps1"
foreach ($required in @($template, $wrapper)) {
    if (-not (Test-Path $required)) { throw "not found: $required" }
}

$RING_VARIABLES = @("MOBILE_AUTH_SIGNING_KEYS", "MOBILE_AUTH_REFRESH_PEPPERS")
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

# Synthetic, and recognisable if one ever escapes into output.
$SYNTHETIC = @{
    MOBILE_AUTH_SIGNING_KEYS    = "SYNTHETIC-SIGNING-RING-a41c7e"
    MOBILE_AUTH_REFRESH_PEPPERS = "SYNTHETIC-PEPPER-RING-6b02f9"
}

$global:results = @()
$global:promptCount = 0
$global:npmArgs = $null
$global:npmExit = 0
$global:npmSawSigning = $null
$global:npmSawPepper = $null

function Assert-Case {
    param([string] $Name, [bool] $Ok, [string] $Detail = "")
    $global:results += [pscustomobject]@{ Name = $Name; Ok = $Ok }
    $mark = if ($Ok) { "PASS" } else { "FAIL" }
    Write-Host ("{0}  {1}{2}" -f $mark, $Name, $(if ($Detail) { " -- $Detail" } else { "" }))
}

function Read-Host {
    param([string] $Prompt, [switch] $AsSecureString)
    $global:promptCount++
    return (ConvertTo-SecureString -String "SHOULD-NOT-BE-USED" -AsPlainText -Force)
}

function npm {
    $global:npmArgs = $args -join " "
    $global:npmSawSigning = $env:MOBILE_AUTH_SIGNING_KEYS
    $global:npmSawPepper = $env:MOBILE_AUTH_REFRESH_PEPPERS
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

<#
  The assignments in the template, as a name -> reference map.

  Deliberately strict about the shape: a line this parser silently skipped
  would be a line nobody checks, and an unchecked line in this file is where a
  plaintext ring would sit.

  Two things it will not do.

  It never puts the line in an error. The line is the thing under suspicion --
  if it is malformed, the reason may well be that somebody pasted a ring where
  a reference belongs, and quoting it back would print that ring to the screen
  and into whatever captured this run. Line number and, where it parsed, the
  variable name are enough to find it.

  It refuses a repeated name rather than overwriting. `op run` takes the last
  assignment, so a file that says the ring in plaintext and then says it again
  as a reference resolves correctly and still has the plaintext ring sitting in
  it -- and a parser that overwrites reports the file as clean.
#>
function Read-TemplateAssignments {
    param([string] $Path)

    $assignments = [ordered]@{}
    $lineNumber = 0
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $lineNumber++
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -notmatch '^(?<name>[A-Za-z_][A-Za-z0-9_]*)="(?<value>[^"]*)"$') {
            throw "line ${lineNumber} is neither blank, a comment, nor NAME=`"value`" (the line itself is not repeated here: it may be a secret)"
        }
        $name = $Matches.name
        if ($assignments.Contains($name)) {
            throw "line ${lineNumber} assigns ${name} again; op run would take the last one and the earlier line would go unchecked"
        }
        $assignments[$name] = $Matches.value
    }
    return $assignments
}

# --- 1. the template is references, and only the two rings -------------------
#
# Reported as a failed case rather than left to propagate: an uncaught throw
# ends the run before the other cases say anything, and the one line an
# operator then reads is a stack trace.
$assignments = $null
try {
    $assignments = Read-TemplateAssignments -Path $template
    Assert-Case "1z. the template parses" $true ""
}
catch {
    Assert-Case "1z. the template parses" $false $_.Exception.Message
}
if ($null -eq $assignments) {
    Write-Host ""
    Write-Host "1 case(s), 1 failed"
    exit 1
}
$names = @($assignments.Keys)
$unexpected = @($names | Where-Object { $RING_VARIABLES -notcontains $_ })
$missing = @($RING_VARIABLES | Where-Object { $names -notcontains $_ })
Assert-Case "1a. the template assigns exactly the two rings" `
    (($unexpected.Count -eq 0) -and ($missing.Count -eq 0)) `
    ("unexpected: [{0}] missing: [{1}]" -f ($unexpected -join ", "), ($missing -join ", "))

# A reference is a pointer; a value here would be a committed secret.
$notReferences = @($names | Where-Object { -not $assignments[$_].StartsWith("op://") })
Assert-Case "1b. every value is an op:// reference, never a value" `
    ($notReferences.Count -eq 0) ("plaintext: {0}" -f ($notReferences -join ", "))
$malformed = @($names | Where-Object {
    # vault / item / field, with the optional section making four. Empty
    # segments are counted too: "op://vault//field" splits into three and names
    # no item.
    $segments = @($assignments[$_].Substring("op://".Length) -split "/")
    ($segments.Count -lt 3) -or (@($segments | Where-Object { $_ -eq "" }).Count -gt 0)
})
Assert-Case "1c. each reference names a vault, an item and a field, none of them empty" `
    ($malformed.Count -eq 0) ("malformed: {0}" -f ($malformed -join ", "))

# The parser's own refusals, checked here rather than left to a stack trace an
# operator would read after the fact.
$parseRefusals = @(
    @{ Name = "a plaintext value where a reference belongs"; Line = 'MOBILE_AUTH_SIGNING_KEYS=sign-2:PLAINTEXT-RING-8fa213' },
    @{ Name = "the same variable assigned twice"; Line = "MOBILE_AUTH_SIGNING_KEYS=`"op://v/i/f`"" }
)
$refusalFailures = @()
foreach ($refusal in $parseRefusals) {
    $scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("op-env-{0}.template" -f [guid]::NewGuid())
    try {
        # A valid file plus the offending line, which is the shape that matters:
        # the earlier lines resolve, so nothing else notices.
        Set-Content -LiteralPath $scratch -Value (@(Get-Content -LiteralPath $template) + $refusal.Line)
        $message = $null
        try {
            $null = Read-TemplateAssignments -Path $scratch
            $refusalFailures += ("{0}: accepted" -f $refusal.Name)
        }
        catch {
            $message = $_.Exception.Message
        }
        if ($message) {
            if ($message -like "*PLAINTEXT-RING-8fa213*") {
                $refusalFailures += ("{0}: the refusal quoted the line" -f $refusal.Name)
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $scratch -ErrorAction SilentlyContinue
    }
}
Assert-Case "1d. a bad line is refused, and the refusal does not repeat it" `
    ($refusalFailures.Count -eq 0) ($refusalFailures -join "; ")

# --- 2. the injection, as op run performs it ---------------------------------
function Invoke-WithInjection {
    param([int] $NpmExit = 0, [switch] $SkipInjection)

    $global:promptCount = 0
    $global:npmArgs = $null
    $global:npmSawSigning = $null
    $global:npmSawPepper = $null
    $global:npmExit = $NpmExit
    Clear-Managed

    if (-not $SkipInjection) {
        # What `op run` does: the resolved value on the child's environment.
        foreach ($name in $RING_VARIABLES) {
            Set-Item -Path ("Env:\{0}" -f $name) -Value $SYNTHETIC[$name]
        }
    }

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
            -RequireConfigured -UsePreinjectedRings *>&1 | Out-String
    }
    catch {
        $threw = $true
        $output = $_ | Out-String
    }

    [pscustomobject]@{
        # Whitespace-collapsed as well as raw: Windows PowerShell 5.1 wraps host
        # output at the console width, so a phrase written as one line can
        # arrive split across two. An assertion that fails on the console being
        # narrow is testing the console.
        Flattened  = ($output -replace "\s+", " ")
        Output     = $output
        ExitCode   = $(if ($threw) { 1 } else { $LASTEXITCODE })
        Leftover   = (Get-LeftoverManaged)
        NpmArgs    = $global:npmArgs
        SawSigning = $global:npmSawSigning
        SawPepper  = $global:npmSawPepper
        Prompts    = $global:promptCount
    }
}

$injected = Invoke-WithInjection
Assert-Case "2a. nothing is prompted for" ($injected.Prompts -eq 0) `
    ("prompts={0}" -f $injected.Prompts)
# The point of the mode: what op run injected is what the check reads.
Assert-Case "2b. the injected rings reach the check unchanged" `
    (($injected.SawSigning -eq $SYNTHETIC.MOBILE_AUTH_SIGNING_KEYS) -and
     ($injected.SawPepper -eq $SYNTHETIC.MOBILE_AUTH_REFRESH_PEPPERS)) `
    ("signing matched: {0}" -f ($injected.SawSigning -eq $SYNTHETIC.MOBILE_AUTH_SIGNING_KEYS))
Assert-Case "2c. the check ran with -RequireConfigured" `
    ($injected.NpmArgs -like "*--require-configured*") ("npm args: {0}" -f $injected.NpmArgs)
Assert-Case "2d. success returns 0" ($injected.ExitCode -eq 0) `
    ("exit={0}" -f $injected.ExitCode)

$failing = Invoke-WithInjection -NpmExit 1
Assert-Case "2e. the check's failure is returned, not swallowed" `
    ($failing.ExitCode -ne 0) ("exit={0}" -f $failing.ExitCode)

# --- 3. refusal, cleanup, and no value in any stream -------------------------
$notInjected = Invoke-WithInjection -SkipInjection
Assert-Case "3a. a missing injection fails without running the check" `
    (($notInjected.ExitCode -ne 0) -and ($null -eq $notInjected.NpmArgs) -and
     ($notInjected.Flattened -match "Nothing injected it")) `
    ("exit={0} npmArgs=[{1}]" -f $notInjected.ExitCode, $notInjected.NpmArgs)

foreach ($run in @(
    @{ Name = "success"; Result = $injected },
    @{ Name = "failure"; Result = $failing },
    @{ Name = "no injection"; Result = $notInjected }
)) {
    Assert-Case ("3b. environment cleared after {0}" -f $run.Name) `
        ($run.Result.Leftover.Count -eq 0) ("left: {0}" -f ($run.Result.Leftover -join ", "))
}

$leaked = @()
foreach ($run in @($injected, $failing, $notInjected)) {
    foreach ($value in $SYNTHETIC.Values) {
        if ($run.Output -like "*$value*") { $leaked += $value }
    }
}
Assert-Case "3c. no injected ring appears in any stream" ($leaked.Count -eq 0) `
    ("leaked: {0}" -f $leaked.Count)
Assert-Case "3d. the signing ring's length is reported" `
    ($injected.Flattened -match ("MOBILE_AUTH_SIGNING_KEYS length: {0}\b" -f $SYNTHETIC.MOBILE_AUTH_SIGNING_KEYS.Length)) ""

$failed = @($global:results | Where-Object { -not $_.Ok })
Write-Host ""
Write-Host "Synthetic only: no 1Password binary was run and no reference was resolved."
Write-Host "The real op run and vault check is a separate step (rotation runbook section 6, item 1)."
Write-Host ("{0} case(s), {1} failed" -f $global:results.Count, $failed.Count)
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
