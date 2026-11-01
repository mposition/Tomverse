import assert from "node:assert/strict";
import test from "node:test";

import {
  LANDING_EXPERIMENT_BUNDLES,
  landingExperimentBundle,
  landingExperimentStaticParams,
  landingVariantCopy,
  landingVariantLocales,
} from "../components/marketing/landingExperimentBundles.ts";

// The landing copy contract (tests/landingContent.test.mjs) does not reach a
// variant, because a variant is not a locale table. This is its counterpart:
// what a bundle may say, and where it may say it.

const SURFACE_FIELDS = new Set(["title", "body", "cta"]);
const LOCALES = new Set(["en", "ko", "zh", "fr", "de", "es", "pt"]);

// Claims the default page is already held to, and the ones an experiment is
// most tempted to reach for. A variant may not outrun the product either.
const BANNED = [
  /guarantee/i,
  /best\b/i,
  /#1\b/,
  /100%/,
  /free forever/i,
  /no credit card/i,
  /unlimited/i,
  /always (accurate|correct)/i,
  /보장/,
  /무제한/,
  /최고/,
  /완벽/,
];

const collect = (copy) => [
  ...(copy.title ?? []),
  ...(copy.body ? [copy.body] : []),
  ...(copy.cta ? [copy.cta] : []),
];

test("every bundle is a home bundle with at least one variant, and ids are unique", () => {
  assert.ok(LANDING_EXPERIMENT_BUNDLES.length > 0);
  const ids = LANDING_EXPERIMENT_BUNDLES.map((bundle) => bundle.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const bundle of LANDING_EXPERIMENT_BUNDLES) {
    assert.match(bundle.id, /^home-[a-z0-9-]{3,43}$/);
    assert.equal(bundle.surface, "home");
    assert.ok(Object.keys(bundle.variants).length > 0);
    for (const variant of Object.keys(bundle.variants)) {
      assert.match(variant, /^[a-z0-9][a-z0-9-]{0,47}$/);
      assert.notEqual(variant, "control");
    }
  }
});

test("a variant can only vary the headline, the subtitle and the call to action", () => {
  for (const bundle of LANDING_EXPERIMENT_BUNDLES) {
    for (const [variant, locales] of Object.entries(bundle.variants)) {
      assert.ok(Object.keys(locales).length > 0, `${bundle.id}/${variant} has no locale`);
      for (const [locale, copy] of Object.entries(locales)) {
        assert.ok(LOCALES.has(locale), `${bundle.id}/${variant}: ${locale}`);
        assert.ok(Object.keys(copy).length > 0, `${bundle.id}/${variant}/${locale} is empty`);
        for (const field of Object.keys(copy)) {
          assert.ok(
            SURFACE_FIELDS.has(field),
            `${bundle.id}/${variant}/${locale} reaches outside the surface: ${field}`
          );
        }
      }
    }
  }
});

test("variant copy is present, bounded and makes no claim the product does not", () => {
  for (const bundle of LANDING_EXPERIMENT_BUNDLES) {
    for (const [variant, locales] of Object.entries(bundle.variants)) {
      for (const [locale, copy] of Object.entries(locales)) {
        const where = `${bundle.id}/${variant}/${locale}`;
        if (copy.title) {
          assert.equal(copy.title.length, 2, `${where} headline is two lines`);
          for (const line of copy.title) {
            assert.ok(line.trim().length >= 3 && line.length <= 60, `${where} headline line`);
          }
        }
        if (copy.body) assert.ok(copy.body.length >= 40 && copy.body.length <= 500, where);
        if (copy.cta) assert.ok(copy.cta.length >= 2 && copy.cta.length <= 40, where);
        for (const text of collect(copy)) {
          for (const pattern of BANNED) {
            assert.doesNotMatch(text, pattern, `${where} says: ${text}`);
          }
        }
      }
    }
  }
});

test("a bundle that varies the headline keeps the AI Review promise out of the headline claims it cannot back", () => {
  // The default hero says AI Review compares the supplied answers; a variant
  // that mentions it must not say it checks facts by itself.
  for (const bundle of LANDING_EXPERIMENT_BUNDLES) {
    for (const [variant, locales] of Object.entries(bundle.variants)) {
      for (const [locale, copy] of Object.entries(locales)) {
        const text = collect(copy).join(" ");
        assert.doesNotMatch(
          text,
          /(verif(y|ies)|fact-?check|사실 ?확인|검증해)/i,
          `${bundle.id}/${variant}/${locale}`
        );
      }
    }
  }
});

