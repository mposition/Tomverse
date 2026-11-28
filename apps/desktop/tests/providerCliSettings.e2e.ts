import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { TEST_KEY } from "../../tomverse-cli/tests/fakeGateway.js";
import { cliUsesInstallationFolder, cliUsesReleaseArchive, type CliProvider } from "../src/code-execution";
import { cliPathStillMatches, inspectCliPath } from "../src/host/provider-cli-path";
import { launchNativeFixture } from "./launch-native-fixture";
import { cancelWindowsDialog } from "./windows-accessibility";

const packagedExecutable = process.env.TOMVERSE_DESKTOP_TASK_QA_EXECUTABLE;
const executablePath: string = packagedExecutable ?? process.env.TOMVERSE_DESKTOP_TEST_ELECTRON ?? createRequire(import.meta.url)("electron");
const desktopDir = resolve(fileURLToPath(new URL("../", import.meta.url)));

async function launchSettings(profile: string, timeout = 20_000) {
  if (!packagedExecutable) {
    return electron.launch({ executablePath, args: [desktopDir, `--user-data-dir=${profile}`], timeout });
  }
  const executable = process.env.TOMVERSE_DESKTOP_VIBE_TASK_ARCHIVE;
  assert.ok(executable, "Packaged settings tests require the pinned Mistral Vibe fixture archive.");
  const root = join(dirname(profile), "project");
  const descriptor = join(dirname(profile), "fixture.json");
  await mkdir(root, { recursive: true });
  await writeFile(descriptor, JSON.stringify({ root, profile, endpoint: "http://127.0.0.1:1/api/code/v1", key: TEST_KEY,
    vibe: { executable, version: "3.1.4", model: "vibe-desktop-fixture", origin: "http://127.0.0.1:1" },
  }));
  return launchNativeFixture(descriptor, timeout);
}

async function openClis(page: Page) {
  await page.getByRole("button", { name: "Desktop settings", exact: true }).click();
  const clis = page.getByRole("button", { name: "Development CLIs", exact: true });
  if (await clis.isDisabled()) {
    await page.getByRole("button", { name: "Execution and limits", exact: true }).click();
    await page.getByLabel("Preferred execution mode").selectOption("provider_cli");
  }
  await clis.click();
}

