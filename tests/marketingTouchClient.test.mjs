import assert from "node:assert/strict";
import test from "node:test";

// docs/policy/marketing-automation.md §10.1 on the client: the landing URL's
// UTM values become one `marketing_touch` under the same consent rule as every
// other event. Declined sends nothing and keeps nothing; undecided holds the
// touch in this tab's queue until analytics is allowed.

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

const requests = [];
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
const accepted = () => ({ ok: true, status: 202, body: null, text: async () => "" });
// Per test: what the server answers a marketing_touch with. Everything else
// is answered at once.
let answerTouch = () => Promise.resolve(accepted());
globalThis.fetch = (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url, body });
  return body.event_name === "marketing_touch" ? answerTouch() : Promise.resolve(accepted());
};
const flush = async () => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const client = await import("../lib/productAnalyticsClient.ts");

const land = (search) => {
  win.location = new URL(`https://tomverse.app/${search}`);
};
const touches = () => requests.filter((request) => request.body.event_name === "marketing_touch");
const pendingTouches = () =>
  JSON.parse(win.sessionStorage.getItem("tomverse_analytics_pending_events_v1") || "[]").filter(
    (event) => event.eventName === "marketing_touch",
  );
const configure = () =>
  client.configureAnalyticsClient({
    country: "AU",
    language: "en",
    measurementId: null,
    plan: "Guest",
  });
const reset = () => {
  client.disableAnalyticsClient();
  win.localStorage.removeItem("tomverse_analytics_consent_v1");
  requests.length = 0;
};

const LINK =
  "?utm_source=linkedin&utm_medium=social&utm_campaign=launch&utm_content=linkedin-1";

test("declined analytics: nothing is sent and nothing is kept", () => {
  reset();
  client.setAnalyticsConsent("declined");
  land(LINK);
  client.observeMarketingTouch();
  assert.equal(touches().length, 0);
  assert.equal(pendingTouches().length, 0);
  assert.equal(win.sessionStorage.getItem("tomverse_analytics_touch_seen_v1"), null);
});

test("undecided analytics: the touch waits in the tab and is not sent", () => {
  reset();
  land(LINK);
  client.observeMarketingTouch();
  assert.equal(touches().length, 0);
  assert.equal(pendingTouches().length, 1);

  // Declining afterwards drops it with the rest of the queue.
  client.setAnalyticsConsent("declined");
  client.disableAnalyticsClient();
  assert.equal(pendingTouches().length, 0);
});

test("once analytics is allowed, the held touch goes out with the landing URL's values", () => {
  reset();
  land(LINK);
  client.observeMarketingTouch();
  assert.equal(touches().length, 0);
  client.setAnalyticsConsent("accepted");
  land("?unrelated=1");
  configure();
  assert.equal(touches().length, 1);
  const [touch] = touches();
  assert.equal(touch.url, "/api/analytics/events");
  assert.deepEqual(
    {
      utm_source: touch.body.utm_source,
      utm_medium: touch.body.utm_medium,
      utm_campaign: touch.body.utm_campaign,
      properties: touch.body.properties.utm_content,
    },
    {
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "launch",
      properties: "linkedin-1",
    },
  );
  for (const key of Object.keys(touch.body.properties)) {
    assert.ok(!key.startsWith("touch_"), `the client never sends ${key}`);
  }
});

test("one touch per link per tab; a different link is a new touch with its own values", () => {
  reset();
  client.setAnalyticsConsent("accepted");
  land(LINK);
  configure();
  client.observeMarketingTouch();
  client.observeMarketingTouch();
  assert.equal(touches().length, 1);

  land("?utm_source=x&utm_medium=social&utm_campaign=autumn&utm_content=x-1");
  client.observeMarketingTouch();
  assert.equal(touches().length, 2);
  const second = touches()[1].body;
  assert.equal(second.utm_source, "x");
  assert.equal(second.utm_campaign, "autumn");
  assert.equal(second.properties.utm_content, "x-1");
});

