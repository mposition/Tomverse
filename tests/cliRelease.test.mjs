import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLI_DOWNLOAD_BASE,
  CLI_FILES,
  CLI_RELEASE_PAGE,
  CLI_RELEASE_TAG,
  CLI_VERSION,
  cliFile,
  cliRecommendedFile,
  detectCliPlatform,
} from "../components/marketing/v2/cli/cliRelease.ts";

const UA = {
  winChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  linuxArmFirefox: "Mozilla/5.0 (X11; Linux aarch64; rv:132.0) Gecko/20100101 Firefox/132.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

test("CLI_VERSION is the version apps/tomverse-cli publishes", () => {
  const { version } = JSON.parse(readFileSync("apps/tomverse-cli/package.json", "utf8"));
  assert.equal(CLI_VERSION, version);
  assert.equal(CLI_RELEASE_TAG, `cli-v${version}`);
});

test("download URLs are built from the version on the cli-v1.0.0 GitHub Release", () => {
  assert.equal(CLI_VERSION, "1.0.0");
  assert.equal(CLI_DOWNLOAD_BASE, "https://github.com/mposition/Tomverse/releases/download/cli-v1.0.0/");
  assert.equal(CLI_RELEASE_PAGE, "https://github.com/mposition/Tomverse/releases/tag/cli-v1.0.0");
  assert.deepEqual(CLI_FILES.map((file) => file.name), [
    "tomverse-1.0.0-windows-x64.msi",
    "tomverse-1.0.0-windows-arm64.msi",
    "tomverse-1.0.0-macos-arm64.pkg",
    "tomverse-1.0.0-macos-x64.pkg",
    "tomverse-1.0.0-linux-x64.deb",
    "tomverse-1.0.0-linux-arm64.deb",
    "tomverse-1.0.0-linux-x64.rpm",
    "tomverse-1.0.0-linux-arm64.rpm",
  ]);
  for (const file of CLI_FILES) {
    assert.equal(file.url, `${CLI_DOWNLOAD_BASE}${file.name}`);
    assert.equal(file.sha256Url, `${file.url}.sha256`);
  }
  assert.equal(cliFile("windows", "x64", "msi").url, "https://github.com/mposition/Tomverse/releases/download/cli-v1.0.0/tomverse-1.0.0-windows-x64.msi");
});

test("the recommended installer follows the operating system and CPU", () => {
  assert.equal(cliRecommendedFile("windows", "arm64").name, "tomverse-1.0.0-windows-arm64.msi");
  assert.equal(cliRecommendedFile("macos", "arm64").name, "tomverse-1.0.0-macos-arm64.pkg");
  assert.equal(cliRecommendedFile("macos", "x64").name, "tomverse-1.0.0-macos-x64.pkg");
  assert.equal(cliRecommendedFile("linux", "x64").name, "tomverse-1.0.0-linux-x64.deb");
});

test("detectCliPlatform: desktop systems and the CPU defaults", () => {
  assert.deepEqual(detectCliPlatform({ userAgent: UA.winChrome, platform: "Win32" }), { os: "windows", arch: "x64", mobile: false });
  // Safari and Firefox cannot tell Apple silicon from Intel: Apple silicon is the default.
  assert.deepEqual(detectCliPlatform({ userAgent: UA.macSafari, platform: "MacIntel" }), { os: "macos", arch: "arm64", mobile: false });
  assert.deepEqual(detectCliPlatform({ userAgent: UA.linuxFirefox, platform: "Linux x86_64" }), { os: "linux", arch: "x64", mobile: false });
  assert.deepEqual(detectCliPlatform({ userAgent: UA.linuxArmFirefox, platform: "Linux aarch64" }), { os: "linux", arch: "arm64", mobile: false });
});

test("detectCliPlatform: userAgentData tells Arm apart where the user agent string cannot", () => {
  // Chromium on Windows for Arm still says x64 in the user agent string.
  assert.equal(detectCliPlatform({ userAgent: UA.winChrome, platform: "Win32", uaData: { platform: "Windows", mobile: false, architecture: "arm", bitness: "64" } }).arch, "arm64");
  assert.equal(detectCliPlatform({ userAgent: UA.winChrome, platform: "Win32", uaData: { platform: "Windows", mobile: false, architecture: "x86", bitness: "64" } }).arch, "x64");
  // Chromium on an Intel Mac says Intel, and so it does on Apple silicon.
  assert.deepEqual(detectCliPlatform({ userAgent: UA.macChrome, platform: "MacIntel", uaData: { platform: "macOS", mobile: false, architecture: "arm", bitness: "64" } }), { os: "macos", arch: "arm64", mobile: false });
  assert.deepEqual(detectCliPlatform({ userAgent: UA.macChrome, platform: "MacIntel", uaData: { platform: "macOS", mobile: false, architecture: "x86", bitness: "64" } }), { os: "macos", arch: "x64", mobile: false });
  // Low-entropy data (no architecture) falls back to the defaults.
  assert.deepEqual(detectCliPlatform({ userAgent: UA.macChrome, platform: "MacIntel", uaData: { platform: "macOS", mobile: false } }), { os: "macos", arch: "arm64", mobile: false });
});

test("detectCliPlatform: phones and tablets get no operating system", () => {
  for (const [userAgent, platform] of [[UA.android, "Linux armv81"], [UA.androidTablet, "Linux armv81"], [UA.iphone, "iPhone"]]) {
    assert.equal(detectCliPlatform({ userAgent, platform }).mobile, true, userAgent);
    assert.equal(detectCliPlatform({ userAgent, platform }).os, null, userAgent);
  }
  assert.equal(detectCliPlatform({ userAgent: UA.android, uaData: { mobile: true, platform: "Android" } }).mobile, true);
  // An iPad asks for the desktop site and says it is a Mac; only its touch screen gives it away.
  assert.deepEqual(detectCliPlatform({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 5 }), { os: null, arch: "x64", mobile: true });
  assert.equal(detectCliPlatform({ userAgent: UA.macSafari, platform: "MacIntel", maxTouchPoints: 0 }).mobile, false);
});

test("detectCliPlatform: an unknown system has no operating system but is not mobile", () => {
  assert.deepEqual(detectCliPlatform({ userAgent: UA.chromeOs, platform: "Linux x86_64" }).os, null);
  assert.deepEqual(detectCliPlatform({ userAgent: "", platform: "" }), { os: null, arch: "x64", mobile: false });
});
