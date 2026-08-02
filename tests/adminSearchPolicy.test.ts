import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ADMIN_SEARCH_FIELDS,
  ADMIN_SEARCH_FORBIDDEN_FIELDS,
  adminSearchWhere,
  hashAdminSearchQuery,
  type AdminSearchRecord,
} from "../lib/adminSearchPolicy.ts";

/**
 * SEC-008. The administrator global search matched `contains` against
 * `Message.content` and `Conversation.title`. Neither is rendered anywhere in
 * the admin console, so matching them was never a way to *find* a record -- it
 * was a substring oracle over every user's private conversations, usable one
 * guess at a time, leaving no trace.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepoCode = (relativePath: string) =>
  readFileSync(join(repoRoot, relativePath), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("the search policy excludes private conversation content", () => {
  for (const [record, forbidden] of Object.entries(
    ADMIN_SEARCH_FORBIDDEN_FIELDS
  )) {
    const allowed = ADMIN_SEARCH_FIELDS[record as AdminSearchRecord];
    for (const field of forbidden!) {
      assert.ok(
        !allowed.includes(field),
        `${record}.${field} must never be searchable`
      );
    }
  }
  assert.ok(!ADMIN_SEARCH_FIELDS.message.includes("content"));
  assert.ok(!ADMIN_SEARCH_FIELDS.conversation.includes("title"));
});

test("conversations and messages stay findable by identifier", () => {
  // Removing the oracle must not remove the ability to look a record up, which
  // is what the console actually links to.
  assert.ok(ADMIN_SEARCH_FIELDS.message.includes("id"));
  assert.ok(ADMIN_SEARCH_FIELDS.conversation.includes("id"));
  assert.ok(ADMIN_SEARCH_FIELDS.conversation.includes("shareToken"));
});

test("operator-directed text stays searchable", () => {
  // Feedback bodies and refund reasons are text the user deliberately sent to
  // support, and the console renders both in full. Excluding them would break
  // real support work without protecting anything.
  assert.ok(ADMIN_SEARCH_FIELDS.feedback.includes("message"));
  assert.ok(ADMIN_SEARCH_FIELDS.refundRequest.includes("reason"));
});

test("the route builds its query from the policy, not from its own field list", () => {
  const source = readRepoCode("app/api/admin/search/route.ts");
  // A `contains` written inline in the route would sit outside the policy and
  // outside the assertions above.
  assert.ok(
    !source.includes("contains:"),
    "the route must not spell out its own contains clauses"
  );
  assert.match(source, /adminSearchWhere\(/);
  for (const field of ["content", "title"]) {
    assert.ok(
      !new RegExp(`\\b${field}: \\{`).test(source),
      `${field} must not be reintroduced in the route`
    );
  }
});

test("every search is written to the admin audit trail", () => {
  const source = readRepoCode("app/api/admin/search/route.ts");
  assert.match(source, /writeAdminAuditLog\(/);
  assert.match(source, /action: "admin\.search"/);
  // The audit row must not become a transcript of what was searched for.
  assert.ok(
    !/summary: `[^`]*\$\{query\}/.test(source),
    "the raw query must not be written into the audit summary"
  );
  assert.match(source, /queryDigest: hashAdminSearchQuery\(/);

  // The metadata object may mention `query` only as the argument being hashed.
  const metadata = source.slice(
    source.indexOf("metadata: {", source.indexOf("admin.search"))
  );
  const metadataBlock = metadata.slice(0, metadata.indexOf("});"));
  const withoutHashCall = metadataBlock
    .replace(/hashAdminSearchQuery\(\s*query\s*,/g, "hashAdminSearchQuery(")
    // The length is a count, not the term.
    .replace(/query\.length/g, "0");
  assert.ok(
    !/\bquery\b/.test(withoutHashCall),
    "the raw query must not be written into the audit metadata"
  );
  assert.match(metadataBlock, /queryLength: query\.length/);
});

test("adminSearchWhere covers exactly the policy fields", () => {
  const where = adminSearchWhere("user", "acme");
  assert.deepEqual(
    where.OR.map((clause) => Object.keys(clause)[0]),
    [...ADMIN_SEARCH_FIELDS.user]
  );
  for (const clause of where.OR) {
    assert.deepEqual(Object.values(clause)[0], {
      contains: "acme",
      mode: "insensitive",
    });
  }
});

test("the query digest is stable, case-folded, keyed, and not the query", () => {
  const secret = "audit-integrity-secret";
  const digest = hashAdminSearchQuery("Confidential", secret);

  assert.equal(hashAdminSearchQuery("Confidential", secret), digest);
  assert.equal(
    hashAdminSearchQuery("confidential", secret),
    digest,
    "the same search typed with different case must collapse to one digest"
  );
  assert.notEqual(hashAdminSearchQuery("confidentia", secret), digest);
  assert.notEqual(
    hashAdminSearchQuery("Confidential", "another-secret"),
    digest,
    "the digest must be keyed, or a dictionary of likely terms reverses it"
  );
  assert.ok(!digest.toLowerCase().includes("confidential"));
  assert.match(digest, /^[A-Za-z0-9_-]{22}$/);
});
