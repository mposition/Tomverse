import assert from "node:assert/strict";
import test from "node:test";

// docs/policy/marketing-automation.md §14 S6: the consent gate for the GA4
// User-ID. Nothing is sent without consent, without the published notice, or
// with the switch off -- each on its own -- and the shipped build cannot send
// one at all, because the notice has not been revised yet (§10.2).

const policy = await import("../lib/ga4UserIdPolicy.ts");
const server = await import("../lib/ga4UserId.ts");

const allOn = {
  noticePublished: true,
  switchValue: "true",
  consent: "accepted",
  signedIn: true,
  measurementId: "G-TEST1234",
};

test("transmission needs notice, switch, explicit consent, a session and a tag", () => {
  assert.equal(policy.ga4UserIdTransmissionAllowed(allOn), true);
  const off = [
    ["notice not published", { noticePublished: false }],
    ["switch off", { switchValue: "false" }],
    ["switch unset", { switchValue: undefined }],
    ["switch not exactly true", { switchValue: "1" }],
    ["consent undecided", { consent: "unset" }],
    ["consent unknown", { consent: null }],
    ["consent declined", { consent: "declined" }],
    ["signed out", { signedIn: false }],
    ["no measurement id", { measurementId: null }],
  ];
  for (const [label, override] of off) {
    assert.equal(
      policy.ga4UserIdTransmissionAllowed({ ...allOn, ...override }),
      false,
      label,
    );
  }
});

test("the shipped build cannot send a User-ID: the privacy notice is not revised yet", () => {
  assert.equal(policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED, false);
  assert.equal(
    policy.ga4UserIdTransmissionAllowed({
      ...allOn,
      noticePublished: policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
    }),
    false,
  );
  const env = {
    NEXT_PUBLIC_GA4_USER_ID_ENABLED: "true",
    GA4_USER_ID_KEY: "k".repeat(48),
  };
  assert.equal(server.ga4UserIdServerEnabled(env), false, "the server agrees by default");
  assert.equal(server.ga4UserIdServerEnabled(env, true), true);
  assert.equal(
    server.ga4UserIdServerEnabled({ ...env, NEXT_PUBLIC_GA4_USER_ID_ENABLED: "false" }, true),
    false,
  );
  assert.equal(
    server.ga4UserIdServerEnabled({ ...env, GA4_USER_ID_KEY: "too-short" }, true),
    false,
    "no usable derivation key, no id",
  );
});

test("the User-ID is a keyed pseudonym that does not carry the account id", () => {
  const key = "k".repeat(48);
  const userId = "cmh1234567890accountid";
  const id = server.analyticsUserIdFor(userId, key);
  assert.equal(policy.isAnalyticsUserId(id), true);
  assert.equal(id, server.analyticsUserIdFor(userId, key), "stable, so GA4 can join visits");
  assert.notEqual(id, server.analyticsUserIdFor("cmh-other-account", key));
  assert.notEqual(id, server.analyticsUserIdFor(userId, "j".repeat(48)));
  assert.ok(!id.includes(userId));
  assert.equal(server.analyticsUserIdFor(userId, null), null);
  assert.equal(server.ga4UserIdKey({ GA4_USER_ID_KEY: "  " }), null);
});

// The client half: what reaches the gtag command queue.

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const win = {
  localStorage: storage(),
  sessionStorage: storage(),
  location: new URL("https://tomverse.app/"),
  setTimeout: () => 0,
  clearTimeout: () => {},
  matchMedia: () => ({ matches: false }),
};
globalThis.window = win;
globalThis.document = { cookie: "" };
globalThis.fetch = () => Promise.resolve({ ok: true, status: 202, body: null });

const client = await import("../lib/productAnalyticsClient.ts");

const userIdCommands = () =>
  (win.dataLayer || [])
    .map((entry) => Array.from(entry))
    .filter(([command, value]) => command === "set" && value && "user_id" in value)
    .map(([, value]) => value.user_id);

const configure = (measurementId) =>
  client.configureAnalyticsClient({
    country: "AU",
    language: "en",
    measurementId,
    plan: "Free",
  });

const ID = "0123456789abcdef0123456789abcdef";

test("with the feature off nothing is queued, not even a clear", () => {
  win.dataLayer = [];
  configure("G-TEST1234");
  client.applyGa4UserId(null);
  client.disableAnalyticsClient();
  assert.deepEqual(userIdCommands(), []);
});

test("an id is set only on a configured tag, and only if it is an analytics id", () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  client.applyGa4UserId(ID);
  assert.deepEqual(userIdCommands(), [], "no tag yet");

  configure(null);
  client.applyGa4UserId(ID);
  assert.deepEqual(userIdCommands(), [], "no measurement id");

  configure("G-TEST1234");
  client.applyGa4UserId("cmh1234567890accountid");
  client.applyGa4UserId("someone@example.com");
  assert.deepEqual(userIdCommands(), [], "an account id or an email is never sent");

  client.applyGa4UserId(ID);
  client.applyGa4UserId(ID);
  assert.deepEqual(userIdCommands(), [ID], "set once");
});

test("signing out or declining analytics clears it with a real null", () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  client.applyGa4UserId(ID);
  client.applyGa4UserId(null);
  assert.deepEqual(userIdCommands(), [ID, null], "sign-out");

  client.applyGa4UserId(ID);
  client.disableAnalyticsClient();
  assert.deepEqual(userIdCommands(), [ID, null, ID, null], "declining analytics");
});
