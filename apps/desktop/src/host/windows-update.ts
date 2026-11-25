import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const version = z.string().regex(/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/)
  .transform((value) => value.split(".").map(Number))
  .refine((parts) => parts.every((part) => part <= 65535));
const release = z.object({
  channel: z.literal("stable"), platform: z.literal("win32"), arch: z.literal("x64"),
  version: version, url: z.url(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.int().positive().max(512 * 1024 * 1024),
});

async function* limitedBody(response: Response, limit: number) {
  if (response.status !== 200 || !response.body) throw new Error("The update response is unavailable.");
  const reader = response.body.getReader();
  let read = 0;
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) { complete = true; break; }
      read += result.value.byteLength;
      if (read > limit) throw new Error("The update response exceeded its expected size.");
      yield result.value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function prepareWindowsUpdate(fetchUpdate: (url: string, options: RequestInit) => Promise<Response>,
  feed: URL, installed: string, profile: string,
  onDownload: () => void, verifyPackage = verifyWindowsPackage) {
  const request = { credentials: "omit", redirect: "error", cache: "no-store" } as const;
  const metadata = await fetchUpdate(feed.href, { ...request, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (metadata.status === 204) return null;
  const chunks = [];
  for await (const bytes of limitedBody(metadata, 8 * 1024)) chunks.push(bytes);
  const update = release.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const current = version.parse(installed);
  const difference = update.version[0]! - current[0]! || update.version[1]! - current[1]! || update.version[2]! - current[2]!;
  if (difference === 0) return null;
  if (difference < 0) throw new Error("The update is older than the installed version.");
  const source = new URL(update.url);
  if (source.origin !== feed.origin || source.protocol !== "https:" || source.username || source.password ||
      source.hash || !source.pathname.endsWith(".msix")) throw new Error("The update is outside the Windows release channel.");

  onDownload();
  const directory = await mkdtemp(join(profile, "update-"));
  const path = join(directory, "Tomverse-Desktop.msix");
  const remove = async () => {
    await unlink(path).catch(() => {});
    await rmdir(directory).catch(() => {});
  };
  try {
    const response = await fetchUpdate(source.href, { ...request, signal: AbortSignal.timeout(15 * 60_000) });
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const bytes of limitedBody(response, update.size)) {
        await file.writeFile(bytes);
        hash.update(bytes);
        size += bytes.byteLength;
      }
    } finally { await file.close(); }
    if (size !== update.size || hash.digest("hex") !== update.sha256) throw new Error("The update did not match its published size and hash.");
    await verifyPackage(path, [...update.version, 0].join("."));
    return { url: pathToFileURL(path).href, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

// Windows validates Authenticode trust. Pin the signer and package identity to
// the installed app before asking the native updater to stage the local file.
const verifyPackageScript = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-Identity($stream) {
  $reader = [Xml.XmlReader]::Create($stream, [Xml.XmlReaderSettings]::new())
  try {
    $doc = [Xml.XmlDocument]::new()
    $doc.Load($reader)
    return $doc.DocumentElement.SelectSingleNode("*[local-name()='Identity']")
  } finally { $reader.Dispose() }
}
$installed = Join-Path $env:TOMVERSE_UPDATE_INSTALL_DIR 'AppxManifest.xml'
$stream = [IO.File]::OpenRead($installed)
try { $current = Read-Identity $stream } finally { $stream.Dispose() }
$bytes = [IO.File]::ReadAllBytes((Join-Path $env:TOMVERSE_UPDATE_INSTALL_DIR 'AppxSignature.p7x'))
if ($bytes.Length -lt 5 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -cne 'PKCX') { throw 'Invalid installed package signature.' }
$cms = [Security.Cryptography.Pkcs.SignedCms]::new()
$cms.Decode([byte[]]$bytes[4..($bytes.Length - 1)])
if ($cms.SignerInfos.Count -ne 1 -or !$cms.SignerInfos[0].Certificate) { throw 'Missing installed package signer.' }
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $env:TOMVERSE_UPDATE_FILE
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or
    [Convert]::ToBase64String($signature.SignerCertificate.RawData) -cne [Convert]::ToBase64String($cms.SignerInfos[0].Certificate.RawData)) {
  throw 'The update package does not have the installed package signer.'
}
$archive = [IO.Compression.ZipFile]::OpenRead($env:TOMVERSE_UPDATE_FILE)
try {
  $manifest = $archive.GetEntry('AppxManifest.xml')
  if (!$manifest -or $manifest.Length -gt 65536) { throw 'Invalid update package manifest.' }
  $stream = $manifest.Open()
  try { $candidate = Read-Identity $stream } finally { $stream.Dispose() }
  if (!$current -or !$candidate -or $current.Name -cne 'Tomverse.Desktop' -or $candidate.Name -cne $current.Name -or
      $candidate.Publisher -cne $current.Publisher -or $candidate.ProcessorArchitecture -cne $current.ProcessorArchitecture -or
      $candidate.Version -cne $env:TOMVERSE_UPDATE_VERSION -or [version]$candidate.Version -le [version]$current.Version) {
    throw 'Unexpected update package identity.'
  }
} finally { $archive.Dispose() }
`;

export async function verifyWindowsPackage(path: string, version: string, installDirectory = dirname(process.execPath)) {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const temp = process.env.TEMP || process.env.TMP || tmpdir();
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await promisify(execFile)(powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(verifyPackageScript, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 60_000, env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: temp, TMP: temp,
      TOMVERSE_UPDATE_FILE: path,
      TOMVERSE_UPDATE_VERSION: version, TOMVERSE_UPDATE_INSTALL_DIR: installDirectory } });
}
