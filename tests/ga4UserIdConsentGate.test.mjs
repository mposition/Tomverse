import assert from "node:assert/strict";
import test from "node:test";

// docs/policy/marketing-automation.md §14 S6: the consent gate for the GA4
// User-ID. Nothing is created or sent without explicit consent, without the
// published notice, or with the switch off -- each on its own. The notice is
// published (the privacy policy revision that describes the identifier ships
// with GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED = true, §10.2), so the switch is the
// gate that keeps the shipped build from creating or sending anything until the
// owner turns it on. Declining while signed in withdraws the stored id.

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

test("the notice is published, and the default switch still leaves a User-ID uncreated and unsent", () => {
  assert.equal(policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED, true);
  // Everything else is satisfied; only the switch differs. Anything but the
  // string "true" (any case, trimmed) is off, including a boolean.
  for (const switchValue of [undefined, null, "", "false", "0", "no", "off", "enabled", false, true, 1]) {
    assert.equal(
      policy.ga4UserIdTransmissionAllowed({
        ...allOn,
        noticePublished: policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
        switchValue,
      }),
      false,
      `switch ${JSON.stringify(switchValue)}`,
    );
  }
  // The server reads the real constant by default and agrees: without the
  // switch it hands out nothing.
  assert.equal(server.ga4UserIdServerEnabled({}), false, "switch unset");
  assert.equal(server.ga4UserIdServerEnabled({ NEXT_PUBLIC_GA4_USER_ID_ENABLED: "" }), false);
  assert.equal(server.ga4UserIdServerEnabled({ NEXT_PUBLIC_GA4_USER_ID_ENABLED: "false" }), false);
  assert.equal(server.ga4UserIdServerEnabled({ NEXT_PUBLIC_GA4_USER_ID_ENABLED: "true" }), true);
  assert.equal(server.ga4UserIdServerEnabled({ NEXT_PUBLIC_GA4_USER_ID_ENABLED: " TRUE " }), true);
  // And the switch alone is not enough: the notice is still a condition.
  assert.equal(
    server.ga4UserIdServerEnabled({ NEXT_PUBLIC_GA4_USER_ID_ENABLED: "true" }, false),
    false,
  );
  // The notice alone does not enable it either; consent, a session and a tag
  // stay conditions on top of the switch.
  for (const missing of ["consent", "signedIn", "measurementId"]) {
    assert.equal(
      policy.ga4UserIdTransmissionAllowed({
        ...allOn,
        noticePublished: policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
        [missing]: missing === "signedIn" ? false : null,
      }),
      false,
      missing,
    );
  }
});

test("declining withdraws for a signed-in visitor once the notice is out, switch or not", () => {
  assert.equal(
    policy.ga4UserIdWithdrawalApplies({ noticePublished: true, signedIn: true }),
    true,
  );
  assert.equal(
    policy.ga4UserIdWithdrawalApplies({ noticePublished: true, signedIn: false }),
    false,
    "a signed-out decline names no account",
  );
});

test("the User-ID is 128 random bits: never the account id, new every time", () => {
  const ids = new Set(Array.from({ length: 256 }, () => server.newAnalyticsUserId()));
  assert.equal(ids.size, 256);
  for (const id of ids) assert.equal(policy.isAnalyticsUserId(id), true, id);
  assert.equal(policy.isAnalyticsUserId("cmh1234567890accountid"), false);
  assert.equal(policy.isAnalyticsUserId("someone@example.com"), false);
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

const ID_B = "fedcba9876543210fedcba9876543210";
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("switching accounts clears the first id before the second is asked for", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");

  const first = deferred();
  const cancelA = client.syncGa4UserId(true, () => first.promise);
  first.resolve(ID);
  await flush();
  assert.deepEqual(userIdCommands(), [ID]);

  // The session moves to account B: the effect cancels A's run and starts B's.
  cancelA();
  const second = deferred();
  const cancelB = client.syncGa4UserId(true, () => second.promise);
  assert.deepEqual(userIdCommands(), [ID, null], "A is cleared before B's lookup returns");

  second.reject(new Error("network"));
  await flush();
  assert.deepEqual(userIdCommands(), [ID, null], "a failed lookup leaves it cleared");
  cancelB();

  const third = deferred();
  client.syncGa4UserId(true, () => third.promise);
  third.resolve(ID_B);
  await flush();
  assert.deepEqual(userIdCommands(), [ID, null, ID_B]);
});

test("a lookup that finishes after its account left is never applied", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  const late = deferred();
  const cancel = client.syncGa4UserId(true, () => late.promise);
  cancel();
  client.syncGa4UserId(false);
  late.resolve(ID);
  await flush();
  assert.deepEqual(userIdCommands(), []);
});

