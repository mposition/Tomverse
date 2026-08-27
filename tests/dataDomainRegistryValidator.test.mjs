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

// "This table relates to User" answers nothing on its own.
test("a row that does not say whose data its user link is is rejected", () => {
  const { code, output } = run((_registry, find) => {
    delete find("adminNote").userLinkageRole;
  });
  assert.equal(code, 1);
  assert.match(output, /userLinkageRole "undefined" must be one of/);
});

// The linkage no derivation over the schema can see: an untyped
// targetType/targetId pair with no foreign key. Nothing happens by default, so
// "nothing" has to be written down as a decision.
test("an actor row without a subject reference is rejected", () => {
  const { code, output } = run((_registry, find) => {
    delete find("adminAuditLog").subjectReference;
  });
  assert.equal(code, 1);
  assert.match(output, /needs a subjectReference/);
});

test("an untyped subject reference must say what deletion does to it", () => {
  const { code, output } = run((_registry, find) => {
    delete find("adminNote").subjectReference.deletionAction;
  });
  assert.equal(code, 1);
  assert.match(output, /nothing happens by default and 'nothing' has to be a decision/);
});

test("a subject reference naming a column that does not exist is rejected", () => {
  const { code, output } = run((_registry, find) => {
    find("adminNote").subjectReference.targetIdColumn = "notAColumn";
  });
  assert.equal(code, 1);
  assert.match(output, /names "notAColumn", which is not a column/);
});

test("a retained subject reference needs the same retention block as any retention", () => {
  const { code, output } = run((_registry, find) => {
    delete find("adminAuditLog").subjectReference.retention.legalBasis;
  });
  assert.equal(code, 1);
  assert.match(output, /subjectReference\.retention\.legalBasis is missing/);
});

test("a subject row cannot carry a subject reference", () => {
  const { code, output } = run((_registry, find) => {
    find("memoryItem").subjectReference = { kind: "none" };
  });
  assert.equal(code, 1);
  assert.match(output, /subjectReference only applies to an "actor" row/);
});

// The rule that caught three tables keeping an operator's address after that
// operator deleted their own account.
test("an anonymisation that leaves any email column behind is rejected", () => {
  const { code, output } = run((_registry, find) => {
    const row = find("adminNote");
    row.anonymisationFields = row.anonymisationFields.filter((f) => f !== "createdByEmail");
  });
  assert.equal(code, 1);
  assert.match(output, /omits "createdByEmail", which still names the person/);
});

// --- schemaVersion 4: an actor row that points at a registered parent --------

test("a parent_row reference needs a column the model actually has", () => {
    const { code, output } = run((_registry, find) => {
        find("feedbackLifecycleEvent").subjectReference.parentColumn = "notAColumn";
    });
    assert.equal(code, 1);
    assert.match(output, /parentColumn names "notAColumn", which is not a column/);
});

test("a parent_row reference needs the parent named", () => {
    const { code, output } = run((_registry, find) => {
        delete find("refundRequestTimelineEvent").subjectReference.parentModel;
    });
    assert.equal(code, 1);
    assert.match(output, /subjectReference\.parentModel is missing/);
});

// What makes parent_row worth more than a note. The other two kinds are prose
// the validator takes on trust; this one resolves to a row that is itself
// graded, so the subject cannot be reached through a table nothing checks.
test("a parent_row reference cannot point at an unregistered table", () => {
    const { code, output } = run((registry, find) => {
        find("feedbackLifecycleEvent").subjectReference.parentModel = "Feedback";
        registry.domains = registry.domains.filter((row) => row.domain !== "feedback");
    });
    assert.equal(code, 1);
    assert.match(output, /parentModel "Feedback" is not in the registry/);
});

test("a table with a user id column and no relation cannot escape the sweep", () => {
    // The escape itself. Both of these carry actorUserId and no User relation,
    // so the old relation-shaped sweep graded neither -- and the only record
    // that they held anyone's data was a sentence on somebody else's row.
    for (const domain of ["feedbackLifecycleEvent", "refundRequestTimelineEvent"]) {
        const { code, output } = run((registry) => {
            registry.domains = registry.domains.filter((row) => row.domain !== domain);
        });
        assert.equal(code, 1, `removing ${domain} should fail the sweep`);
        assert.match(output, /holds user data but is not in the registry/);
    }
});

test("an unverified deletion path must be unverified on both axes", () => {
    // Kept honest: a row whose deletion nobody has traced cannot have a known
    // retention. Half-answering would let the pair read as a decision.
    const { code, output } = run((_registry, find) => {
        find("feedbackLifecycleEvent").retentionPolicy = "immediate";
    });
    assert.equal(code, 1);
    assert.match(output, /must both be "unverified" or neither/);
});