test("lookups only answer for what exists, and own properties only", () => {
  const [bundle] = LANDING_EXPERIMENT_BUNDLES;
  const [variant] = Object.keys(bundle.variants);
  const [locale] = landingVariantLocales(bundle.id, variant);
  assert.ok(landingVariantCopy(bundle.id, variant, locale));
  assert.equal(landingExperimentBundle("home-unknown-v9"), null);
  assert.equal(landingVariantCopy(bundle.id, "zz", locale), null);
  assert.equal(landingVariantCopy(bundle.id, variant, "xx"), null);
  // Prototype keys are not variants or locales.
  assert.equal(landingVariantCopy(bundle.id, "toString", locale), null);
  assert.equal(landingVariantCopy(bundle.id, variant, "constructor"), null);
  assert.deepEqual(landingVariantLocales(bundle.id, "__proto__"), []);
});

test("the build prerenders one route per bundle, variant and covered locale", () => {
  const params = landingExperimentStaticParams();
  const expected = LANDING_EXPERIMENT_BUNDLES.flatMap((bundle) =>
    Object.entries(bundle.variants).flatMap(([variant, locales]) =>
      Object.keys(locales).map((locale) => `${locale}/${bundle.id}/${variant}`)
    )
  );
  assert.deepEqual(
    params.map((item) => `${item.locale}/${item.bundle}/${item.variant}`).sort(),
    expected.sort()
  );
});

test("the covered languages are one list, and the beacon stays silent outside it", async () => {
  const { LANDING_EXPERIMENT_LOCALES } = await import(
    "../components/marketing/landingExperimentBundles.ts"
  );
  assert.deepEqual([...LANDING_EXPERIMENT_LOCALES], [...LOCALES]);
  // zh-Hant has no variant copy: its visitors see the default page and the
  // experiment route (which would refuse the language) is never asked.
  assert.ok(!LANDING_EXPERIMENT_LOCALES.includes("zh-Hant"));
  const { readFileSync } = await import("node:fs");
  const beacon = readFileSync(
    new URL("../components/marketing/LandingExperimentBeacon.tsx", import.meta.url),
    "utf8"
  );
  assert.match(beacon, /LANDING_EXPERIMENT_LOCALES as readonly string\[\]\)\.includes\(locale\)\) return;/);
});

test("the beacon tells a refused count from one that got no answer, and holds a variant on an unreadable state", async () => {
  const { readFileSync } = await import("node:fs");
  const beacon = readFileSync(
    new URL("../components/marketing/LandingExperimentBeacon.tsx", import.meta.url),
    "utf8"
  );
  // A non-ok response is a definite refusal, carried with its status.
  assert.match(beacon, /response\.ok \? response\.json\(\) : \{ status: "error", http: response\.status \}/);
  // Only a 503 (the route's answer to an unreadable state) holds a variant, and
  // the assignment cookie is never touched on that path.
  assert.match(beacon, /if \(result\.http === 503\) \{[^}]*holdVariant\(renderedArm\)/s);
  const hold = beacon.slice(beacon.indexOf("const holdVariant"), beacon.indexOf("export function"));
  assert.ok(!hold.includes("clearCookie("), "a hold does not delete the assignment");
  assert.match(hold, /EXPERIMENT_HOLD_COOKIE_NAME/);
  // Both counts are taken back on a definite refusal.
  assert.match(beacon, /answer\?\.status === "error"\) session\.remove\(conversionKey\)/);
  assert.match(beacon, /result\.status === "error"\) \{\s*retract\(\);/);
});

test("a variant on screen without an assignment cookie goes back to the default copy before the route is asked", async () => {
  const { readFileSync } = await import("node:fs");
  const beacon = readFileSync(
    new URL("../components/marketing/LandingExperimentBeacon.tsx", import.meta.url),
    "utf8"
  );
  const run = beacon.slice(beacon.indexOf("const run = async"));
  const at = (needle) => run.indexOf(needle);
  const guard = at("if (!cookieValue && renderedArm !== EXPERIMENT_CONTROL_ARM) {");
  assert.ok(guard > 0, "the guard exists");
  // It comes before the assign request and before the remembered "off" answer.
  assert.ok(guard < at('await post("assign")'));
  assert.ok(guard < at("probeIsOff(probeKey)"));
  assert.ok(run.slice(guard, guard + 200).includes("leaveVariant(renderedArm, null);"));
});