test("a re-configuration clears the id before its page_view and cancels a lookup in flight", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  const first = deferred();
  client.syncGa4UserId(true, () => first.promise);
  first.resolve(ID);
  await flush();
  assert.deepEqual(userIdCommands(), [ID]);

  // The account changes and the provider re-runs configuration in the same
  // render, before the User-ID effect: the page_view it sends must not carry A.
  const before = win.dataLayer.length;
  configure("G-TEST1234");
  const commands = win.dataLayer.slice(before).map((entry) => Array.from(entry));
  const cleared = commands.findIndex(
    ([command, value]) => command === "set" && value && value.user_id === null,
  );
  const config = commands.findIndex(([command]) => command === "config");
  assert.ok(cleared !== -1 && config !== -1 && cleared < config, JSON.stringify(commands));

  const inFlight = deferred();
  client.syncGa4UserId(true, () => inFlight.promise);
  configure("G-TEST1234");
  inFlight.resolve(ID);
  await flush();
  assert.deepEqual(userIdCommands(), [ID, null], "the cancelled lookup is never applied");
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

test("the request that creates an id states the explicit consent it acts on", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ analyticsUserId: ID }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    client.syncGa4UserId(true);
    await flush();
    await flush();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/analytics/user-id");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), { consent: "accepted" });
  assert.deepEqual(userIdCommands(), [ID]);
});

test("notice published, switch off: the provider's decision issues no request and sets no id", async () => {
  for (const switchValue of [undefined, "", "false"]) {
    client.disableAnalyticsClient();
    win.dataLayer = [];
    configure("G-TEST1234");
    const allowed = policy.ga4UserIdTransmissionAllowed({
      ...allOn,
      noticePublished: policy.GA4_USER_ID_PRIVACY_NOTICE_PUBLISHED,
      switchValue,
    });
    assert.equal(allowed, false, `switch ${JSON.stringify(switchValue)}`);
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ analyticsUserId: ID }), { status: 200 });
    };
    try {
      client.syncGa4UserId(allowed);
      await flush();
      await flush();
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(requests, [], `switch ${JSON.stringify(switchValue)}`);
    assert.deepEqual(userIdCommands(), [], `switch ${JSON.stringify(switchValue)}`);
  }
});

test("not asked for, no request at all: nothing is created before consent", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(null, { status: 404 });
  };
  try {
    client.syncGa4UserId(false);
    await flush();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(requests, []);
  assert.deepEqual(userIdCommands(), []);
});

test("withdrawing clears the tag's id and asks the server to delete it, once", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  client.applyGa4UserId(ID);
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    throw new Error("offline");
  };
  try {
    await client.withdrawGa4UserId();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(userIdCommands(), [ID, null], "cleared on the tag with a real null");
  assert.equal(requests.length, 1, "one request, not retried after a failure");
  assert.equal(requests[0].url, "/api/analytics/user-id");
  assert.equal(requests[0].init.method, "DELETE");
  assert.equal(requests[0].init.keepalive, true, "survives the navigation a decline may cause");
});

test("after declining, accepting again asks for an id only once the withdrawal is answered", async () => {
  client.disableAnalyticsClient();
  win.dataLayer = [];
  configure("G-TEST1234");
  const requests = [];
  const withdrawalAnswer = deferred();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push(init.method);
    if (init.method === "DELETE") {
      await withdrawalAnswer.promise;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ analyticsUserId: ID_B }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const withdrawal = client.withdrawGa4UserId();
    client.syncGa4UserId(true);
    await flush();
    await flush();
    assert.deepEqual(requests, ["DELETE"], "no id is asked for while the withdrawal is open");
    withdrawalAnswer.resolve();
    await withdrawal;
    await flush();
    await flush();
    await flush();
    assert.deepEqual(requests, ["DELETE", "POST"]);
    assert.deepEqual(userIdCommands(), [ID_B], "the new id, after the withdrawal");
  } finally {
    globalThis.fetch = original;
  }
});
