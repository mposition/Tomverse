import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { cliPageContent } from "@/components/marketing/v2/cli/cliPageContent";
import { CLI_DOWNLOAD_BASE, CLI_FILES, CLI_RELEASE_PAGE } from "@/components/marketing/v2/cli/cliRelease";

// The CLI install page (/developers/cli): a download button for the visitor's own system,
// OS tabs, the list of every installer, and update and uninstall commands. Every
// interactive part (OS detection, tabs, copy buttons, doctor terminal, motion control)
// must work without an inline script. The files themselves exist once the GitHub Release
// cli-v<version> is published, so these tests check the links, not the downloads.
test.setTimeout(90_000);

type Spoof = { userAgent: string; platform: string; uaData?: { platform: string; mobile: boolean; architecture?: string; bitness?: string } | null; maxTouchPoints?: number };

// The browser under test is whatever runs the suite, so the system it reports is set by the test.
const SYSTEMS = {
  windowsX64: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: "Win32", uaData: { platform: "Windows", mobile: false, architecture: "x86", bitness: "64" } },
  windowsArm: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: "Win32", uaData: { platform: "Windows", mobile: false, architecture: "arm", bitness: "64" } },
  macSafari: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", platform: "MacIntel", uaData: null },
  macIntelChrome: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: "MacIntel", uaData: { platform: "macOS", mobile: false, architecture: "x86", bitness: "64" } },
  linuxX64: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", platform: "Linux x86_64", uaData: null },
  android: { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36", platform: "Linux armv81", uaData: { platform: "Android", mobile: true }, maxTouchPoints: 5 },
} satisfies Record<string, Spoof>;

async function spoofSystem(page: Page, system: Spoof) {
  await page.addInitScript((value) => {
    const define = (name: string, getter: () => unknown) => Object.defineProperty(Navigator.prototype, name, { configurable: true, get: getter });
    define("userAgent", () => value.userAgent);
    define("platform", () => value.platform);
    define("maxTouchPoints", () => value.maxTouchPoints ?? 0);
    define("userAgentData", () => value.uaData ? {
      platform: value.uaData.platform,
      mobile: value.uaData.mobile,
      getHighEntropyValues: async () => ({ architecture: value.uaData?.architecture, bitness: value.uaData?.bitness }),
    } : undefined);
  }, system);
}

const file = (name: string) => CLI_FILES.find((item) => item.name === name)!;

const pages = [
  { path: "/developers/cli", lang: "en" },
  { path: "/ko/developers/cli", lang: "ko" },
] as const;

