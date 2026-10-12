import assert from "node:assert/strict";
import test from "node:test";

import { proxyMarketingBoundary } from "../lib/marketingRoutes.ts";

test("API responses never use marketing redirects or public cache classification", () => {
  for (const pathname of ["/api/chat", "/api/products/chat/capabilities"]) {
    let classifierCalls = 0;
    let redirectCalls = 0;
    const result = proxyMarketingBoundary({
      pathname,
      method: "GET",
      isStatic: () => { classifierCalls += 1; return true; },
      redirect: () => { redirectCalls += 1; return "/ko/chat"; },
    });
    assert.deepEqual(result, { staticMarketing: false, redirect: null });
    assert.equal(classifierCalls, 0);
    assert.equal(redirectCalls, 0);
  }
});

test("marketing GETs retain their existing classification and redirect", () => {
  assert.deepEqual(proxyMarketingBoundary({
    pathname: "/pricing", method: "GET",
    isStatic: () => true,
    redirect: () => "/ko/pricing",
  }), { staticMarketing: true, redirect: "/ko/pricing" });
  assert.deepEqual(proxyMarketingBoundary({
    pathname: "/pricing", method: "POST",
    isStatic: () => true,
    redirect: () => "/ko/pricing",
  }), { staticMarketing: true, redirect: null });
});
