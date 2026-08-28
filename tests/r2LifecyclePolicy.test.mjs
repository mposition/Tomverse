import assert from "node:assert/strict";
import test from "node:test";

import {
  EPHEMERAL_OBJECT_PREFIXES,
  PROTECTED_OBJECT_PREFIXES,
  auditLifecycleConfiguration,
  describeLifecycleAudit,
  prefixesOverlap,
  ruleDeletesObjects,
  rulePrefixes,
} from "../scripts/check-r2-lifecycle-policy-core.mjs";
import { ATTACHMENT_OBJECT_PREFIX } from "../lib/messageAttachmentStorage.ts";
import { ARTIFACT_OBJECT_PREFIX } from "../lib/generatedArtifactStorage.ts";
import { IMAGE_ASSET_KEY_PREFIX } from "../lib/imageGenerationStateCore.ts";
import { ASSISTANT_KNOWLEDGE_KEY_PREFIX } from "../lib/assistantKnowledgeLimits.ts";
import { GUEST_ATTACHMENT_PREFIX } from "../lib/guestAttachments.ts";

const rule = (overrides) => ({ ID: "r", Status: "Enabled", Expiration: { Days: 1 }, ...overrides });

test("the protected list is the application's own prefixes", () => {
  // Listed by hand in the script (it must load without TypeScript), so drift
  // is caught here rather than by a bucket quietly expiring something new.
  assert.deepEqual(
    [...PROTECTED_OBJECT_PREFIXES].sort(),
    [
      ATTACHMENT_OBJECT_PREFIX,
      ARTIFACT_OBJECT_PREFIX,
      IMAGE_ASSET_KEY_PREFIX,
      ASSISTANT_KNOWLEDGE_KEY_PREFIX,
    ].sort()
  );
  assert.deepEqual([...EPHEMERAL_OBJECT_PREFIXES], [GUEST_ATTACHMENT_PREFIX]);
});

/*
  The rule that caused the incident.

  A one-day expiration with no prefix. It reads, in a console, as a rule about
  "temporary uploads"; it is a rule about the entire bucket, and it deleted a
  signed-in user's attachment while the row naming it stayed.
*/
test("an empty prefix is detected as covering everything", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [rule({ ID: "expire-temp-uploads", Prefix: "" })],
  });
  assert.equal(audit.ok, false);
  assert.equal(audit.violations.length, 1);
  assert.equal(audit.violations[0].wholeBucket, true);
  assert.equal(audit.violations[0].expirationDays, 1);
  assert.equal(
    audit.violations[0].overlaps.length,
    PROTECTED_OBJECT_PREFIXES.length
  );
});

test("a rule with no prefix at all is the same as an empty one", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [{ ID: "no-filter", Status: "Enabled", Expiration: { Days: 30 } }],
  });
  assert.equal(audit.ok, false);
  assert.equal(audit.violations[0].wholeBucket, true);
});

test("a parent prefix of attachments/ is detected", () => {
  for (const prefix of ["a", "att", "attach", "attachments"]) {
    const audit = auditLifecycleConfiguration({ Rules: [rule({ Prefix: prefix })] });
    assert.equal(audit.ok, false, prefix);
  }
});

test("a prefix inside attachments/ is detected too", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [rule({ Filter: { Prefix: "attachments/9f2caa0b/" } })],
  });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.violations[0].overlaps, [
    { rulePrefix: "attachments/9f2caa0b/", protectedPrefix: "attachments/" },
  ]);
});

test("a guest-only rule is allowed", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [rule({ ID: "guest-ttl", Filter: { Prefix: "guest-attachments/" } })],
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.allowed, [
    { id: "guest-ttl", prefixes: ["guest-attachments/"] },
  ]);
});

test("a disabled rule is not a live risk", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [rule({ ID: "old", Status: "Disabled", Prefix: "" })],
  });
  assert.equal(audit.ok, true);
});

test("an abort-multipart-only rule deletes no completed object", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [
      {
        ID: "abort-stale-multipart",
        Status: "Enabled",
        Prefix: "",
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
      },
    ],
  });
  assert.equal(audit.ok, true);
  assert.equal(
    ruleDeletesObjects({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
    false
  );
});

test("noncurrent version expiry still counts as deletion", () => {
  const audit = auditLifecycleConfiguration({
    Rules: [
      {
        ID: "versions",
        Status: "Enabled",
        Filter: { Prefix: "images/" },
        NoncurrentVersionExpiration: { NoncurrentDays: 7 },
      },
    ],
  });
  assert.equal(audit.ok, false);
});

test("Filter.And prefixes are read, not skipped", () => {
  assert.deepEqual(
    rulePrefixes({ Filter: { And: { Prefix: "attachments/", Tags: [] } } }),
    ["attachments/"]
  );
  assert.deepEqual(rulePrefixes({}), [""]);
});

test("prefixesOverlap answers in both directions", () => {
  assert.equal(prefixesOverlap("", "attachments/"), true);
  assert.equal(prefixesOverlap("attach", "attachments/"), true);
  assert.equal(prefixesOverlap("attachments/abc/", "attachments/"), true);
  assert.equal(prefixesOverlap("guest-attachments/", "attachments/"), false);
  // Character prefixes, exactly as S3 matches them -- not path segments.
  assert.equal(prefixesOverlap("images", "images/"), true);
});

test("the report names rules and prefixes, never keys", () => {
  const lines = describeLifecycleAudit(
    auditLifecycleConfiguration({ Rules: [rule({ ID: "expire-all", Prefix: "" })] })
  ).join("\n");
  assert.ok(lines.includes("expire-all"));
  assert.ok(!/[0-9a-f]{20}/.test(lines));
});
