import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codeSandboxInput } from "../src/code-sandbox-contract";
import { codeSandboxView, readCodeSandboxSettings, startCodeSandbox } from "../src/host/code-sandbox";

const directory = () => join(mkdtempSync(join(tmpdir(), "tv-code-sandbox-")), "code-sandbox");

test("sandbox input is a small set of typed actions: no paths, no free-form commands", () => {
  assert.deepEqual(codeSandboxInput.parse({ action: "read" }), { action: "read" });
  assert.deepEqual(codeSandboxInput.parse({ action: "set-mode", mode: "read-only" }), { action: "set-mode", mode: "read-only" });
  assert.deepEqual(codeSandboxInput.parse({ action: "set-domains", domains: [" a.test "] }), { action: "set-domains", domains: ["a.test"] });
  assert.equal(codeSandboxInput.parse({ action: "clear-marks" }).action, "clear-marks");
  for (const input of [
    { action: "set-mode", mode: "danger-full-access" }, { action: "set-mode" }, { action: "set-domains", domains: "a.test" },
    { action: "set-domains", domains: [""] }, { action: "set-domains", domains: Array.from({ length: 201 }, (_, i) => `h${i}.test`) },
    { action: "set-localhost", enabled: "yes" }, { action: "clear-marks", path: "C:\\work" }, { action: "set-mode", mode: "off", path: "/etc" }, { action: "run" },
  ]) assert.throws(() => codeSandboxInput.parse(input), JSON.stringify(input));
});

test("the sandbox is off with a small default list until the person changes it, and unreadable settings mean off", () => {
  const dir = directory();
  const settings = readCodeSandboxSettings(dir);
  assert.equal(settings.mode, "off");
  assert.equal(settings.allowLocalhost, false);
  assert.ok(settings.allowedDomains.includes("registry.npmjs.org") && settings.allowedDomains.length < 12);
});

test("settings are saved, the list is cleaned, and entries that are not host names are counted and dropped", async () => {
  const dir = directory();
  const before = await codeSandboxView(dir, { action: "read" });
  assert.equal(before.mode, "off");
  assert.equal(before.preview, true, "off shows what workspace-write would enforce");
  assert.equal(existsSync(join(dir, "settings.json")), false, "reading saves no settings");
  assert.equal((await codeSandboxView(dir, { action: "set-mode", mode: "workspace-write" })).mode, "workspace-write");
  const listed = await codeSandboxView(dir, { action: "set-domains", domains: ["Registry.NPMJS.org", "registry.npmjs.org", "bad host", "http://x.test", "*.corp.test"] });
  assert.deepEqual(listed.domains, ["registry.npmjs.org", "*.corp.test"]);
  assert.equal(listed.ignoredDomains, 2);
  assert.equal(listed.preview, false);
  const local = await codeSandboxView(dir, { action: "set-localhost", enabled: true });
  assert.equal(local.allowLocalhost, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { mode: "workspace-write", allowedDomains: ["registry.npmjs.org", "*.corp.test"], allowLocalhost: true });
  assert.deepEqual((await codeSandboxView(dir, { action: "set-domains", domains: [] })).domains, [], "an empty list is a choice: no network");
  assert.equal((await codeSandboxView(dir, { action: "read" })).mode, "workspace-write", "what was saved is what the next read returns");
});

test("the view says what the operating system enforces and never claims more than the platform can do", async () => {
  const dir = directory();
  const view = await codeSandboxView(dir, { action: "set-mode", mode: "workspace-write" });
  const { enforcement } = view;
  if (process.platform === "win32") {
    assert.equal(view.platform, "windows");
    if (enforcement.available) {
      assert.equal(enforcement.writes, "os");
      assert.equal(enforcement.network, "environment-only", "Windows cannot block a direct connection");
      assert.equal(enforcement.credentialReads, "partial");
    }
  } else if (enforcement.available) {
    assert.deepEqual([enforcement.writes, enforcement.credentialReads], ["os", "os"]);
  } else {
    assert.deepEqual([enforcement.writes, enforcement.credentialReads, enforcement.network], ["none", "none", "none"]);
    assert.ok(enforcement.unavailable);
  }
});

test("a task gets no sandbox when it is off, and one that refuses every command when it is on but cannot be built", async () => {
  const dir = directory();
  assert.equal(await startCodeSandbox(undefined, tmpdir()), null);
  assert.equal(await startCodeSandbox(dir, tmpdir()), null, "off by default");
  await codeSandboxView(dir, { action: "set-mode", mode: "workspace-write" });
  const refused = await startCodeSandbox(dir, homedir());
  assert.ok(refused);
  assert.equal(refused.enforcement.available, false);
  assert.equal(refused.enforcement.unavailable, "workspace-too-broad");
  assert.throws(() => refused.launch(process.execPath, ["-v"], { cwd: homedir(), env: {} }), /so the command was not run/);
});
