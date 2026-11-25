import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { configureUpdates } from "../src/host/updates";

for (const platform of ["darwin", "win32"] as const) test(`a downloaded update waits for active work on ${platform}`, async () => {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../src/host/updates.ts", import.meta.url))],
    bundle: true, write: false, platform: "node", format: "cjs",
    define: { DESKTOP_UPDATE_ORIGIN: '"https://updates.example.test"' },
    plugins: [{
      name: "electron-update-fixture",
      setup(plugin) {
        plugin.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "update-fixture" }));
        plugin.onResolve({ filter: /^\.\/windows-update$/ }, () => ({ path: "windows-update", namespace: "update-fixture" }));
        plugin.onResolve({ filter: /^\.\/mac-update$/ }, () => ({ path: "mac-update", namespace: "update-fixture" }));
        plugin.onLoad({ filter: /.*/, namespace: "update-fixture" }, () => ({
          contents: "export const app = fixture.app; export const autoUpdater = fixture.autoUpdater; export const net = fixture.net; export const prepareWindowsUpdate = fixture.prepareWindowsUpdate; export const prepareMacUpdate = fixture.prepareMacUpdate;",
        }));
      },
    }],
  });
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => "0.1.0", getPath: () => "test profile" });
  let installs = 0;
  let cleanups = 0;
  let nativeFailure = true;
  let feed = "";
  const localPackage = "file:///C:/pending-update/Tomverse-Desktop.msix";
  const localManifest = "file:///tmp/pending-update/releases.json";
  const autoUpdater = Object.assign(new EventEmitter(), {
    setFeedURL: ({ url }: { url: string }) => { feed = url; },
    checkForUpdates: () => {
      assert.equal(cleanups, nativeFailure ? 0 : 1);
      if (nativeFailure) return Promise.reject(new Error("Native updater promise rejected"));
    },
    quitAndInstall: () => { installs++; },
  });
  const bundleModule = { exports: {} as { configureUpdates: typeof configureUpdates } };
  runInNewContext(bundled.outputFiles[0]!.text, {
    module: bundleModule, exports: bundleModule.exports, URL,
    fixture: {
      app, autoUpdater, net: {},
      prepareWindowsUpdate: async (_fetch: unknown, url: URL, version: string, _profile: string, downloading: () => void) => {
        assert.equal(url.href, "https://updates.example.test/desktop/updates/win32/x64/0.1.0");
        assert.equal(version, "0.1.0");
        downloading();
        return { url: localPackage, remove: async () => { cleanups++; } };
      },
      prepareMacUpdate: async (_fetch: unknown, url: URL, version: string, arch: string) => {
        assert.equal(url.href, "https://updates.example.test/desktop/updates/darwin/arm64/0.1.0");
        assert.equal(version, "0.1.0");
        assert.equal(arch, "arm64");
        return { url: localManifest, remove: async () => { cleanups++; } };
      },
    },
    process: { platform, arch: platform === "win32" ? "x64" : "arm64", windowsStore: true },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });

  let busy = true;
  const stages: string[] = [];
  try {
    const controls = bundleModule.exports.configureUpdates(() => busy, ({ stage }) => stages.push(stage));
    await controls.check();
    assert.equal(stages.at(-1), "failed", "native promise rejection makes the check retryable");
    nativeFailure = false;
    await controls.check();
    assert.equal(feed, platform === "win32" ? localPackage : localManifest);
    assert.equal(cleanups, 1, "native return does not complete staging");
    autoUpdater.emit("update-available");
    assert.equal(cleanups, 1, "the updater still needs the staged input");
    autoUpdater.emit("update-downloaded");
    assert.equal(cleanups, 2);
    assert.equal(stages.at(-1), "ready");
    assert.equal(installs, 0, "download completion does not request a restart");
    controls.install();
    assert.equal(installs, 0, "a user request cannot restart the app while Code is active");
    assert.equal(stages.at(-1), "ready");
    busy = false;
    controls.install();
    controls.install();
    assert.equal(installs, 1);
    assert.equal(stages.at(-1), "installing");
  } finally {
    app.emit("will-quit");
  }
});
