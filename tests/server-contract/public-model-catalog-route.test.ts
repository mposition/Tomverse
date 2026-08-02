import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NON_PUBLIC_MODEL_FIELDS } from "../../lib/publicModelCatalog";

// Route-level contract for /api/models/catalog, asserted against the source
// rather than by booting the handler: the handler needs a database, and what
// is worth pinning here is structural anyway.
//
// The endpoint published Tomverse's cost basis -- input/output USD per million
// tokens, the cached-input multiplier, reservation sizing -- for every model,
// to anyone, because it built its body by spreading the registry row and
// deleting three fields. Anything added to the row afterwards was public by
// default.

const readSource = (...segments: string[]) =>
  readFileSync(join(import.meta.dirname, "..", "..", ...segments), "utf8");

const catalogRoute = readSource("app", "api", "models", "catalog", "route.ts");
const adminRoute = readSource("app", "api", "admin", "models", "route.ts");

test("the public catalogue stays reachable without a session", () => {
  // Deliberately unauthenticated: guests pick models before signing in, and a
  // shared conversation is read by people with no account. Adding a session
  // check here would break both surfaces -- and would not have fixed the
  // disclosure, since signed-in users should not see a cost basis either.
  assert.doesNotMatch(
    catalogRoute,
    /getServerSession|isAdminSession|requireAdmin|auth\(\)/,
    "this route must not gain a session check; minimise the body instead"
  );
  assert.match(catalogRoute, /export async function GET/);
  assert.doesNotMatch(
    catalogRoute,
    /status:\s*401|status:\s*403/,
    "an unauthenticated request must still be answered"
  );
});

test("the response body is an allowlist, not the registry row minus a few fields", () => {
  assert.match(catalogRoute, /toPublicCatalogModel/);
  assert.doesNotMatch(
    catalogRoute,
    /\.\.\.model\b/,
    "spreading the registry row makes every future field public by default"
  );
  assert.doesNotMatch(catalogRoute, /\bdelete\s+\w+\./);
});

test("no internal cost or operational field is named anywhere in the route", () => {
  assert.ok(
    NON_PUBLIC_MODEL_FIELDS.length > 0,
    "an empty list would make this pass vacuously"
  );
  for (const field of NON_PUBLIC_MODEL_FIELDS) {
    assert.equal(
      new RegExp(`\\b${field}\\s*[:.]`).test(catalogRoute),
      false,
      `${field} must not be assembled into the public body`
    );
  }
});

test("administrators still get the complete row, and only administrators", () => {
  // The capability is not removed, it is moved behind a session. If this ever
  // stops being gated, the same disclosure returns through another door.
  assert.match(adminRoute, /isAdminSession/);
  assert.match(
    adminRoute,
    /\.\.\.model\b/,
    "the admin registry view is the one that legitimately carries every field"
  );
});

test("the public catalogue does not advertise itself as cacheable by a shared cache", () => {
  // Not access control -- the allowlist is -- but a public cache directive on
  // a per-deployment registry response would be wrong regardless.
  assert.match(catalogRoute, /Cache-Control/);
  assert.doesNotMatch(catalogRoute, /"public,/);
});
