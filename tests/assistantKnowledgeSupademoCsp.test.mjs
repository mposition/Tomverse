import assert from "node:assert/strict";
import test from "node:test";

import {
  createStaticMarketingCsp,
  createStrictCsp,
} from "../lib/csp.ts";

test("both page policies admit only the Supademo root and its HTTPS subdomains", () => {
  for (const policy of [
    createStrictCsp("test-nonce"),
    createStaticMarketingCsp(),
  ]) {
    const frameDirective = policy
      .split("; ")
      .find((directive) => directive.startsWith("frame-src "));

    assert.equal(
      frameDirective,
      "frame-src https://accounts.google.com https://content.googleapis.com " +
        "https://docs.google.com https://drive.google.com " +
        "https://challenges.cloudflare.com https://supademo.com " +
        "https://*.supademo.com"
    );
  }
});
