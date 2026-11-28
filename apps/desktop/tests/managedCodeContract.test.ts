import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { desktopManagedCodeCopy } from "../../../locales/desktopManagedCode";
import { describeExecutionLocations } from "../src/execution-location";
import { desktopManagedCodeInput, managedRefusal, MANAGED_MAX_APPROVED_CREDITS } from "../src/managed-code-contract";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";

test("the renderer can only name read, reserve, release and dismiss, with bounded values", () => {
  const ok = (value: unknown) => desktopManagedCodeInput.safeParse(value).success;
  assert.equal(ok({ action: "read" }), true);
  assert.equal(ok({ action: "dismiss" }), true);
  assert.equal(ok({ action: "reserve", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 100 }), true);
  assert.equal(ok({ action: "reserve", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: MANAGED_MAX_APPROVED_CREDITS + 1 }), false);
  assert.equal(ok({ action: "reserve", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 0 }), false);
  assert.equal(ok({ action: "reserve", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 1.5 }), false);
  assert.equal(ok({ action: "reserve", executorModelId: "../admin", reviewerModelId: "beta", approvedCredits: 1 }), false);
  // No amount of cost, usage or price can be submitted, and no path or URL.
  assert.equal(ok({ action: "reserve", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 1, costUsd: 0 }), false);
  assert.equal(ok({ action: "read", path: "/api/admin" }), false);
  assert.equal(ok({ action: "release", reason: "cancelled" }), true);
  assert.equal(ok({ action: "release", reason: "completed" }), true);
  // Failure reasons are the server's to report, not the person's to claim.
  for (const reason of ["failed", "interrupted", "rejected"]) assert.equal(ok({ action: "release", reason }), false, reason);
});

test("every language has a sentence for every refusal and every location", () => {
  const english = desktopManagedCodeCopy.en;
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = desktopManagedCodeCopy[language];
    assert.deepEqual(Object.keys(copy.refusal).sort(), [...managedRefusal.options].sort(), language);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort(), language);
    for (const [key, value] of Object.entries(copy)) if (typeof value === "string") assert.ok(value.length > 0, `${language}.${key}`);
    // The sentences that carry values keep their placeholders in every language.
    assert.match(copy.confirmText, /\{credits\}.*\{executor\}|\{executor\}.*\{credits\}/, language);
    assert.ok(copy.confirmText.includes("{reviewer}") && copy.confirm.includes("{credits}"), language);
  }
});

test("cloud is available only on the server's capability; ssh is not set up until the remote lane says otherwise", () => {
  const locations = describeExecutionLocations();
  assert.deepEqual(locations.map((location) => location.id), ["local", "worktree", "ssh", "cloud"]);
  assert.deepEqual(locations.find((location) => location.id === "cloud"), { id: "cloud", available: false, reason: "not_offered" });
  assert.deepEqual(locations.find((location) => location.id === "ssh"), { id: "ssh", available: false, reason: "not_set_up" });
  assert.equal(locations.find((location) => location.id === "local")?.available, true);
  assert.deepEqual(describeExecutionLocations({ ssh: { available: true } }).find((location) => location.id === "ssh"), { id: "ssh", available: true });
  // The SSH lane's answer never turns the cloud row on; only the server's capability does.
  assert.equal(describeExecutionLocations({ ssh: { available: true } }).find((location) => location.id === "cloud")?.available, false);
  assert.deepEqual(describeExecutionLocations({ cloud: true }).find((location) => location.id === "cloud"), { id: "cloud", available: true });
});

test("the managed credits capability is read as off unless the server says true, and reads true when it does", async (t) => {
  const read = async (body: object) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ autoSelection: { offered: false }, ...body }));
    return readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  };
  assert.equal((await read({}))?.managedCode, false);
  assert.equal((await read({ desktopManagedCode: false }))?.managedCode, false);
  assert.equal((await read({ desktopManagedCode: true }))?.managedCode, true);
});
