import assert from "node:assert/strict";
import test from "node:test";

import {
  amuxReviewPrivateProxyOrigin,
} from "../lib/originProtection.ts";

const privateDomain = "tomverse-amux-validation.railway.internal";

test("AMUX review proxy accepts only the running service private origin", () => {
  const env = {
    RAILWAY_PRIVATE_DOMAIN: privateDomain,
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: `http://${privateDomain}:8080`,
  };
  assert.equal(
    amuxReviewPrivateProxyOrigin(env),
    `http://${privateDomain}:8080`,
  );
});

test("AMUX review proxy refuses sibling, public and credential-bearing targets", () => {
  const rejected = [
    "http://sibling.railway.internal:8080",
    "https://staging-amux-validation.tomverse.app",
    `http://user:password@${privateDomain}:8080`,
    `http://${privateDomain}:8080/path`,
    `http://${privateDomain}:8080/?query=1`,
    `http://${privateDomain}`,
    `ftp://${privateDomain}:8080`,
  ];
  for (const origin of rejected) {
    assert.equal(amuxReviewPrivateProxyOrigin({
      RAILWAY_PRIVATE_DOMAIN: privateDomain,
      TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: origin,
    }), null, origin);
  }
});

test("AMUX review proxy fails closed without Railway's own domain identity", () => {
  assert.equal(amuxReviewPrivateProxyOrigin({
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: `http://${privateDomain}:8080`,
  }), null);
  assert.equal(amuxReviewPrivateProxyOrigin({
    RAILWAY_PRIVATE_DOMAIN: "example.internal",
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: "http://example.internal:8080",
  }), null);
});

test("AMUX review proxy normalizes case but rejects dotted and multi-label identities", () => {
  assert.equal(amuxReviewPrivateProxyOrigin({
    RAILWAY_PRIVATE_DOMAIN: privateDomain.toUpperCase(),
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: `HTTP://${privateDomain.toUpperCase()}:8080`,
  }), `http://${privateDomain}:8080`);
  assert.equal(amuxReviewPrivateProxyOrigin({
    RAILWAY_PRIVATE_DOMAIN: `${privateDomain}.`,
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: `http://${privateDomain}.:8080`,
  }), null);
  assert.equal(amuxReviewPrivateProxyOrigin({
    RAILWAY_PRIVATE_DOMAIN: "a.b.railway.internal",
    TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN: "http://a.b.railway.internal:8080",
  }), null);
});
