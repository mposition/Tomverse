import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED,
  sourceScopePreviewPermitted,
} from "../lib/amux/ideaSourceScopePreviewCore.ts";

const source = readFileSync(new URL("../app/api/admin/amux/ideas/source-scope-preview/route.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../lib/amux/ideaSourceScopePreviewService.ts", import.meta.url), "utf8");

test("source scope route requires its dedicated environment gate", () => {
  assert.equal(AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED, true);
  assert.equal(sourceScopePreviewPermitted(undefined), false);
  assert.equal(sourceScopePreviewPermitted("enabled"), true);
  assert.match(source, /sourceScopePreviewPermitted\(process\.env\[AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV\]\)/);
  assert.match(source, /error: "preview_disabled", transferAuthorized: false/);
  assert.doesNotMatch(source, /export async function GET\(/);
});

test("scope preview requires owner and recent authentication before the bounded read", () => {
  assert.match(source, /getServerSession\(authOptions\)/);
  assert.match(source, /getAdminRole\(session\) !== "owner"/);
  assert.match(source, /assertRecentAdminAuthentication\(session\)/);
  assert.match(source, /consumeApiRateLimit\(request, session\.user!\.id!/);
  assert.match(source, /readLimitedText\(request, AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES\)/);
  assert.match(source, /inspectAmuxSourceScopePreviewRequest\(/);
  assert.match(source, /previewAmuxSourceScope\(session, inspected\.request\)/);
  assert.match(source, /"Cache-Control": "private, no-store, max-age=0"/);
  const gateOrder = [
    "await owner()",
    "sourceScopePreviewPermitted(process.env",
    'request.headers.get("content-type")',
    "await consumeApiRateLimit(",
    "await readLimitedText(",
    "await previewAmuxSourceScope(",
  ].map((needle) => source.indexOf(needle, source.indexOf("export async function POST")));
  assert.ok(gateOrder.every((position) => position >= 0));
  assert.deepEqual(gateOrder, [...gateOrder].sort((a, b) => a - b));
});

test("declarative preview cannot grant transfer or call an external collector", () => {
  assert.doesNotMatch(source, /writeAdminAuditLog|writeSystemAuditLog|sourceScopeApproval\.create/);
  assert.doesNotMatch(source, /fetch\(|GitHubRefReadAdapter|claude|codex|spawn\(/i);
  assert.doesNotMatch(service, /\bfetch\s*\(|\bspawn\s*\(|\bexecFile\s*\(/);
  assert.doesNotMatch(service, /\.create\s*\(|\.update\s*\(|\.upsert\s*\(/);
  assert.match(service, /SET TRANSACTION READ ONLY/);
  assert.match(source, /error: "preview_unavailable", transferAuthorized: false/);
});
