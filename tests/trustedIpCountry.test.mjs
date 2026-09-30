import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getTrustedIpCountry } from "../lib/trustedIpCountry.ts";

// The sign-up screen records this country as the person's jurisdiction, so in
// production it is read only from traffic proven to be Cloudflare's (S4).

const SECRET = "s".repeat(40);
const saved = { ...process.env };
afterEach(() => {
  for (const key of ["NODE_ENV", "TRUSTED_PROXY_IP_HEADER", "CLOUDFLARE_ORIGIN_SECRET"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const headers = (extra = {}) =>
  new Headers({ "cf-ipcountry": "AU", "cf-connecting-ip": "203.0.113.7", ...extra });

test("production trusts the header only behind a proven Cloudflare origin", () => {
  process.env.NODE_ENV = "production";
  process.env.TRUSTED_PROXY_IP_HEADER = "cf-connecting-ip";
  process.env.CLOUDFLARE_ORIGIN_SECRET = SECRET;
  assert.equal(getTrustedIpCountry(headers({ "x-tomverse-origin-verify": SECRET })), "AU");
  assert.equal(getTrustedIpCountry(headers({ "x-tomverse-origin-verify": "wrong" })), null);
  assert.equal(getTrustedIpCountry(headers()), null);

  process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";
  assert.equal(getTrustedIpCountry(headers({ "x-tomverse-origin-verify": SECRET })), null);
});

test("outside production the header is read as sent, like the IP", () => {
  process.env.NODE_ENV = "test";
  assert.equal(getTrustedIpCountry(headers()), "AU");
  assert.equal(getTrustedIpCountry(new Headers()), null);
});
