import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const route = readFileSync(new URL("../app/api/admin/amux/ideas/collection-requests/route.ts",
  import.meta.url), "utf8");
const service = readFileSync(new URL("../lib/amux/ideaCollectionRequestService.ts",
  import.meta.url), "utf8");

test("dark collection request route requires owner step-up, origin and bounded input", () => {
  assert.match(route, /getAdminRole\(session\) !== "owner"/);
  assert.match(route, /assertRecentAdminAuthentication\(session\)/);
  assert.match(route, /hasValidMutationOrigin\(request\)/);
  assert.match(route, /consumeApiRateLimit\(request, session\.user!\.id!/);
  assert.match(route, /readLimitedText\(request, AMUX_V4_COLLECTION_REQUEST_MAX_BYTES\)/);
  assert.match(route, /"Cache-Control": "private, no-store, max-age=0"/);
  assert.match(service, /AMUX_V4_COLLECTION_REQUEST_WRITE_CODE_LATCH = false/);
  assert.match(service, /AMUX_V4_COLLECTION_REQUEST_READ_CODE_LATCH = false/);
});

test("collection route distinguishes 404, 409 and 503 and never retries unknown writes", () => {
  assert.match(route, /error\.code === "not_found" \? 404/);
  assert.match(route, /error\.code === "not_ready" \|\| error\.code === "request_exists" \? 409 : 503/);
  assert.match(route, /error\.code === "outcome_unknown"/);
  assert.match(route, /retryWrite: false/);
  assert.match(route, /requestId: inspected\.request\.requestId, readBack: error\.readBack/);
  assert.match(route, /return NextResponse\.json\(await readAmuxIdeaCollectionRequest\(session, requestId\)/);
  assert.match(service, /readAmuxIdeaCollectionRequest\(input\.session,[\s\S]*?input\.choice\.requestId\)/);
});
