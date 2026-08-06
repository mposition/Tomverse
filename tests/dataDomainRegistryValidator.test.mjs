import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse, stringify } from "yaml";

// A validator nobody has watched fail is a validator nobody knows works. Each
// case below takes the real registry, breaks exactly one thing, and requires
// the script to reject it -- so the guarantees the registry claims are
// themselves tested, not just asserted in its comments.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repoRoot, "scripts", "check-data-domain-registry.mjs");
const REGISTRY = path.join(
  repoRoot,
  "docs",
  "policy",
  "tomverse-chat-data-domain-registry.yaml"
);

const baseline = parse(readFileSync(REGISTRY, "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "tvc-registry-"));
let fixtureCount = 0;

const run = (mutate) => {
  const registry = structuredClone(baseline);
  mutate(registry, (domain) => registry.domains.find((row) => row.domain === domain));
  const fixture = path.join(scratch, `registry-${(fixtureCount += 1)}.yaml`);
  writeFileSync(fixture, stringify(registry));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, fixture],
    { cwd: repoRoot, encoding: "utf8" }
  );
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
};

test("the registry as committed passes", () => {
  const { code, output } = run(() => {});
  assert.equal(code, 0, output);
});

test("a cascade claim the schema does not support is rejected", () => {
  const { code, output } = run((_registry, find) => {
    // BillingTransaction is onDelete: SetNull, so it is genuinely not reachable.
    const row = find("billingTransaction");
    row.deletionAction = "delete";
    row.deletionMechanism = "cascade_from_user";
    row.retentionPolicy = "immediate";
    delete row.retention;
  });
  assert.equal(code, 1);
  assert.match(output, /does not reach it from User through cascading relations/);
});

// The user's objection to a one-axis model, made checkable: clearing userId is
// not anonymisation while another column still names the same person.
test("an anonymisation that leaves a direct identifier behind is rejected", () => {
  const { code, output } = run((_registry, find) => {
    const row = find("chatCreditReservation");
    row.anonymisationFields = row.anonymisationFields.filter((field) => field !== "subjectKey");
    delete row.anonymisationReplacements.subjectKey;
  });
  assert.equal(code, 1);
  assert.match(output, /omits "subjectKey", which still names the person/);
});

test("an anonymisation naming a column that does not exist is rejected", () => {
  const { code, output } = run((_registry, find) => {
    find("feedback").anonymisationFields.push("notAColumn");
  });
  assert.equal(code, 1);
  assert.match(output, /names "notAColumn", which is not a column on the model/);
});

test("a non-nullable column cannot be anonymised by omission", () => {
  const { code, output } = run((_registry, find) => {
    delete find("chatLimitDecisionEvent").anonymisationReplacements.subjectKey;
  });
  assert.equal(code, 1);
  assert.match(output, /is not nullable, so anonymising it cannot mean setting NULL/);
});

test("a unique column cannot take a shared replacement", () => {
  const { code, output } = run((_registry, find) => {
    find("imageCreditReservation").anonymisationReplacements.generationId = "anonymised";
  });
  assert.equal(code, 1);
  assert.match(output, /is unique, so every anonymised row would collide/);
});

test("an implemented anonymisation without a re-identification review is rejected", () => {
  const { code, output } = run((_registry, find) => {
    delete find("refundRequest").reidentificationReview;
  });
  assert.equal(code, 1);
  assert.match(output, /needs a reidentificationReview/);
});

test("a review that names no join risks is rejected", () => {
  const { code, output } = run((_registry, find) => {
    find("feedback").reidentificationReview.joinRisksConsidered = [];
  });
  assert.equal(code, 1);
  assert.match(output, /needs joinRisksConsidered/);
});

test("retention without a legal basis, period, owner or review date is rejected", () => {
  for (const field of [
    "retentionPolicyRef",
    "legalBasis",
    "retentionStartsFrom",
    "retentionPeriod",
    "owner",
    "legalHoldOverridesPurge",
    "nextReviewAt",
  ]) {
    const { code, output } = run((_registry, find) => {
      delete find("billingTransaction").retention[field];
    });
    assert.equal(code, 1, `${field} was accepted as missing`);
    assert.match(output, new RegExp(`retention\\.${field} is missing`));
  }
});

test("a retained row cannot claim immediate retention", () => {
  const { code, output } = run((_registry, find) => {
    const row = find("privacyRequest");
    row.retentionPolicy = "immediate";
    delete row.retention;
  });
  assert.equal(code, 1);
  assert.match(output, /cannot have an "immediate" retention policy/);
});

test("a ttl policy without a period is rejected", () => {
  const { code, output } = run((_registry, find) => {
    delete find("chatLimitDecisionEvent").ttlDays;
  });
  assert.equal(code, 1);
  assert.match(output, /needs a positive integer ttlDays/);
});

// Nothing is `planned` in the committed registry any more, so these two build
// the state rather than borrowing a row that happens to be in it. The state is
// still the honest one for the next decided-but-unbuilt deletion path, and it
// stays graded whether or not anything currently occupies it.
test("a planned row without a work reference is rejected", () => {
  const { code, output } = run((_registry, find) => {
    find("comparisonReview").implementationStatus = "planned";
  });
  assert.equal(code, 1);
  assert.match(output, /needs a plannedWorkRef/);
});

test("a planned row with a work reference is accepted", () => {
  const { code, output } = run((_registry, find) => {
    const row = find("comparisonReview");
    row.implementationStatus = "planned";
    row.plannedWorkRef = "PRIVACY-01: trace the comparison review deletion path";
  });
  assert.equal(code, 0, output);
  assert.match(output, /1 domain\(s\) are decided but not yet built/);
});

test("an implemented row cannot carry a work reference", () => {
  const { code, output } = run((_registry, find) => {
    find("comparisonReview").plannedWorkRef = "PRIVACY-01: something already done";
  });
  assert.equal(code, 1);
  assert.match(output, /plannedWorkRef only applies to a planned row/);
});

// The promise the registry exists to keep.
test("a user-linked model missing from the registry is rejected", () => {
  const { code, output } = run((registry) => {
    registry.domains = registry.domains.filter((row) => row.domain !== "memoryItem");
  });
  assert.equal(code, 1);
  assert.match(output, /MemoryItem holds user data but is not in the registry/);
});

test("a registry that disagrees with the export declarations is rejected", () => {
  const { code, output } = run((_registry, find) => {
    find("account").inUnifiedExport = "excluded";
  });
  assert.equal(code, 1);
  assert.match(output, /The registry must describe the export that exists/);
});

test("a one-axis schemaVersion is refused rather than half-read", () => {
  const { code, output } = run((registry) => {
    registry.schemaVersion = 1;
  });
  assert.equal(code, 1);
  assert.match(output, /unsupported schemaVersion 1/);
});