for (const { path, lang } of pages) {
  const copy = cliPageContent[lang];

  test(`${path} opens with its title, the install section and the download list, with no horizontal overflow at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, lang);
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);

    const title = page.getByTestId("cli-title");
    await expect(title).toBeVisible();
    await expect(title).toContainText(copy.hero.title[0]);
    await expect(title).toContainText(copy.hero.title[1]);
    await expect(page.getByTestId("cli-page")).toHaveAttribute("lang", lang);
    // Nothing says the CLI is not released: not the page, and not its own link in the footer
    // (the mobile apps keep their "soon" chips elsewhere in the header and footer).
    await expect(page.locator("main").getByText(/곧 출시|coming soon/i)).toHaveCount(0);
    await expect(page.locator('footer a[href$="/developers/cli"]')).not.toContainText(/곧 출시|coming soon|soon/i);
    await expect(page.locator("#install")).toBeAttached();
    await expect(page.getByTestId("cli-downloads")).toBeAttached();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A command wraps inside its box instead of scrolling or leaving the viewport.
    const boxes = await page.locator(".tv-page .cmd:visible").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
    expect(boxes.length).toBeGreaterThan(0);
    for (const right of boxes) expect(right).toBeLessThanOrEqual(320);
    // The download list becomes a labelled stack at phone width instead of a scrolling table.
    await page.getByTestId("cli-downloads").scrollIntoViewIfNeeded();
    const table = await page.getByTestId("cli-downloads").boundingBox();
    expect(table!.x + table!.width).toBeLessThanOrEqual(320);
  });
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the static page offers the way to the install section, not a download", async ({ page }) => {
    const response = await page.goto("/developers/cli");
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("cli-show-install")).toBeVisible();
    await expect(page.getByTestId("cli-show-install")).toHaveAttribute("href", "#install");
    await expect(page.getByTestId("cli-download")).toHaveCount(0);
    // The Windows tab is the first paint, so the winget command is already in the page.
    await expect(page.locator("#cli-os-panel-windows")).toContainText("winget install Tomverse.CLI");
  });
});

test.describe("the download button follows the visitor's system", () => {
  const cases: Array<{ name: string; system: Spoof; expected: string; os: "windows" | "macos" | "linux"; arch: "x64" | "arm64" }> = [
    { name: "Windows on x64", system: SYSTEMS.windowsX64, expected: "tomverse-1.0.0-windows-x64.msi", os: "windows", arch: "x64" },
    { name: "Windows on Arm (Chromium reports it only through userAgentData)", system: SYSTEMS.windowsArm, expected: "tomverse-1.0.0-windows-arm64.msi", os: "windows", arch: "arm64" },
    { name: "a Mac in Safari (the CPU cannot be read, so Apple silicon)", system: SYSTEMS.macSafari, expected: "tomverse-1.0.0-macos-arm64.pkg", os: "macos", arch: "arm64" },
    { name: "an Intel Mac in Chrome", system: SYSTEMS.macIntelChrome, expected: "tomverse-1.0.0-macos-x64.pkg", os: "macos", arch: "x64" },
    { name: "Linux on x64", system: SYSTEMS.linuxX64, expected: "tomverse-1.0.0-linux-x64.deb", os: "linux", arch: "x64" },
  ];
  for (const item of cases) {
    test(`${item.name}: recommends ${item.expected} and opens that system's tab`, async ({ page }) => {
      await spoofSystem(page, item.system);
      await prepareGuestPage(page, "en");
      await page.goto("/developers/cli");
      const button = page.getByTestId("cli-download");
      await expect(button).toBeVisible();
      await expect(button).toContainText(item.expected);
      await expect(button).toHaveAttribute("href", file(item.expected).url);
      expect(file(item.expected).url.startsWith(CLI_DOWNLOAD_BASE)).toBe(true);
      await expect(page.getByTestId("cli-other-os")).toHaveAttribute("href", "#install");
      await expect(page.getByTestId("cli-show-install")).toHaveCount(0);
      // The detected system's tab is selected and marked.
      const tab = page.locator(`#cli-os-${item.os}`);
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(tab).toContainText(cliPageContent.en.install.detected);
      await expect(page.locator(`#cli-os-panel-${item.os}`)).toBeVisible();
      // Its CPU's file is the highlighted one.
      await expect(page.getByTestId(`cli-file-${item.os}-${item.arch}-${item.os === "windows" ? "msi" : item.os === "macos" ? "pkg" : "deb"}`)).toHaveClass(/rec/);
    });
  }

  test("a phone gets the way to the install section and the note that it cannot install there", async ({ page }) => {
    await spoofSystem(page, SYSTEMS.android);
    await prepareGuestPage(page, "ko");
    await page.goto("/ko/developers/cli");
    await expect(page.getByTestId("cli-show-install")).toBeVisible();
    await expect(page.getByTestId("cli-show-install")).toContainText(cliPageContent.ko.hero.showInstall);
    await expect(page.getByTestId("cli-mobile-note")).toContainText(cliPageContent.ko.hero.mobileNote);
    await expect(page.getByTestId("cli-download")).toHaveCount(0);
    await expect(page.getByTestId("cli-other-os")).toHaveCount(0);
    // No tab is marked as the visitor's own.
    await expect(page.locator("#cli-os-windows .det")).toHaveCount(0);
  });
});

test("the OS tabs switch the install steps, and the arrow keys move between them", async ({ page }) => {
  await spoofSystem(page, SYSTEMS.windowsX64);
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const windowsTab = page.getByRole("tab", { name: /^Windows/ });
  const macTab = page.getByRole("tab", { name: /^macOS/ });
  const linuxTab = page.getByRole("tab", { name: /^Linux/ });
  const windowsPanel = page.locator("#cli-os-panel-windows");
  const macPanel = page.locator("#cli-os-panel-macos");
  const linuxPanel = page.locator("#cli-os-panel-linux");

  await expect(windowsTab).toHaveAttribute("aria-selected", "true");
  await expect(windowsPanel).toContainText("winget install Tomverse.CLI");
  await expect(windowsPanel).toContainText("npm install -g @tomverse/cli");
  await expect(windowsPanel).toContainText("$env:TOMVERSE_API_KEY");
  await expect(windowsPanel).toContainText("tomverse doctor");
  await expect(windowsPanel.getByTestId("cli-file-windows-x64-msi")).toHaveAttribute("href", file("tomverse-1.0.0-windows-x64.msi").url);
  await expect(windowsPanel.getByTestId("cli-file-windows-arm64-msi")).toHaveAttribute("href", file("tomverse-1.0.0-windows-arm64.msi").url);
  await expect(windowsPanel).toContainText(cliPageContent.en.install.windows.smartScreen[1]);
  await expect(macPanel).toBeHidden();

  await macTab.click();
  await expect(macTab).toHaveAttribute("aria-selected", "true");
  await expect(macPanel).toBeVisible();
  await expect(macPanel).toContainText("export TOMVERSE_API_KEY=");
  await expect(macPanel).toContainText("/usr/local/bin/tomverse");
  await expect(macPanel.getByTestId("cli-file-macos-arm64-pkg")).toHaveAttribute("href", file("tomverse-1.0.0-macos-arm64.pkg").url);
  await expect(macPanel.getByTestId("cli-file-macos-x64-pkg")).toHaveAttribute("href", file("tomverse-1.0.0-macos-x64.pkg").url);
  await expect(windowsPanel).toBeHidden();

  await linuxTab.click();
  await expect(linuxPanel).toBeVisible();
  await expect(linuxPanel).toContainText("sudo apt install ./tomverse-1.0.0-linux-x64.deb");
  await expect(linuxPanel).toContainText("sudo dnf install ./tomverse-1.0.0-linux-x64.rpm");
  await expect(linuxPanel).toContainText("glibc 2.28");
  await expect(linuxPanel.getByTestId("cli-file-linux-arm64-rpm")).toHaveAttribute("href", file("tomverse-1.0.0-linux-arm64.rpm").url);

  await linuxTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(windowsTab).toHaveAttribute("aria-selected", "true");
  await expect(windowsTab).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(linuxTab).toHaveAttribute("aria-selected", "true");
  await expect(linuxTab).toBeFocused();
});

