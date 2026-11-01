import assert from "node:assert/strict";
import test from "node:test";

// The route is exercised through its fixture: a loopback server with the
// database stubbed out, and an experiment read from the environment only for
// a request that carries the fixture header. Nothing here touches a database.
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.E2E_AUTH_BYPASS = "true";
process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL = "http://127.0.0.1:3100";
delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
process.env.E2E_MARKETING_EXPERIMENT = JSON.stringify({
  version: 1,
  experimentId: "fixture-run",
  bundleId: "home-hero-v1",
  variantId: "b",
  locales: ["en", "ko"],
  variantRatio: 0.5,
  startsAt: "2026-01-01T00:00:00Z",
  endsAt: "2026-02-01T00:00:00Z",
  preregistration: {
    hypothesis: "A plainer headline raises primary call-to-action clicks.",
    primaryMetric: "primary_cta_click",
    minExposuresPerArm: 100,
    stopRule: { relativeDropPercent: 30, afterExposuresPerArm: 50 },
  },
  status: "running",
  stoppedAt: null,
});

const { POST } = await import("../app/api/marketing/experiments/route.ts");

const VARIANT = "fixture-run.home-hero-v1.b";
const CONTROL = "fixture-run.home-hero-v1.control";

const call = async (body, headers = {}) => {
  const response = await POST(
    new Request("http://127.0.0.1:3100/api/marketing/experiments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3100",
        "x-e2e-marketing-experiment": "variant",
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
  return {
    status: response.status,
    json: await response.json(),
    setCookie: response.headers.get("set-cookie") ?? "",
    cacheControl: response.headers.get("cache-control"),
  };
};

const base = { action: "assign", consent: "accepted", locale: "en" };

test("every answer is private and uncacheable", async () => {
  const result = await call(base);
  assert.equal(result.cacheControl, "private, no-store");
});

test("without the fixture header there is no experiment, whatever the environment says", async () => {
  const result = await call(base, { "x-e2e-marketing-experiment": "" });
  assert.equal(result.json.status, "off");
  assert.ok(!result.setCookie.includes(VARIANT));
});

test("a forced roll decides the arm and the cookie says so", async () => {
  const variant = await call(base);
  assert.equal(variant.json.status, "assigned");
  assert.equal(variant.json.arm, "b");
  assert.match(variant.setCookie, new RegExp(`tv_exp=${VARIANT}`));
  assert.match(variant.setCookie, /Path=\//i);
  assert.match(variant.setCookie, /SameSite=lax/i);
  assert.match(variant.setCookie, /Max-Age=\d+/i);
  assert.doesNotMatch(variant.setCookie, /Secure/i);

  const control = await call(base, { "x-e2e-marketing-experiment": "control" });
  assert.equal(control.json.arm, "control");
  assert.match(control.setCookie, new RegExp(`tv_exp=${CONTROL}`));
});

test("an existing valid assignment is kept, not re-rolled", async () => {
  const result = await call(base, {
    cookie: `tv_exp=${CONTROL}`,
    "x-e2e-marketing-experiment": "variant",
  });
  assert.equal(result.json.arm, "control");
  assert.equal(result.setCookie, "");
});

test("consent decides first: nothing is assigned or counted without analytics", async () => {
  for (const consent of ["declined", "unset"]) {
    const result = await call({ ...base, consent });
    assert.equal(result.json.status, "off", consent);
    assert.match(result.setCookie, /tv_exp=;|tv_exp=(?:;|$)/, consent);
    assert.match(result.setCookie, /Max-Age=0/i, consent);
  }
  // A notice-with-opt-out country is on until declined.
  const australia = await call({ ...base, consent: "unset" }, { "cf-ipcountry": "AU" });
  assert.equal(australia.json.status, "assigned");
  const germany = await call({ ...base, consent: "unset" }, { "cf-ipcountry": "DE" });
  assert.equal(germany.json.status, "off");
});

test("a language the experiment does not cover is left on the default copy", async () => {
  const result = await call({ ...base, locale: "fr" });
  assert.equal(result.json.status, "off");
  assert.match(result.setCookie, /Max-Age=0/i);
});

test("exposure and conversion count only when the rendered arm is the assigned arm", async () => {
  const counted = await call(
    { action: "exposure", consent: "accepted", locale: "en", renderedArm: "b" },
    { cookie: `tv_exp=${VARIANT}` }
  );
  assert.equal(counted.json.status, "recorded");
  assert.equal(counted.json.arm, "b");

  const alreadyCounted = await call(
    { action: "exposure", consent: "accepted", locale: "en", renderedArm: "b", record: false },
    { cookie: `tv_exp=${VARIANT}` }
  );
  assert.equal(alreadyCounted.json.status, "recorded");

  const click = await call(
    { action: "conversion", consent: "accepted", locale: "en", renderedArm: "control" },
    { cookie: `tv_exp=${CONTROL}` }
  );
  assert.equal(click.json.status, "recorded");

  // The page showed the default copy to a visitor assigned to the variant.
  const fallback = await call(
    { action: "exposure", consent: "accepted", locale: "en", renderedArm: "control" },
    { cookie: `tv_exp=${VARIANT}` }
  );
  assert.equal(fallback.json.status, "ignored");
});

test("a cookie from another experiment or a forged one is deleted and counts nothing", async () => {
  for (const cookie of [
    "old-run.home-hero-v1.b",
    "fixture-run.home-other-v1.b",
    "fixture-run.home-hero-v1.zz",
    "garbage",
  ]) {
    const result = await call(
      { action: "exposure", consent: "accepted", locale: "en", renderedArm: "b" },
      { cookie: `tv_exp=${cookie}` }
    );
    assert.equal(result.json.status, "off", cookie);
    assert.match(result.setCookie, /Max-Age=0/i, cookie);
  }
  // No cookie at all on an exposure is the same answer.
  const bare = await call({
    action: "exposure",
    consent: "accepted",
    locale: "en",
    renderedArm: "b",
  });
  assert.equal(bare.json.status, "off");
});

test("a malformed body is refused rather than interpreted", async () => {
  for (const body of [
    {},
    { ...base, action: "delete" },
    { ...base, consent: "yes" },
    { ...base, locale: "xx" },
    { ...base, renderedArm: "NOT VALID" },
    { ...base, extra: true },
  ]) {
    const result = await call(body);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
});

test("the kill switch turns every answer into off", async () => {
  process.env.MARKETING_AUTOMATION_KILL_SWITCH = "1";
  try {
    const result = await call(base);
    assert.equal(result.json.status, "off");
    assert.ok(!result.setCookie.includes(VARIANT));
  } finally {
    delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
  }
});
