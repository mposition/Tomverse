/**
 * Tomverse CLI release facts for the install page and Settings: the version, where
 * each installer is published and how a visitor's operating system is read.
 * Pure (no React, no DOM), so it is unit tested and importable from client components.
 *
 * Every download URL is built here from the version. CLI_VERSION must equal
 * apps/tomverse-cli/package.json `version` (tests/cliRelease.test.mjs); the files
 * exist only once the GitHub Release `cli-v<version>` is published
 * (apps/tomverse-cli/RELEASING.md).
 */

export const CLI_VERSION = "1.0.0";
export const CLI_RELEASE_TAG = `cli-v${CLI_VERSION}`;
const CLI_REPOSITORY = "https://github.com/mposition/Tomverse";
export const CLI_DOWNLOAD_BASE = `${CLI_REPOSITORY}/releases/download/${CLI_RELEASE_TAG}/`;
export const CLI_RELEASE_PAGE = `${CLI_REPOSITORY}/releases/tag/${CLI_RELEASE_TAG}`;

export const CLI_PACKAGE = "@tomverse/cli";
export const CLI_WINGET_ID = "Tomverse.CLI";

export type CliOs = "windows" | "macos" | "linux";
export type CliArch = "x64" | "arm64";
export type CliInstallerKind = "msi" | "pkg" | "deb" | "rpm";

export const CLI_OS_LIST: readonly CliOs[] = ["windows", "macos", "linux"];
/** Display names; product names, never translated. */
export const CLI_OS_NAMES: Record<CliOs, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export type CliFile = {
  os: CliOs;
  arch: CliArch;
  kind: CliInstallerKind;
  name: string;
  url: string;
  sha256Url: string;
};

/** The installer file of one operating system, CPU and format, for example tomverse-1.0.0-windows-x64.msi. */
export function cliFile(os: CliOs, arch: CliArch, kind: CliInstallerKind): CliFile {
  const name = `tomverse-${CLI_VERSION}-${os}-${arch}.${kind}`;
  return { os, arch, kind, name, url: `${CLI_DOWNLOAD_BASE}${name}`, sha256Url: `${CLI_DOWNLOAD_BASE}${name}.sha256` };
}

/** The format each operating system's main installer uses; Linux has two (.deb and .rpm). */
export const CLI_PRIMARY_KIND: Record<CliOs, CliInstallerKind> = { windows: "msi", macos: "pkg", linux: "deb" };

/** Every installer the release carries, in the order the download table lists them. */
export const CLI_FILES: readonly CliFile[] = [
  cliFile("windows", "x64", "msi"),
  cliFile("windows", "arm64", "msi"),
  cliFile("macos", "arm64", "pkg"),
  cliFile("macos", "x64", "pkg"),
  cliFile("linux", "x64", "deb"),
  cliFile("linux", "arm64", "deb"),
  cliFile("linux", "x64", "rpm"),
  cliFile("linux", "arm64", "rpm"),
];

/** The installer to recommend for a detected operating system and CPU. */
export const cliRecommendedFile = (os: CliOs, arch: CliArch): CliFile => cliFile(os, arch, CLI_PRIMARY_KIND[os]);

/** What a browser can tell us. `uaData` is navigator.userAgentData, with the high-entropy values merged in when they were read. */
export type CliPlatformInput = {
  userAgent: string;
  /** navigator.platform. */
  platform?: string;
  maxTouchPoints?: number;
  uaData?: { platform?: string; mobile?: boolean; architecture?: string; bitness?: string } | null;
};

export type CliPlatform = {
  /** null when the visitor is on a phone or tablet, or on a system there is no installer for. */
  os: CliOs | null;
  arch: CliArch;
  mobile: boolean;
};

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i;

/**
 * Reads the visitor's operating system and CPU. Phones and tablets get `mobile: true`
 * and no operating system, because none of the installers runs there (an iPad that
 * reports a Mac, and Android that reports Linux, are both caught).
 *
 * The CPU is a best guess: Chromium reports it only through userAgentData; Safari and
 * Firefox on a Mac cannot tell Apple silicon from Intel, so the default there is Apple
 * silicon, and everywhere else it is x64 unless the browser says Arm.
 */
export function detectCliPlatform(input: CliPlatformInput): CliPlatform {
  const ua = input.userAgent || "";
  const platform = input.platform || "";
  const uaPlatform = input.uaData?.platform || "";
  const touchMac = /Mac/i.test(platform) && (input.maxTouchPoints ?? 0) > 1;
  if (input.uaData?.mobile === true || MOBILE_UA.test(ua) || touchMac) return { os: null, arch: "x64", mobile: true };

  const hint = `${uaPlatform} ${platform} ${ua}`;
  const os: CliOs | null = /Win/i.test(uaPlatform || platform || ua) ? "windows"
    : /mac/i.test(uaPlatform || platform) || (!uaPlatform && !platform && /Macintosh|Mac OS X/i.test(ua)) ? "macos"
    : /Linux|X11/i.test(hint) && !/CrOS/i.test(hint) ? "linux"
    : null;

  const reported = (input.uaData?.architecture || "").toLowerCase();
  const bitness = input.uaData?.bitness || "";
  const arm = reported
    ? reported.startsWith("arm")
    : /ARM64|aarch64|armv8/i.test(ua) || /aarch64|arm64/i.test(platform);
  const x86 = reported.startsWith("x86") || (!reported && /x86_64|x64|Win64|WOW64|amd64/i.test(ua));
  // 32-bit Arm has no installer; it is as unsupported as it can be, so recommend the 64-bit one.
  const arch: CliArch = arm && bitness !== "32" ? "arm64"
    : x86 ? "x64"
    : os === "macos" ? "arm64"
    : "x64";
  return { os, arch, mobile: false };
}
