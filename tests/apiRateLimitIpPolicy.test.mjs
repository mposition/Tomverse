import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ANONYMOUS_IP_LIMIT_MULTIPLIER,
  SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER,
  ipBucketLimit,
  isSignedInRateLimitSubject,
} from "../lib/apiRateLimitIpPolicy.ts";

const USER_ID = "cm0abcdefghijklmnopqrstuv";
const USAGE_KEY = `user:${"a".repeat(64)}`;

test("a signed-in subject gets a wide per-minute IP ceiling and no per-day IP bucket", () => {
  // conversation create: { minute: 10, day: 100 }
  assert.equal(ipBucketLimit(USER_ID, "minute", 10), 10 * SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER);
  assert.equal(ipBucketLimit(USER_ID, "day", 100), null);
  assert.equal(ipBucketLimit(USAGE_KEY, "minute", 10), 80);
  assert.equal(ipBucketLimit(USAGE_KEY, "day", 100), null);
  // Strictly wider than the old 3x that let one office throttle itself.
  assert.ok(SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER >= 8);
});

test("anonymous subjects keep the original 3x ceiling in both periods", () => {
  for (const subject of [
    "guest:203.0.113.7",
    `guest:${"b".repeat(64)}`,
    "anonymous:unknown:0123456789abcdef",
    "signup-intent:203.0.113.7",
    "ip:203.0.113.7",
  ]) {
    assert.equal(isSignedInRateLimitSubject(subject), false, subject);
    assert.equal(ipBucketLimit(subject, "minute", 10), 10 * ANONYMOUS_IP_LIMIT_MULTIPLIER);
    assert.equal(ipBucketLimit(subject, "day", 100), 100 * ANONYMOUS_IP_LIMIT_MULTIPLIER);
  }
  assert.equal(ANONYMOUS_IP_LIMIT_MULTIPLIER, 3);
});

test("a raw client IP passed as the subject fails closed to the anonymous ceiling", () => {
  // lib/mobileAuthRoute.ts passes getAnonymousClientKey() straight through.
  for (const subject of ["203.0.113.7", "2001:db8::1", "unknown:0123456789abcdef", ""]) {
    assert.equal(isSignedInRateLimitSubject(subject), false, subject);
    assert.equal(ipBucketLimit(subject, "day", 20), 60);
  }
});

test("consumeApiRateLimit applies the policy to its IP leg", () => {
  const source = readFileSync(new URL("../lib/apiSecurity.ts", import.meta.url), "utf8");
  assert.match(source, /ipBucketLimit\(userId, period, limits\[period\]\)/);
  assert.doesNotMatch(source, /limits\[period\] \* 3/);
});
