import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * E1's route properties (docs/policy/trust-safety-compliance-agent.md §4, §5.6).
 *
 * These are read off the route's source rather than exercised through a
 * request, because every one of them is a property of what the file may
 * contain: §4 fixes the authentication, that the route reads neither body nor
 * query, and that the response is a three-value enum carrying no DSR value.
 * A behavioural test cannot show the absence of a body read; this can.
 */

const ROUTE = "app/api/internal/trust-safety/observe/route.ts";
const source = readFileSync(ROUTE, "utf8");
const code = source
  .split("\n")
  .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
  .join("\n");

test("POST only", () => {
  assert.match(code, /export async function POST\(/);
  for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    assert.doesNotMatch(code, new RegExp(`export (async )?function ${method}\\b`), method);
  }
});

test("the request's body and query are never read", () => {
  // §4 states this as a property of the design: no value from the request may
  // choose what is judged, what it is judged about, or what is reported.
  for (const banned of [
    /request\.json\(/,
    /request\.text\(/,
    /request\.body/,
    /request\.formData\(/,
    /new URL\(/,
    /searchParams/,
    /nextUrl/,
  ]) {
    assert.doesNotMatch(code, banned, `${banned} must not appear`);
  }
  // The one thing read from the request.
  assert.match(code, /request\.headers\.get\("authorization"\)/);
});

test("authentication is a 32-character secret compared as digests in constant time", () => {
  assert.match(code, /process\.env\.TRUST_SAFETY_OBSERVER_SECRET/);
  assert.match(code, /secret\.length < 32/);
  assert.match(code, /startsWith\("Bearer "\)/);
  // Both sides hashed, then compared in constant time. Comparing the strings,
  // or hashing one side only, is the mistake this asserts against.
  const digests = code.match(/createHash\("sha256"\)/g) ?? [];
  assert.equal(digests.length, 2, "both sides are digested");
  assert.match(code, /timingSafeEqual\(/);
  assert.doesNotMatch(code, /provided === |=== secret|secret ===/);
  // Not the maintenance secret as a fallback: this route reads personal data.
  assert.doesNotMatch(code, /MAINTENANCE_SECRET/);
});

test("a refusal is 401 and no-store", () => {
  assert.match(code, /json\(\{ error: "unauthorized" \}, 401\)/);
  assert.match(code, /"Cache-Control": "no-store"/);
});

test("the response carries the closed enum and nothing else", () => {
  // §4: no DSR value and no count. The only keys the route puts in a body.
  const keys = new Set((code.match(/\{ (outcome|error): /g) ?? []).map((m) => m.trim()));
  assert.deepEqual([...keys].sort(), ['{ error:', '{ outcome:'].sort());
  assert.match(code, /outcome: result\.outcome/);
  for (const banned of [/overdue/, /imminent/, /legalHold/, /dueAt/, /count/, /requestId/]) {
    assert.doesNotMatch(code, banned, `${banned} must not reach a response`);
  }
});

test("the ping URL is neither read nor logged here", () => {
  // §4: the URL lives in the main app variable and appears in no log, no
  // manifest and no response. The round passes `process.env` through; this
  // file never names the variable.
  assert.doesNotMatch(source, /TRUST_SAFETY_OBSERVER_PING_URL/);
  // The log line is the outcome, the mode, the fault and the ping's result.
  const logged = code.match(/event: "trust_safety_observation"[\s\S]*?\}\)/);
  assert.ok(logged, "the success log line exists");
  assert.doesNotMatch(logged[0], /url|secret|authorization/i);
});

test("a thrown round logs a code-shaped code and no message", () => {
  // A message could carry the query, the URL or a request id; the name and a
  // constrained code cannot.
  assert.match(code, /errorName: error instanceof Error \? error\.name : "unknown"/);
  assert.match(code, /\^\[A-Za-z0-9_\]\{1,64\}\$/);
  assert.doesNotMatch(code, /error\.message|String\(error\)|errorMessage/);
  assert.match(code, /json\(\{ outcome: "failed" \}, 500\)/);
});

test("the route holds no judgement of its own", () => {
  // §5.6 counts writes from the route inward. The route authenticates and
  // answers; the round is where the three transactions are.
  assert.doesNotMatch(code, /\bprisma\b/);
  assert.doesNotMatch(code, /\$queryRaw|\$executeRaw/);
  assert.doesNotMatch(code, /\bfetch\s*\(/);
  assert.match(code, /runTrustSafetyObservation\(\{ env: process\.env \}\)/);
});
