[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$')][string]$Version,
    [Parameter(Mandatory)][string]$ChannelDirectory,
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
$identity = 'Tomverse.Desktop.LocalDev'
$publisher = 'CN=Tomverse Desktop Local Dev'
$product = 'Tomverse-Desktop-Local-Dev'
$releaseVersion = [version]("${Version}.0")
if ($releaseVersion.Major -gt 65535 -or $releaseVersion.Minor -gt 65535 -or $releaseVersion.Build -gt 65535) {
    throw 'Each release version component must be at most 65535.'
}
$fullChannelPath = [IO.Path]::GetFullPath($ChannelDirectory)
if ($fullChannelPath -notmatch '^[A-Za-z]:\\' -or
    [IO.DriveInfo]::new([IO.Path]::GetPathRoot($fullChannelPath)).DriveType -ne [IO.DriveType]::Fixed) {
    throw 'Use a channel directory on a fixed local drive.'
}
$channel = (New-Item -Path $fullChannelPath -ItemType Directory -Force).FullName
$feed = Join-Path $channel "$product.appinstaller"
$asset = Join-Path $channel "$product-$releaseVersion-x64.msix"
$certificateFile = Join-Path $channel "$product.cer"
function Assert-ChannelVersion {
    if (Test-Path -LiteralPath $feed) {
        [xml]$previous = Get-Content -LiteralPath $feed -Raw
        if ($previous.AppInstaller.MainPackage.Name -cne $identity -or
            $previous.AppInstaller.MainPackage.Publisher -cne $publisher -or
            [version]$previous.AppInstaller.Version -gt $releaseVersion) {
            throw 'The App Installer channel belongs to another package or has a newer release.'
        }
    }
}
if (-not $BuildOnly) { Assert-ChannelVersion }

if (Test-Path -LiteralPath $certificateFile) {
    $publicCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certificateFile)
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($publicCertificate.Thumbprint)"
} else {
    if ((Test-Path -LiteralPath $feed) -or (Get-ChildItem -LiteralPath $channel -Filter '*.msix')) {
        throw 'Keep the original Local Dev signing certificate for this channel.'
    }
    $candidates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object {
        $_.Subject -ceq $publisher -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date)
    })
    if ($candidates.Count -gt 1) { throw 'Multiple Local Dev signing certificates match.' }
    $certificate = if ($candidates.Count -eq 1) { $candidates[0] } else {
        New-SelfSignedCertificate -Type CodeSigningCert -Subject $publisher -CertStoreLocation 'Cert:\CurrentUser\My' `
            -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
    }
    Export-Certificate -Cert $certificate -FilePath $certificateFile | Out-Null
}
if ($certificate.Subject -cne $publisher -or -not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date)) {
    throw 'The channel requires its original, unexpired Local Dev signing key.'
}
if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\TrustedPeople\$($certificate.Thumbprint)")) {
    throw "Register the public certificate in Local Computer Trusted People before publishing: $certificateFile"
}

if (-not (Test-Path -LiteralPath $asset)) {
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $tools = Get-ChildItem -LiteralPath $sdk -Directory | Where-Object {
        $_.Name -match '^10\.0\.\d+\.\d+$' -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\makeappx.exe')) -and
        (Test-Path -LiteralPath (Join-Path $_.FullName 'x64\signtool.exe'))
    } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (-not $tools) { throw 'Windows SDK x64 MakeAppx and SignTool are required.' }
    $stage = New-Item -Path (Join-Path $channel ('.build-' + [guid]::NewGuid().ToString('N'))) -ItemType Directory
    $previousChannel = $env:TOMVERSE_DESKTOP_LOCAL_DEV_UPDATE
    $env:TOMVERSE_DESKTOP_LOCAL_DEV_UPDATE = 'true'
    Push-Location (Join-Path $PSScriptRoot '..\..\..')
    try {
        & npm.cmd run desktop:package -- --dev-local --platform win32 --arch x64 --version $Version --out $stage.FullName
        if ($LASTEXITCODE -ne 0) { throw 'Building the Local Dev app failed.' }
        & npm.cmd run desktop:package:msix -- --dev-local --publisher $publisher --makeappx (Join-Path $tools.FullName 'x64\makeappx.exe') --out $stage.FullName
        if ($LASTEXITCODE -ne 0) { throw 'Creating the Local Dev MSIX failed.' }
        $candidate = Join-Path $stage.FullName ([IO.Path]::GetFileName($asset))
        & (Join-Path $tools.FullName 'x64\signtool.exe') sign /fd SHA256 /s My /sha1 $certificate.Thumbprint $candidate
        if ($LASTEXITCODE -ne 0) { throw 'Signing the Local Dev MSIX failed.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $candidate
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -cne $certificate.Thumbprint) {
            throw 'The candidate Local Dev MSIX signature is invalid.'
        }
        [IO.File]::Move($candidate, $asset)
    } finally {
        Pop-Location
        $env:TOMVERSE_DESKTOP_LOCAL_DEV_UPDATE = $previousChannel
        $resolvedStage = (Resolve-Path -LiteralPath $stage.FullName).Path
        if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $channel -and ([IO.Path]::GetFileName($resolvedStage) -match '^\.build-[a-f0-9]{32}$')) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}

$publishedSignature = Get-AuthenticodeSignature -LiteralPath $asset
if ($publishedSignature.Status -ne 'Valid' -or $publishedSignature.SignerCertificate.Thumbprint -cne $certificate.Thumbprint) {
    throw 'The Local Dev update asset must have a trusted signature from the channel certificate.'
}
$archive = [IO.Compression.ZipFile]::OpenRead($asset)
try {
    $manifest = $archive.GetEntry('AppxManifest.xml')
    if (-not $manifest -or $manifest.Length -gt 65536) { throw 'Invalid MSIX manifest.' }
    $reader = [Xml.XmlReader]::Create($manifest.Open(), [Xml.XmlReaderSettings]@{ CloseInput = $true })
    try {
        $document = [Xml.XmlDocument]::new()
        $document.Load($reader)
        $actual = $document.DocumentElement.SelectSingleNode("*[local-name()='Identity']")
        if (-not $actual -or $actual.Name -cne $identity -or $actual.Publisher -cne $publisher -or
            $actual.Version -cne $releaseVersion.ToString() -or $actual.ProcessorArchitecture -cne 'x64') {
            throw 'The signed package does not match the Local Dev release identity.'
        }
    } finally { $reader.Dispose() }
} finally { $archive.Dispose() }

if (-not $BuildOnly) {
    $feedUri = [Security.SecurityElement]::Escape(([uri]$feed).AbsoluteUri)
    $assetUri = [Security.SecurityElement]::Escape(([uri]$asset).AbsoluteUri)
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<AppInstaller xmlns="http://schemas.microsoft.com/appx/appinstaller/2018" Version="$releaseVersion" Uri="$feedUri">
  <MainPackage Name="$identity" Publisher="$publisher" Version="$releaseVersion" ProcessorArchitecture="x64" Uri="$assetUri" />
  <UpdateSettings>
    <OnLaunch HoursBetweenUpdateChecks="0" ShowPrompt="true" UpdateBlocksActivation="true" />
    <AutomaticBackgroundTask />
  </UpdateSettings>
</AppInstaller>
"@
    $temporaryFeed = Join-Path $channel ([guid]::NewGuid().ToString('N') + '.appinstaller.tmp')
    $backupFeed = $temporaryFeed + '.previous'
    $publishLock = [IO.File]::Open((Join-Path $channel '.publish.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try {
        Assert-ChannelVersion
        [IO.File]::WriteAllText($temporaryFeed, $xml, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($feed)) { [IO.File]::Replace($temporaryFeed, $feed, $backupFeed) }
        else { [IO.File]::Move($temporaryFeed, $feed) }
    } finally {
        $publishLock.Dispose()
        if ([IO.File]::Exists($temporaryFeed)) { [IO.File]::Delete($temporaryFeed) }
        if ([IO.File]::Exists($feed) -and [IO.File]::Exists($backupFeed)) { [IO.File]::Delete($backupFeed) }
    }

    # App Installer's launch check never blocks a packaged desktop app: Windows starts the installed
    # build first and can only apply the release on the launch after that. Update this PC's Local Dev
    # install now instead: at once when the app is closed, or at its next launch while it is running.
    # The Appx module loads only in Windows PowerShell.
    $localInstall = & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -NonInteractive -Command {
        param($Identity, $Feed, $Asset, $Version)
        $ErrorActionPreference = 'Stop'
        try {
            $installed = Get-AppxPackage -Name $Identity
            if (-not $installed) { return 'not installed on this PC' }
            if ([version]$installed.Version -ge [version]$Version) { return "already $($installed.Version)" }
            $root = $installed.InstallLocation.TrimEnd('\') + '\'
            $running = @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
            if ($running.Count -eq 0) {
                try {
                    Add-AppxPackage -Path $Feed -AppInstallerFile
                    return 'installed now'
                } catch {
                    # The app was started after the check above; fall back to the next launch.
                    if ($_.Exception.HResult -ne 0x80073D02 -and $_.Exception.Message -notmatch '0x80073D02') { throw }
                }
            }
            Add-AppxPackage -Path $Asset -DeferRegistrationWhenPackagesAreInUse
            return 'applies at the next launch'
        } catch {
            return "failed: $($_.Exception.Message.Trim())"
        }
    } -args $identity, $feed, $asset, $releaseVersion.ToString()
    $localInstall = @($localInstall | Where-Object { $_ -is [string] })[-1]
    if (-not $localInstall -or $localInstall.StartsWith('failed')) {
        Write-Warning "The channel is published, but this PC's Local Dev install was not updated ($localInstall). Close the app and run: Add-AppxPackage -AppInstallerFile '$feed'"
    }
}

[pscustomobject]@{
    Package = $asset
    AppInstaller = if (-not $BuildOnly) { $feed }
    LocalInstall = if (-not $BuildOnly) { $localInstall }
    Version = $releaseVersion.ToString()
    Signer = $certificate.Thumbprint
    SHA256 = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash
}
