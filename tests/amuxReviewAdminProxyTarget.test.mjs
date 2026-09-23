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
    "PORT",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];

  process.env.NEXTAUTH_URL = publicOrigin;
  process.env.TOMVERSE_AMUX_SYNC_SECRET = syncSecret;
  process.env.TOMVERSE_AMUX_AGENT_APPROVAL_ENABLED = "true";
  process.env.RAILWAY_PRIVATE_DOMAIN = privateDomain;
  process.env.PORT = "8080";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({ success: true });
  };

  const browserRequest = new Request(`${publicOrigin}/api/admin/amux/escalations/review`, {
    headers: {
      host: new URL(publicOrigin).host,
      cookie: "__Secure-next-auth.session-token=session",
      "x-tomverse-origin-verify": "o".repeat(48),
    },
  });

  const railwayRequest = new Request("http://127.0.0.1:8080/api/admin/amux/escalations/review", {
    headers: browserRequest.headers,
  });

  try {
    process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = privateOrigin;
    assert.equal((await forwardAmuxAdminReviewCommand(browserRequest, { action: "detail" })).status, 200);
    assert.equal(calls.at(-1).url, `${privateOrigin}/api/internal/amux/review`);
    assert.equal(calls.at(-1).headers.get("authorization"), `Bearer ${syncSecret}`);
    assert.equal(calls.at(-1).headers.get("cookie"), "__Secure-next-auth.session-token=session");

    assert.equal((await forwardAmuxAdminReviewCommand(railwayRequest, { action: "detail" })).status, 200);
    assert.equal(calls.at(-1).url, `${privateOrigin}/api/internal/amux/review`);

    const wrongHostRequest = new Request(`${publicOrigin}/api/admin/amux/escalations/review`, {
      headers: {
        ...Object.fromEntries(browserRequest.headers),
        host: "sibling.example.com",
      },
    });
    const callsBeforeWrongHost = calls.length;
    const wrongHost = await forwardAmuxAdminReviewCommand(wrongHostRequest, { action: "detail" });
    assert.equal(wrongHost.status, 503);
    assert.equal((await wrongHost.json()).code, "AMUX_REVIEW_PROXY_ORIGIN_MISMATCH");
    assert.equal(calls.length, callsBeforeWrongHost);

    process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = "http://127.0.0.1:8080";
    assert.equal((await forwardAmuxAdminReviewCommand(browserRequest, { action: "detail" })).status, 200);
    assert.equal(calls.at(-1).url, "http://127.0.0.1:8080/api/internal/amux/review");
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
