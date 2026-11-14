import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const mod = path => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const emails = [];
const captured = [];

mock.module("@sentry/nextjs", {
  namedExports: {
    withScope: callback => callback({ setLevel() {}, setTag() {}, setContext() {} }),
    captureException: error => { captured.push(error); return "test-event"; },
    flush: async () => true,
  },
});
mock.module(mod("lib/emailProviderPort.ts"), {
  namedExports: {
    emailProvider: () => ({ send: async message => {
      emails.push(message);
      return { ok: true };
    } }),
  },
});

const { notifyAutoRouterTunable } = await import("../../lib/autoRouterTunablesAlert.ts");
const { reportOperationalIncident } = await import("../../lib/operationalMonitoring.ts");

test.beforeEach(t => {
  emails.length = 0;
  captured.length = 0;
  for (const [key, value] of Object.entries({
    OPS_ALERT_EMAIL: "operator@example.com",
    OPS_ALERT_SLACK_WEBHOOK_URL: "", SLACK_WEBHOOK_URL: "",
    OPS_ALERT_DISCORD_WEBHOOK_URL: "", DISCORD_WEBHOOK_URL: "",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external call"); });
});

test("each applied model exclusion delivers its actual description in the log and email", async t => {
  const logs = [];
  t.mock.method(console, "error", line => logs.push(JSON.parse(line)));
  for (const modelId of ["minimax-m3-1-flash", "mistral-large-4"]) {
    assert.equal(await notifyAutoRouterTunable({
      kind: "applied", cycleId: "test-cycle",
      change: { setting: "excludeModel", modelId, hours: 12, reason: "Both answer attempts failed." },
    }), true);
    const description = `Auto router: ${modelId} is left out of Auto's choices for 12 h`;
    assert.equal(logs.at(-1)?.message, description);
    assert.equal(captured.at(-1)?.message, description);
    assert.ok(emails.at(-1)?.text.includes(`Message: ${description}`));
    assert.ok(emails.at(-1)?.text.includes("reason: Both answer attempts failed."));
    assert.ok(!emails.at(-1)?.text.includes("Unknown error"));
  }
  // Both changes use the same code and must still notify inside its cooldown.
  assert.equal(emails.length, 2);
});

test("a real error still takes precedence over the incident title", async t => {
  t.mock.method(console, "error", () => {});
  await reportOperationalIncident({
    code: "PROVIDER_FAILED_TEST", title: "Provider failed", error: new Error("Upstream returned 503"),
    forceNotification: true,
  });
  assert.equal(captured[0].message, "Upstream returned 503");
  assert.ok(emails[0].text.includes("Message: Upstream returned 503"));
});