test("Development CLIs check typed and selected paths and persist the requested changes", { timeout: 60_000 }, async () => {
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-desktop-cli-settings-"));
  const profile = join(tmp, "profile");
  const firstFolder = join(tmp, "한글 and spaces");
  const secondFolder = join(tmp, "second choice");
  const filename = process.platform === "win32" ? "codex.exe" : "codex";
  const first = join(firstFolder, filename);
  const second = join(secondFolder, filename);
  const claude = join(firstFolder, process.platform === "win32" ? "claude.exe" : "claude");
  const pathsFile = join(profile, "provider-cli-paths.json");
  const launch = () => launchSettings(profile);
  let app: ElectronApplication | undefined;
  try {
    await Promise.all([mkdir(profile), mkdir(firstFolder), mkdir(secondFolder)]);
    await writeFile(join(profile, "language.txt"), "en");
    await Promise.all([copyFile(process.execPath, first), copyFile(process.execPath, second), copyFile(process.execPath, claude)]);
    await Promise.all([chmod(first, 0o755), chmod(second, 0o755), chmod(claude, 0o755)]);
    app = await launch();
    const page = await app.firstWindow();
    await openClis(page);
    await expect(page.locator(".provider-cli-list li")).toHaveCount(8);
    await expect(page.getByText("DeepSeek Harness")).toHaveCount(0);
    await expect(page.getByText("ZCode Agent")).toHaveCount(0);
    await expect(page.getByText("Cursor")).toHaveCount(0);
    const supported = (process.platform === "darwin" && process.arch === "arm64") ||
      (process.arch === "x64" && ["darwin", "win32", "linux"].includes(process.platform));
    await expect(page.getByText("Unsupported on this platform", { exact: true })).toHaveCount(supported ? 0 : 8);
    if (!supported) {
      await expect(page.getByRole("button", { name: "Codex · Set path" })).toBeDisabled();
      assert.equal(await page.evaluate(() => window.desktop.chooseCliPath("openai")), null);
      assert.deepEqual(await page.evaluate((path) => window.desktop.saveCliPath({ provider: "openai", path }), first),
        { status: "unsupportedPlatform" });
      return;
    }
    await page.getByRole("button", { name: "Codex · Set path" }).press("Enter");
    await expect(page.getByRole("heading", { name: "Codex", exact: true })).toBeFocused();
    await expect(page.getByText("Commercial integration approval required")).toBeVisible();
    await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
    assert.deepEqual(await page.evaluate(() => window.desktop.checkCliAccount("openai")),
      { status: "accountUnknown", billingSource: "unknown" });
    assert.deepEqual(await page.evaluate(() => window.desktop.checkCliProtocol("openai")), { status: "unavailable" });
    const localProtocol = page.getByRole("button", { name: "Check local protocol" });
    if (await page.evaluate(async () => (await window.desktop.state()).cliProtocolCheckAvailable)) {
      await expect(localProtocol).toBeDisabled();
    } else await expect(localProtocol).toHaveCount(0);
    await app.evaluate(({ shell }) => {
      const check = globalThis as typeof globalThis & { cliAuthGuide?: string };
      shell.openExternal = async (url) => { check.cliAuthGuide = url; };
    });
    await page.getByRole("button", { name: "Official sign-in guide" }).click();
    const guide = page.getByTestId("desktop-web-view");
    await expect(guide.getByLabel("Current address")).toContainText("developers.openai.com");
    await guide.getByTestId("desktop-web-view-close").click();
    await expect(guide).toHaveCount(0);
    assert.equal(await app.evaluate(() => (globalThis as typeof globalThis & { cliAuthGuide?: string }).cliAuthGuide), undefined);
    const path = page.getByLabel("Executable file location");
    const browse = page.getByRole("button", { name: "Browse", exact: true });
    const save = page.getByRole("button", { name: "Check and save", exact: true });
    const stored = async () => JSON.parse(await readFile(pathsFile, "utf8"));
    await path.fill(first);
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Version unverified" })).toBeVisible();
    assert.deepEqual(await stored(), { openai: first });

    await path.fill(join(tmp, "missing", filename));
    await save.click();
    await expect(page.getByText("The selected file could not be found.")).toBeVisible();
    await expect(path).toHaveAttribute("aria-invalid", "true");
    await expect(path).toHaveAccessibleDescription(/The selected file could not be found\./);
    assert.deepEqual(await stored(), { openai: first });

    if (process.platform === "win32") {
      const click = browse.press("Enter");
      await cancelWindowsDialog(app, "Executable file location", "Cancel");
      await click;
      await expect(browse).toBeEnabled();
      await expect(browse).toBeFocused();
      await expect(path).toHaveValue(join(tmp, "missing", filename));
    }

    await app.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target], bookmarks: [] });
    }, second);
    await browse.press("Enter");
    await expect(path).toHaveValue(second);
    await expect(browse).toBeFocused();
    await expect(path).toHaveAttribute("aria-invalid", "false");
    assert.deepEqual(await stored(), { openai: first });
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Version unverified" })).toBeVisible();
    assert.deepEqual(await stored(), { openai: second });
    await page.getByRole("button", { name: "Development CLIs", exact: true }).last().click();
    await expect(page.getByRole("button", { name: "Codex · Change path" })).toBeFocused();
    await page.getByRole("button", { name: "Claude Code · Set path" }).click();
    await path.fill(claude);
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Version unverified" })).toBeVisible();
    assert.deepEqual(await stored(), { openai: second, anthropic: claude });
    await assert.rejects(page.evaluate(() => window.desktop.saveCliPath({ provider: "cursor" as never, path: "cursor" })), /Error invoking remote method/);
    await app.close();

    app = await launch();
    const restored = await app.firstWindow();
    await openClis(restored);
    await expect(restored.getByText("Check required", { exact: true })).toHaveCount(2);
    await restored.getByRole("button", { name: "Codex · Change path" }).click();
    await expect(restored.getByLabel("Executable file location")).toHaveValue(second);
    await restored.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(restored.getByLabel("Executable file location")).toHaveValue("");
    assert.deepEqual(await stored(), { anthropic: claude });
    assert.ok((await stat(second)).isFile());
  } finally {
    await app?.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

const pathMatrix = process.env.TOMVERSE_DESKTOP_CLI_PATH_CASES;

test("An installed CLI replacement invalidates its displayed protocol and keeps the selected path", {
  timeout: 180_000,
  skip: !pathMatrix || process.env.TOMVERSE_DESKTOP_CLI_PROTOCOL_FIXTURE !== "true" || !!packagedExecutable,
}, async () => {
  assert.ok(pathMatrix);
  const cases = JSON.parse(await readFile(pathMatrix, "utf8")) as Array<{ id: CliProvider; path: string; version: string }>;
  const codex = cases.find(({ id }) => id === "openai");
  assert.ok(codex);
  const temporary = await mkdtemp(join(tmpdir(), "tomverse-cli-replacement-"));
  const profile = join(temporary, "profile");
  const selected = join(temporary, process.platform === "win32" ? "codex.exe" : "codex");
  let app: ElectronApplication | undefined;
  try {
    await mkdir(profile);
    await writeFile(join(profile, "language.txt"), "en");
    await copyFile(codex.path, selected);
    await chmod(selected, 0o755);
    app = await launchSettings(profile);
    const page = await app.firstWindow();
    await openClis(page);
    await page.getByRole("button", { name: "Codex · Set path" }).click();
    const path = page.getByLabel("Executable file location");
    await path.fill(selected);
    await page.getByRole("button", { name: "Check and save" }).click();
    const protocol = page.getByRole("button", { name: "Check local protocol" });
    await expect(protocol).toBeEnabled({ timeout: 40_000 });
    await protocol.click();
    await expect(page.getByText("Protocol verified", { exact: true })).toBeVisible({ timeout: 70_000 });
    const advertised = page.getByText(/^Advertised models \([1-9]/);
    await expect(advertised).toBeVisible();
    const verified = await inspectCliPath("openai", selected);
    assert.equal(verified.status, "pathVerified");
    assert.equal(await cliPathStillMatches("openai", selected, verified), true);
    const replacement = join(temporary, "replacement");
    await copyFile(process.execPath, replacement);
    await expect(page.getByText("Protocol verified", { exact: true })).toBeVisible();
    await rename(replacement, selected);
    assert.equal(await cliPathStillMatches("openai", selected, verified), false);
    await expect(page.getByText("Check required", { exact: true })).toBeVisible();
    await expect(page.getByText("Protocol verified", { exact: true })).toHaveCount(0);
    await expect(advertised).toHaveCount(0);
    await expect(protocol).toBeDisabled();
    await expect(path).toHaveValue(selected);
    assert.deepEqual(JSON.parse(await readFile(join(profile, "provider-cli-paths.json"), "utf8")), { openai: selected });
    await page.getByRole("button", { name: "Check and save" }).click();
    await expect(page.getByText("Version unverified", { exact: true })).toBeVisible();
    await expect(protocol).toBeDisabled();
  } finally {
    await app?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
const expectedAuthGuides: Record<CliProvider, string> = {
  openai: "https://developers.openai.com/codex/auth",
  anthropic: "https://code.claude.com/docs/en/authentication",
  google: "https://antigravity.google/docs/ide/extensions/acp#authentication",
  xai: "https://docs.x.ai/build/overview#run-grok",
  qwen: "https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/",
  moonshot: "https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/guides/getting-started.md",
  mistral: "https://docs.mistral.ai/vibe/code/cli/install-setup",
  minimax: "https://code.minimax.io/docs/cli/quick-start",
};

test("Official CLI paths, sign-in guides and isolated account checks stay tied to their providers", {
  timeout: 240_000, skip: pathMatrix ? false : "Requires local official CLI release paths",
}, async (context) => {
  assert.ok(pathMatrix);
  const cases = JSON.parse(await readFile(pathMatrix, "utf8")) as Array<{
    id: CliProvider; name: string; path: string; pathLabel: string; version: string; verifiedLabel: string;
  }>;
  assert.ok(cases.length && new Set(cases.map(({ id }) => id)).size === cases.length);
  const tmp = await mkdtemp(join(tmpdir(), "tomverse-cli-path-matrix-"));
  const profile = join(tmp, "profile");
  const launch = () => launchSettings(profile, 30_000);
  const stored = async () => JSON.parse(await readFile(join(profile, "provider-cli-paths.json"), "utf8"));
  const expected: Partial<Record<CliProvider, string>> = {};
  let app: ElectronApplication | undefined;
  try {
    await mkdir(profile);
    await writeFile(join(profile, "language.txt"), "en");
    app = await launch();
    const page = await app.firstWindow();
    await openClis(page);
    const fixtureAccountChecks = (await page.evaluate(() => window.desktop.state())).cliAuthFixture;
    if (process.env.TOMVERSE_DESKTOP_CLI_AUTH_FIXTURE === "true") assert.equal(fixtureAccountChecks, true);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => { (globalThis as typeof globalThis & { cliAuthGuide?: string }).cliAuthGuide = url; };
    });
    for (const entry of cases) {
      const directory = cliUsesInstallationFolder(entry.id);
      const archive = cliUsesReleaseArchive(entry.id);
      const alternate = join(tmp, "경로 with spaces", entry.id, basename(entry.path));
      await mkdir(join(tmp, "경로 with spaces", entry.id), { recursive: true });
      if (directory) {
        await symlink(entry.path, alternate, process.platform === "win32" ? "junction" : "dir");
      } else {
        await copyFile(entry.path, alternate);
      }
      await page.getByRole("button", { name: `${entry.name} · Set path`, exact: true }).click();
      const input = page.getByLabel(entry.pathLabel, { exact: true });
      const save = page.getByRole("button", { name: "Check and save", exact: true });
      const verified = page.getByRole("status").filter({ hasText: `${entry.verifiedLabel} · ${entry.version}` });
      await page.getByRole("button", { name: "Official sign-in guide", exact: true }).click();
      const guide = page.getByTestId("desktop-web-view");
      await expect(guide.getByLabel("Current address")).toContainText(new URL(expectedAuthGuides[entry.id]).host);
      await guide.getByTestId("desktop-web-view-close").click();
      await expect(guide).toHaveCount(0);
      assert.equal(await app.evaluate(() => (globalThis as typeof globalThis & { cliAuthGuide?: string }).cliAuthGuide), undefined);
      await input.fill(alternate);
      await save.click();
      await expect(verified).toBeVisible({ timeout: 30_000 });
      expected[entry.id] = alternate;
      assert.deepEqual(await stored(), expected);
      const account = page.locator(".provider-cli-account");
      const checkSignIn = page.getByRole("button", { name: "Check isolated sign-in", exact: true });
      if (fixtureAccountChecks && ["openai", "anthropic", "google", "xai", "qwen", "moonshot", "mistral", "minimax"].includes(entry.id)) {
        if (entry.id === "minimax") {
          await checkSignIn.click();
          await page.getByRole("button", { name: "Cancel sign-in check", exact: true }).click();
          await expect(checkSignIn).toBeEnabled();
          await expect(account.getByText("Sign-in unconfirmed", { exact: true })).toBeVisible();
          await expect(account.getByText("Unknown", { exact: true })).toBeVisible();
        }
        await checkSignIn.click();
        await expect(account.getByText("Sign-in required", { exact: true })).toBeVisible({ timeout: 45_000 });
        if (entry.id === "openai") await expect(account.getByText("Commercial integration approval required")).toBeVisible();
        context.diagnostic(`${entry.name}: isolated sign-in required`);
      } else await expect(checkSignIn).toHaveCount(0);
      await expect(account.getByText("Unknown", { exact: true })).toBeVisible();
      const options = { selected: entry.path, title: entry.pathLabel, kind: directory ? "openDirectory" as const : "openFile" as const,
        extension: archive ? extname(entry.path).slice(1) : undefined };
      await app.evaluate(({ dialog }, { selected, title, kind, extension }) => {
        dialog.showOpenDialog = async (first: Electron.BaseWindow | Electron.OpenDialogOptions, second?: Electron.OpenDialogOptions) => {
          const actual = second ?? first as Electron.OpenDialogOptions;
          return {
            canceled: actual.title !== title || !actual.properties?.includes(kind) ||
              Boolean(extension && actual.filters?.[0]?.extensions[0] !== extension),
            filePaths: [selected], bookmarks: [],
          };
        };
      }, options);
      await page.getByRole("button", { name: "Browse", exact: true }).click();
      await expect(input).toHaveValue(entry.path);
      await expect(account.getByText("Sign-in required", { exact: true })).toHaveCount(0);
      assert.deepEqual(await stored(), expected);
      await save.click();
      await expect(verified).toBeVisible({ timeout: 30_000 });
      expected[entry.id] = entry.path;
      assert.deepEqual(await stored(), expected);
      await page.getByRole("button", { name: "Development CLIs", exact: true }).last().click();
    }
    await app.close();
    app = await launch();
    const restored = await app.firstWindow();
    await openClis(restored);
    await expect(restored.getByText("Check required", { exact: true })).toHaveCount(cases.length);
    for (const entry of cases) {
      await restored.getByRole("button", { name: `${entry.name} · Change path`, exact: true }).click();
      const input = restored.getByLabel(entry.pathLabel, { exact: true });
      await expect(input).toHaveValue(entry.path);
      await restored.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(input).toHaveValue("");
      delete expected[entry.id];
      assert.deepEqual(await stored(), expected);
      assert.equal((await stat(entry.path)).isDirectory(), cliUsesInstallationFolder(entry.id));
      await restored.getByRole("button", { name: "Development CLIs", exact: true }).last().click();
    }
  } finally {
    await app?.close();
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
