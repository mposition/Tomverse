import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { proxy } from "../proxy.ts";

const privateDomain = "tomverse-amux-validation.railway.internal";
const privateHost = `${privateDomain}:8080`;
const secret = "x".repeat(48);

const request = (pathname, { method = "POST", originSecret } = {}) =>
  new NextRequest(new Request(`http://${privateHost}${pathname}`, {
    method,
    headers: {
      host: privateHost,
      ...(originSecret ? { "x-tomverse-origin-verify": originSecret } : {}),
    },
  }));

test("private AMUX review host is confined to one POST route and always needs the origin secret", () => {
  const previous = Object.fromEntries([
    "TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN",
    "RAILWAY_PRIVATE_DOMAIN",
    "CLOUDFLARE_ORIGIN_SECRET",
    "REQUIRE_CLOUDFLARE_ORIGIN_SECRET",
  ].map((key) => [key, process.env[key]]));

  process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = `http://${privateHost}`;
  process.env.RAILWAY_PRIVATE_DOMAIN = privateDomain;
  process.env.CLOUDFLARE_ORIGIN_SECRET = secret;

  try {
    delete process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN;
    assert.equal(
      proxy(request("/api/internal/amux/review", { originSecret: secret })).status,
      421,
    );

    process.env.TOMVERSE_AMUX_REVIEW_INTERNAL_ORIGIN = `http://${privateHost}`;
    for (const requireSecret of ["false", "true"]) {
      process.env.REQUIRE_CLOUDFLARE_ORIGIN_SECRET = requireSecret;
      assert.equal(
        proxy(request("/api/internal/amux/review", { originSecret: secret })).status,
        200,
      );
      assert.equal(proxy(request("/api/internal/amux/review")).status, 421);
      assert.equal(
        proxy(request("/api/internal/amux/review", { originSecret: "wrong" })).status,
        421,
      );
      assert.equal(
        proxy(request("/api/internal/amux/review", {
          method: "GET",
          originSecret: secret,
        })).status,
        421,
      );
      assert.equal(
        proxy(request("/api/admin/amux/routing", { originSecret: secret })).status,
        421,
      );
      assert.equal(proxy(request("/", { originSecret: secret })).status, 421);

      const siblingHost = "sibling.railway.internal:8080";
      const siblingRequest = new NextRequest(new Request(
        `http://${siblingHost}/api/internal/amux/review`,
        {
          method: "POST",
          headers: {
            host: siblingHost,
            "x-tomverse-origin-verify": secret,
          },
        },
      ));
      assert.equal(proxy(siblingRequest).status, 421);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