test("a conversion released with a touch is sent only after the touch was answered", async () => {
  reset();
  let release;
  answerTouch = () => new Promise((resolve) => {
    release = () => resolve(accepted());
  });
  try {
    land(LINK);
    client.observeMarketingTouch();
    client.trackProductEventOnce("signup_completed", "signup_completed", 0, {
      method: "google",
    });
    client.trackProductEvent("landing_view");
    client.setAnalyticsConsent("accepted");
    configure();
    await flush();
    const names = () => requests.map((request) => request.body.event_name);
    assert.ok(names().includes("marketing_touch"));
    assert.ok(names().includes("landing_view"), "events that are not attributed do not wait");
    assert.ok(
      !names().includes("signup_completed"),
      "the server would look for the touch before storing it",
    );

    release();
    await flush();
    assert.ok(names().includes("signup_completed"));
    assert.ok(names().indexOf("marketing_touch") < names().indexOf("signup_completed"));
  } finally {
    answerTouch = () => Promise.resolve(accepted());
  }
});

test("declining analytics while a conversion waits for a touch cancels the conversion", async () => {
  reset();
  let release;
  answerTouch = () => new Promise((resolve) => {
    release = () => resolve(accepted());
  });
  try {
    land(LINK);
    client.observeMarketingTouch();
    client.trackProductEventOnce("signup_completed", "signup_completed", 0, {
      method: "google",
    });
    client.setAnalyticsConsent("accepted");
    configure();
    await flush();
    client.setAnalyticsConsent("declined");
    client.disableAnalyticsClient();
    release();
    await flush();
    assert.ok(
      !requests.some((request) => request.body.event_name === "signup_completed"),
      "nothing decided before the withdrawal goes out after it",
    );
  } finally {
    answerTouch = () => Promise.resolve(accepted());
  }
});

test("a touch waiting to be retried is not sent again after analytics is declined", async () => {
  reset();
  const timers = [];
  const originalSetTimeout = win.setTimeout;
  win.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  answerTouch = () =>
    Promise.resolve({ ok: false, status: 503, body: null, text: async () => "" });
  try {
    client.setAnalyticsConsent("accepted");
    land(LINK);
    configure();
    client.observeMarketingTouch();
    await flush();
    assert.equal(touches().length, 1);
    assert.ok(timers.length > 0, "a 503 schedules a retry");

    client.setAnalyticsConsent("declined");
    client.disableAnalyticsClient();
    for (const callback of timers.splice(0)) callback();
    await flush();
    for (const callback of timers.splice(0)) callback();
    await flush();
    assert.equal(touches().length, 1, "the retry after the withdrawal is dropped");
  } finally {
    win.setTimeout = originalSetTimeout;
    answerTouch = () => Promise.resolve(accepted());
  }
});

test("without a withdrawal a transient failure is still retried", async () => {
  reset();
  const timers = [];
  const originalSetTimeout = win.setTimeout;
  win.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  let failures = 1;
  answerTouch = () =>
    Promise.resolve(
      failures-- > 0
        ? { ok: false, status: 503, body: null, text: async () => "" }
        : accepted(),
    );
  try {
    client.setAnalyticsConsent("accepted");
    land(LINK);
    configure();
    client.observeMarketingTouch();
    await flush();
    for (const callback of timers.splice(0)) callback();
    await flush();
    assert.equal(touches().length, 2);
  } finally {
    win.setTimeout = originalSetTimeout;
    answerTouch = () => Promise.resolve(accepted());
  }
});

test("a visitor who had declined and then allows analytics on the landing page keeps the link", async () => {
  reset();
  client.setAnalyticsConsent("declined");
  land(LINK);
  client.observeMarketingTouch();
  assert.equal(pendingTouches().length, 0);

  // Allowing analytics re-runs the observer (it follows consent) before the
  // provider configures the client.
  client.setAnalyticsConsent("accepted");
  client.observeMarketingTouch();
  configure();
  await flush();
  assert.equal(touches().length, 1);
  assert.equal(touches()[0].body.utm_campaign, "launch");
});

test("with no touch in flight a conversion goes out without waiting", async () => {
  reset();
  client.setAnalyticsConsent("accepted");
  land("?ref=none");
  configure();
  client.trackProductEventOnce("first_response_completed", "first_response_completed", 1, {});
  await flush();
  assert.ok(requests.some((request) => request.body.event_name === "first_response_completed"));
});

test("a URL without UTM parameters is not a touch", () => {
  reset();
  client.setAnalyticsConsent("accepted");
  land("?ref=newsletter");
  configure();
  client.observeMarketingTouch();
  assert.equal(touches().length, 0);
});
