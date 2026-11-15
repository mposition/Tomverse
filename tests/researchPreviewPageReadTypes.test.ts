import assert from "node:assert/strict";
import test from "node:test";
import type { RequestOptions } from "node:https";
import { researchPageRequestOptions, type ResearchPageAddress } from "../lib/researchPreviewPageRead";

test("pinned IPv4 and IPv6 lookups satisfy the native HTTPS option types without fallback DNS", () => {
  const targets: ResearchPageAddress[] = [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }];
  for (const target of targets) {
    const options: RequestOptions = researchPageRequestOptions(new URL("https://public.example.com/page"), target, new AbortController().signal);
    assert.equal(options.hostname, "public.example.com");
    assert.equal(options.servername, "public.example.com");
    assert.equal(options.family, target.family);
    assert.equal(options.rejectUnauthorized, true);
    options.lookup!("public.example.com", { family: target.family }, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, target.address); assert.equal(family, target.family);
    });
  }
});
