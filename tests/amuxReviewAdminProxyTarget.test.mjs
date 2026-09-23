import assert from "node:assert/strict";
import test from "node:test";

import { forwardAmuxAdminReviewCommand } from "../lib/amux/reviewAdminProxy.ts";

const publicOrigin = "https://staging-amux-validation.tomverse.app";
const privateDomain = "tomverse-amux-validation.railway.internal";
const privateOrigin = `http://${privateDomain}:8080`;
const syncSecret = "s".repeat(48);

test("admin review proxy sends credentials only to the validated target", async () => {
  const keys = [
    "NEXTAUTH_URL",
    "TOMVERSE_AMUX_SYNC_SECRET",
    "TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED",
    "TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN",
    "RAILWAY_PRIVATE_DOMAIN",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];

  process.env.NEXTAUTH_URL = publicOrigin;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = syncSecret;
  process.env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED = "true";
  process.env.RAILWAY_PRIVATE_DOMAIN = privateDomain;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({ success: true });
  };

  const browserRequest = new Request(`${publicOrigin}/api/admin/amux/escalations/review`, {
    headers: {
      cookie: "__Secure-next-auth.session-token=session",
      "x-tomverse-origin-verify": "o".repeat(48),
    },
  });

  try {
    process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = privateOrigin;
    assert.equal((await forwardAmuxAdminReviewCommand(browserRequest, { action: "detail" })).status, 200);
    assert.equal(calls.at(-1).url, `${privateOrigin}/api/internal/amux/review`);
    assert.equal(calls.at(-1).headers.get("authorization"), `Bearer ${syncSecret}`);
    assert.equal(calls.at(-1).headers.get("cookie"), "__Secure-next-auth.session-token=session");

    process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = "http://sibling.railway.internal:8080";
    const callsBeforeInvalid = calls.length;
    const invalid = await forwardAmuxAdminReviewCommand(browserRequest, { action: "detail" });
    assert.equal(invalid.status, 503);
    assert.equal(calls.length, callsBeforeInvalid);
    assert.equal((await invalid.json()).code, "AMUX_REVIEW_PROXY_CONFIG_INVALID");

    delete process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN;
    assert.equal((await forwardAmuxAdminReviewCommand(browserRequest, { action: "detail" })).status, 200);
    assert.equal(calls.at(-1).url, `${publicOrigin}/api/internal/amux/review`);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