test("the requirements name Pro and link the API key to Settings", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const req = page.locator(".req");
  await expect(req).toContainText(cliPageContent.en.install.req.node[1]);
  await expect(req).toContainText("Pro or above");
  await expect(req.getByRole("link", { name: cliPageContent.en.install.req.key[1] })).toHaveAttribute("href", "/settings/api");
  await expect(page.getByText(cliPageContent.en.install.capNote)).toBeVisible();
});

test("the download list links every installer and its checksum, and the archives go to the GitHub Release", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const table = page.getByTestId("cli-downloads");
  for (const item of CLI_FILES) {
    await expect(table.getByTestId(`cli-table-${item.os}-${item.arch}-${item.kind}`)).toHaveAttribute("href", item.url);
    await expect(table.locator(`a[href="${item.sha256Url}"]`)).toHaveCount(1);
  }
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(page.getByTestId("cli-release-link")).toHaveAttribute("href", CLI_RELEASE_PAGE);
});

test("the update and uninstall cards give the commands for each way of installing", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const cards = page.getByTestId("cli-update-cards");
  for (const command of [
    "winget upgrade Tomverse.CLI",
    "winget uninstall Tomverse.CLI",
    "sudo rm /usr/local/bin/tomverse",
    "sudo pkgutil --forget app.tomverse.cli",
    "sudo apt remove tomverse-cli",
    "sudo dnf remove tomverse-cli",
    "npm install -g @tomverse/cli@latest",
  ]) await expect(cards).toContainText(command);
  await expect(page.getByText(cliPageContent.en.update.removeNote)).toBeVisible();
});

test("a copy button copies exactly its command and confirms it", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { (window as unknown as { __copied: string }).__copied = text; } },
    });
  });
  await spoofSystem(page, SYSTEMS.windowsX64);
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const button = page.locator("#cli-os-panel-windows .cmd").first().getByRole("button");
  await expect(button).toHaveText(cliPageContent.en.copy);
  await button.click();
  await expect(button).toHaveText(cliPageContent.en.copied);
  expect(await page.evaluate(() => (window as unknown as { __copied: string }).__copied)).toBe("winget install Tomverse.CLI");
});

test("the motion control stops the page's motion and reduced motion shows the finished terminal", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const root = page.getByTestId("cli-page");
  const toggle = page.getByTestId("launch-motion-toggle");
  await expect(root).toHaveAttribute("data-motion", "running");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(root).toHaveAttribute("data-motion", "paused");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("pre.doctor")).toContainText("PASS  recovery");
  await toggle.click();
  await expect(root).toHaveAttribute("data-motion", "running");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.getByTestId("cli-page")).toHaveAttribute("data-motion", "paused");
  await expect(page.getByTestId("launch-motion-toggle")).toHaveCount(0);
  await expect(page.locator("pre.doctor")).toContainText("PASS  recovery");
});

test("the hero shows the first run on Windows beside the copy", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/developers/cli");
  const terminal = page.getByTestId("cli-hero-terminal");
  await expect(terminal).toContainText("winget install Tomverse.CLI");
  await expect(terminal).toContainText("tomverse doctor");
  await expect(terminal).toContainText("PASS  platform  win32 x64");
  await expect(page.getByText(cliPageContent.en.hero.notarized)).toBeVisible();
  await expect(page.getByText("v1.0.0")).toBeVisible();
});
