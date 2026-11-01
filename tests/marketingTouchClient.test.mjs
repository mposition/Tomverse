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
globalThis.fetch = (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  return Promise.resolve({ ok: true, status: 202, body: null });
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

test("a URL without UTM parameters is not a touch", () => {
  reset();
  client.setAnalyticsConsent("accepted");
  land("?ref=newsletter");
  configure();
  client.observeMarketingTouch();
  assert.equal(touches().length, 0);
});
