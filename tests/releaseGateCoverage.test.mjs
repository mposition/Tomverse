import { strict as assert } from "node:assert";
import test from "node:test";

import {
  auditReleaseGateCoverage,
  MANUALLY_GATED_CHECKS,
  NOT_A_GATE,
  scriptMentions,
} from "../scripts/check-release-gate-coverage-core.mjs";

/**
 * The guard that keeps §1 of the release checklist and CI describing the same
 * gate.
 *
 * It exists because they silently stopped: the repository grew to twelve
 * CI-enforced `check:`/`verify:` scripts while the checklist named five.
 * Nothing failed, which is what made it worth catching -- a release manager
 * reading the checklist would have believed they had run the gate.
 */

const audit = (input) =>
  auditReleaseGateCoverage({
    packageScripts: [
      "check:accent-tokens",
      "check:model-pricing",
      ...Object.keys(MANUALLY_GATED_CHECKS),
    ],
    ciMentions: new Set(),
    checklistMentions: new Set(Object.keys(MANUALLY_GATED_CHECKS)),
    ...input,
  });

test("a CI-enforced check missing from the checklist is an error", () => {
  const { errors } = audit({
    ciMentions: new Set(["check:accent-tokens"]),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /check:accent-tokens/);
  assert.match(errors[0], /not named in the release checklist/);
});

test("a checklist step naming a script that does not exist is an error", () => {
  // The other direction, and the one that quietly trains people to skip
  // steps: a checklist line whose command errors reads as a stale checklist.
  const { errors } = audit({
    checklistMentions: new Set([
      ...Object.keys(MANUALLY_GATED_CHECKS),
      "check:removed-last-quarter",
    ]),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /check:removed-last-quarter/);
  assert.match(errors[0], /not a package script/);
});

test("a check no CI job runs must be carried by the checklist, with a reason", () => {
  // These are the reason this is a curated list rather than "everything in
  // package.json": they need a database or a live credential, so CI cannot
  // run them and the checklist is the only thing that does.
  const { errors } = audit({ checklistMentions: new Set() });
  assert.equal(errors.length, Object.keys(MANUALLY_GATED_CHECKS).length);
  for (const script of Object.keys(MANUALLY_GATED_CHECKS)) {
    assert.ok(errors.some((message) => message.includes(script)));
  }
  // The message carries why, not only that.
  assert.ok(errors.every((message) => message.length > 80));
});

test("a manually gated entry for a deleted script is an error", () => {
  const { errors } = audit({
    packageScripts: ["check:accent-tokens"],
    checklistMentions: new Set(Object.keys(MANUALLY_GATED_CHECKS)),
  });
  assert.ok(
    errors.some((message) => /no longer a package script/.test(message))
  );
});

test("a warning-only variant is not treated as a separate gate", () => {
  // `check:encoding` is the non-strict mode of a check whose strict form the
  // checklist already requires. Demanding both would add a line that means
  // nothing.
  assert.ok("check:encoding" in NOT_A_GATE);
  const { errors } = audit({ ciMentions: new Set(["check:encoding"]) });
  assert.deepEqual(errors, []);
});

test("every not-a-gate entry says why it is not one", () => {
  // The list is small and stays that way only if adding to it costs a
  // sentence. An unexplained exemption is indistinguishable from a check
  // somebody quietly stopped running.
  for (const [script, entry] of Object.entries(NOT_A_GATE)) {
    assert.ok(
      entry?.reason && entry.reason.trim().length > 0,
      `${script} needs a reason it is not a release gate`
    );
  }
});

test("mentions are read out of prose and YAML alike", () => {
  const found = scriptMentions(
    [
      "- [ ] `npm run check:model-pricing`",
      "        run: npm run verify:smoke-coverage",
      "npm run test:unit is not a check: prefix",
    ].join("\n")
  );
  assert.deepEqual(
    [...found].sort(),
    ["check:model-pricing", "verify:smoke-coverage"]
  );
});

test("a clean pairing produces no errors", () => {
  const { errors } = audit({
    ciMentions: new Set(["check:accent-tokens", "check:model-pricing"]),
    checklistMentions: new Set([
      "check:accent-tokens",
      "check:model-pricing",
      ...Object.keys(MANUALLY_GATED_CHECKS),
    ]),
  });
  assert.deepEqual(errors, []);
});
