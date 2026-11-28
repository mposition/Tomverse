[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Previous,
    [Parameter(Mandatory = $true)][string]$Update
)

$ErrorActionPreference = 'Stop'
$identityName = 'Tomverse.Desktop'
$executableName = 'Tomverse Desktop.exe'
$profileName = 'Tomverse Desktop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;

public static class TomversePackageActivation {
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ActivationManager {}

    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivationManager {
        void ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options, out int processId);
    }

    public static int Start(string appId) {
        var manager = (IActivationManager)new ActivationManager();
        try {
            int processId;
            manager.ActivateApplication(appId, null, 0, out processId);
            return processId;
        } finally {
            Marshal.ReleaseComObject(manager);
        }
    }
}
'@

function Read-Candidate([string]$InputPath) {
    $file = Get-Item -LiteralPath $InputPath
    if ($file.PSIsContainer -or $file.Extension -ne '.msix') { throw "Expected an MSIX file: $InputPath" }
    $archive = [System.IO.Compression.ZipFile]::OpenRead($file.FullName)
    try {
        $entry = $archive.GetEntry('AppxManifest.xml')
        if (-not $entry) { throw "MSIX manifest missing: $InputPath" }
        $reader = [System.IO.StreamReader]::new($entry.Open())
        try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $archive.Dispose()
    }
    $identity = $manifest.Package.Identity
    $application = $manifest.Package.Applications.Application
    if ($identity.Name -cne $identityName -or $identity.ProcessorArchitecture -ne 'x64' -or
        $application.Id -cne 'Desktop' -or $application.Executable -cne $executableName) {
        throw "Unexpected Tomverse Desktop package identity or executable: $InputPath"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
        throw "A trusted MSIX signature is required ($($signature.Status)): $InputPath"
    }
    [pscustomobject]@{
        Path = $file.FullName
        Publisher = $identity.Publisher
        Version = [version]$identity.Version
        Signer = $signature.SignerCertificate.Thumbprint
        Sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}

function Get-DesktopPackage {
    Get-AppxPackage -Name $identityName | Where-Object Name -CEQ $identityName
}

function Install-Candidate($candidate) {
    if ((Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $candidate.Sha256) {
        throw 'The signed MSIX changed after verification.'
    }
    Add-AppxPackage -Path $candidate.Path
    $installed = Get-DesktopPackage
    if (-not $installed -or $installed.Publisher -cne $candidate.Publisher -or $installed.Version -ne $candidate.Version) {
        throw "Windows did not register the expected package version $($candidate.Version)."
    }
    $installed
}

function Test-InstalledLaunch($installed) {
    $processId = [TomversePackageActivation]::Start("$($installed.PackageFamilyName)!Desktop")
    $app = Get-Process -Id $processId
    if ($app.Path -ne (Join-Path $installed.InstallLocation $executableName)) {
        throw 'Windows activated a process outside the expected installed package.'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    try {
        do {
            $app.Refresh()
            if ($app.HasExited) { throw "Installed Desktop exited with code $($app.ExitCode)." }
            if ($app.MainWindowTitle -eq $profileName) { return }
            Start-Sleep -Milliseconds 150
        } while ([DateTime]::UtcNow -lt $deadline)
        throw 'Installed Desktop did not show its window.'
    } finally {
        if (-not $app.HasExited -and (-not $app.CloseMainWindow() -or -not $app.WaitForExit(8000))) {
            throw 'Installed Desktop did not close cleanly.'
        }
    }
}

function Get-ProfileBounds($installed) {
    $roamingProfile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $profileName
    $localPackages = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Packages'
    $packageData = Join-Path $localPackages $installed.PackageFamilyName
    $files = @(Get-Item -LiteralPath (Join-Path $roamingProfile 'window-bounds.json') -ErrorAction SilentlyContinue)
    if (Test-Path -LiteralPath $packageData) {
        $files += @(Get-ChildItem -LiteralPath $packageData -Recurse -File -Filter 'window-bounds.json')
    }
    if ($files.Count -ne 1) { throw 'Expected one window-bounds file in the disposable Desktop profile.' }
    $files[0]
}

$base = Read-Candidate $Previous
$next = Read-Candidate $Update
if ($base.Publisher -cne $next.Publisher -or $base.Signer -ne $next.Signer -or $base.Version -ge $next.Version) {
    throw 'Use two ascending versions of the same package signed by the same test certificate.'
}
$profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $profileName
$packages = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Packages'
$existingPackageData = Get-ChildItem -LiteralPath $packages -Directory -Filter "${identityName}_*" -ErrorAction SilentlyContinue
if ((Get-DesktopPackage) -or $existingPackageData -or (Test-Path -LiteralPath $profile) -or
    (Get-Process -Name $profileName -ErrorAction SilentlyContinue)) {
    throw 'Run this test in a disposable Windows user session with no existing Tomverse Desktop installation or profile.'
}

try {
    $installedBase = Install-Candidate $base
    Test-InstalledLaunch $installedBase
    $bounds = Get-ProfileBounds $installedBase
    $before = (Get-FileHash -LiteralPath $bounds.FullName -Algorithm SHA256).Hash
    $installedNext = Install-Candidate $next
    if ($installedBase.PackageFamilyName -cne $installedNext.PackageFamilyName) { throw 'The package family changed on update.' }
    $after = Get-ProfileBounds $installedNext
    if ($after.FullName -ne $bounds.FullName -or (Get-FileHash -LiteralPath $after.FullName -Algorithm SHA256).Hash -ne $before) {
        throw 'The actual app profile changed during the Windows package update.'
    }
    Test-InstalledLaunch $installedNext
    Remove-AppxPackage -Package $installedNext.PackageFullName
    if (Get-DesktopPackage) { throw 'Windows still reports the current-user package after uninstall.' }
    $reinstalled = Install-Candidate $next
    Test-InstalledLaunch $reinstalled
} finally {
    $remaining = Get-DesktopPackage
    if ($remaining -and $remaining.Publisher -ceq $base.Publisher -and $remaining.Version -in @($base.Version, $next.Version)) {
        Remove-AppxPackage -Package $remaining.PackageFullName
    }
}
if (Get-DesktopPackage) { throw 'The test package is still registered after cleanup.' }

$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
    windows = $os.Version
    architecture = $os.OSArchitecture
    packageFamily = $installedBase.PackageFamilyName
    previousVersion = "$($base.Version)"
    previousSha256 = $base.Sha256
    updatedVersion = "$($next.Version)"
    updatedSha256 = $next.Sha256
    signerThumbprint = $base.Signer
    cleanInstallLaunched = $true
    updatePreservedProfile = $true
    uninstallVerified = $true
    reinstallLaunched = $true
} | ConvertTo-Json
