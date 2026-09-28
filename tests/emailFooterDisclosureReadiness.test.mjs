import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOOTER_BLOCK_DUTIES,
  FOOTER_DISCLOSURE_COUNTRIES,
  FOOTER_DISCLOSURE_OBLIGATIONS,
  footerBlocksRequired,
} from "../lib/emailFooterDisclosureReadiness.ts";
import {
  JURISDICTION_IDENTITY_BLOCKS,
  UNIVERSAL_IDENTITY_BLOCKS,
  identityBlocksWithoutValue,
} from "../lib/emailBusinessIdentity.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";
import {
  obligationsFor,
  releaseNotesObligationSeed,
} from "../lib/releaseNotesObligationCore.ts";

// The footer blocks a statute requires, and the duties that rest on them.
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7, 7.8.
//
// The readiness function needs a database and is exercised in tests/integration/.
// What is checkable here is the drift this check exists because of: a duty
// recorded as `implemented` against a check that does not consider it.

test("every duty that names this check is one this check answers for", () => {
  const seeded = releaseNotesObligationSeed().filter(
    (row) => row.readinessCheck === "emailFooterDisclosures"
  );
  assert.ok(seeded.length > 0, "nothing rests on this check, so it confirms nothing");
  for (const row of seeded) {
    assert.ok(
      (FOOTER_DISCLOSURE_OBLIGATIONS[row.countryCode] ?? []).includes(row.obligationKey),
      `${row.countryCode}:${row.obligationKey} names this check and this check does not cover it`
    );
  }
});

test("every duty this check claims is one the country actually declares", () => {
  // The other direction: a block list here for a duty no country has is a claim
  // about nothing, and it would make the check fail for a country with no duty.
  for (const countryCode of FOOTER_DISCLOSURE_COUNTRIES) {
    const declared = obligationsFor(countryCode);
    for (const obligationKey of Object.keys(FOOTER_BLOCK_DUTIES[countryCode])) {
      assert.ok(
        declared.includes(obligationKey),
        `${countryCode} declares no duty ${obligationKey}`
      );
    }
    assert.deepEqual(
      [...FOOTER_DISCLOSURE_OBLIGATIONS[countryCode]].sort(),
      Object.keys(FOOTER_BLOCK_DUTIES[countryCode]).sort()
    );
  }
});

test("Korea's duty is the whole statutory footer, telephone number included", () => {
  // The finding this check was made for: 시행령 별표 6 names a telephone number,
  // `businessIdentityProblems()` reports a missing jurisdiction block as a
  // warning on purpose, and the duty settled against a check that stayed ready
  // without one.
  const korea = footerBlocksRequired("KR");
  assert.ok(korea.includes("contact_phone"));
  for (const block of UNIVERSAL_IDENTITY_BLOCKS) assert.ok(korea.includes(block), block);
  for (const block of JURISDICTION_IDENTITY_BLOCKS.KR) assert.ok(korea.includes(block), block);

  // And with no telephone number the blocks are reported as missing -- which is
  // exactly what the general check reports only as a warning.
  assert.deepEqual(
    identityBlocksWithoutValue(
      {
        EMAIL_BUSINESS_LEGAL_NAME: "Tomverse Pty Ltd",
        EMAIL_BUSINESS_POSTAL_ADDRESS: "1 Example Street, Brisbane QLD 4000",
        EMAIL_BUSINESS_CONTACT_EMAIL: "support@tomverse.app",
      },
      korea
    ),
    ["contact_phone"]
  );
});

test("the United States duty is the postal address and not the whole footer", () => {
  // Two duties of different shapes, which is why the map is written out rather
  // than derived from one list: CAN-SPAM asks for a physical address, and
  // reading it as the whole 별표 6 list would refuse American mail over a
  // telephone number no American statute asks for.
  assert.deepEqual(footerBlocksRequired("US"), ["postal_address"]);
});

test("every block a duty names is one the country's seeded profile prints", () => {
  // The second half of the same finding: a value in the environment that the
  // stored row does not name is not in the message. The seed is what a
  // deployment's rows start as, so a block this check requires and the seed does
  // not name would report a correct deployment as incomplete.
  for (const countryCode of FOOTER_DISCLOSURE_COUNTRIES) {
    const profile = JURISDICTION_PROFILE_SEED.find(
      (entry) => entry.profileKey === countryCode
    );
    assert.ok(profile, `${countryCode} has no seeded profile`);
    const named = profile.footerBlocks;
    for (const block of footerBlocksRequired(countryCode)) {
      assert.ok(
        named.includes(block),
        `${countryCode}'s seeded footer does not print ${block}, which its duty requires`
      );
    }
  }
});
