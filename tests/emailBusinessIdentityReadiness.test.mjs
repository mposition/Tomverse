import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BLOCK_ENV_VARIABLE,
  JURISDICTION_IDENTITY_BLOCKS,
  UNIVERSAL_IDENTITY_BLOCKS,
  businessIdentityProblems,
  businessIdentityReadiness,
} from "../lib/emailBusinessIdentity.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";

// Whether the footer can say who sent the message.
// Contract: docs/policy/email-notifications.md §5.2 E3, §8.5.

const COMPLETE = {
  EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
  EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
  EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
  EMAIL_BUSINESS_REGISTRATION_NUMBER: "000-00-00000",
  EMAIL_BUSINESS_MAIL_ORDER_REGISTRATION_NUMBER: "2026-Seoul-00000",
  EMAIL_BUSINESS_ABN: "00 000 000 000",
};

const codes = (env) => businessIdentityProblems(env).map((problem) => problem.code);

/** COMPLETE with one variable removed. */
const without = (variable) => {
  const env = { ...COMPLETE };
  delete env[variable];
  return env;
};

test("the block lists match the profiles that actually name them", () => {
  // Read off the seed rather than restated from the runbook. A hand-written
  // second copy of this mapping is what the module exists to avoid, and a
  // profile that gains a block would otherwise go unreported.
  const universal = new Set(UNIVERSAL_IDENTITY_BLOCKS);
  const identityBlocks = new Set([
    ...UNIVERSAL_IDENTITY_BLOCKS,
    ...Object.values(JURISDICTION_IDENTITY_BLOCKS).flat(),
  ]);

  for (const profile of JURISDICTION_PROFILE_SEED) {
    const named = profile.footerBlocks.filter((block) => identityBlocks.has(block));
    // Every profile names all three universal blocks.
    for (const block of universal) {
      assert.ok(
        profile.footerBlocks.includes(block),
        `${profile.profileKey} does not name ${block}, so it is not universal`
      );
    }
    // Anything else it names is claimed by that profile's own list.
    const extra = named.filter((block) => !universal.has(block));
    assert.deepEqual(
      [...extra].sort(),
      [...(JURISDICTION_IDENTITY_BLOCKS[profile.profileKey] ?? [])].sort(),
      `${profile.profileKey}'s jurisdiction blocks`
    );
  }
});

test("a complete identity is no finding", () => {
  assert.deepEqual(businessIdentityProblems(COMPLETE), []);
  assert.equal(businessIdentityReadiness(COMPLETE).ready, true);
});

test("one missing universal value is reported, because it drops the whole footer", () => {
  // The failure this exists for: `renderJurisdictionFooter` returns not-ok when
  // any named block is empty, and the composer then drops the footer entire. So
  // one unset variable removes the business identity from every message, not
  // one line from it.
  const problems = businessIdentityProblems(without("EMAIL_BUSINESS_CONTACT_EMAIL"));
  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["EMAIL_BUSINESS_IDENTITY_INCOMPLETE"]
  );
  assert.deepEqual(problems[0].blocks, ["contact_email"]);
  // The variable, not only the block: an operator told which block is empty
  // still has to work out which variable fills it.
  assert.deepEqual(problems[0].variables, ["EMAIL_BUSINESS_CONTACT_EMAIL"]);
  assert.match(problems[0].message, /whole footer/);
});

test("every missing value is named at once, not one per deploy", () => {
  const problems = businessIdentityProblems({});
  const universal = problems.find(
    (problem) => problem.code === "EMAIL_BUSINESS_IDENTITY_INCOMPLETE"
  );
  assert.deepEqual(universal.blocks, [...UNIVERSAL_IDENTITY_BLOCKS]);
  assert.deepEqual(
    universal.variables,
    UNIVERSAL_IDENTITY_BLOCKS.map((block) => BLOCK_ENV_VARIABLE[block])
  );
});

test("a jurisdiction value is its own finding and stays a warning", () => {
  // A missing `abn` drops the footer only for a recipient who resolves to AU,
  // and this function reads an environment rather than a recipient list. Folding
  // it into the universal finding would overstate it.
  const withoutAbn = without("EMAIL_BUSINESS_ABN");
  const problems = businessIdentityProblems(withoutAbn);
  assert.deepEqual(
    problems.map((problem) => problem.code),
    ["EMAIL_BUSINESS_IDENTITY_JURISDICTION_INCOMPLETE"]
  );
  assert.equal(problems[0].severity, "warning");
  assert.match(problems[0].message, /AU/);
  // And it does not sink readiness even with marketing on: whether this
  // deployment has AU recipients is not a fact the environment holds.
  assert.equal(
    businessIdentityReadiness({
      ...withoutAbn,
      MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
    }).ready,
    true
  );
});

test("today's deployment is a warning, not a refusal", () => {
  // Transactional mail is deliberately not held for this -- an account-deletion
  // notice is the message least able to wait for an environment variable -- so
  // gating readiness here would refuse production to announce a gap that has
  // been there since the footer shipped.
  const readiness = businessIdentityReadiness({});
  assert.equal(readiness.ready, true);
  assert.equal(readiness.required, false);
  assert.equal(readiness.errors.length, 0);
  assert.ok(readiness.warnings.length > 0, "an unset identity must still be said");
});

test("it becomes an error the moment marketing has a sending identity", () => {
  // From then on an incomplete identity means every marketing send is refused
  // for having no footer, while /api/ready answers yes -- the state EM-10
  // describes for the unsubscribe keyring.
  const readiness = businessIdentityReadiness({
    MARKETING_EMAIL_FROM: "Tomverse <news@news.tomverse.app>",
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.errors.map((problem) => problem.code),
    ["EMAIL_BUSINESS_IDENTITY_INCOMPLETE"]
  );
  assert.match(readiness.errors[0].message, /refused/);
});

test("blank is not configured", () => {
  assert.deepEqual(
    codes({ ...COMPLETE, EMAIL_BUSINESS_LEGAL_NAME: "   " }),
    ["EMAIL_BUSINESS_IDENTITY_INCOMPLETE"]
  );
});
