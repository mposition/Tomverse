// Every refusal has a word, and it is the right word.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
//
// The failure this exists for is a blocker added to `SEND_BLOCKERS` that no
// mapping names. With a `??` default it would compile, write a word that was not
// true, and an operator reading the queue would be told somebody had revoked
// something they had never been asked about.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SEND_BLOCKERS } from "../lib/releaseNotesSendVerdictCore.ts";
import {
  NO_BASIS_SKIP_REASON,
  RELEASE_NOTES_SKIP_REASONS,
  releaseNotesSkipReason,
  unmappedBlockers,
  releaseNotesRefusalKey,
} from "../lib/releaseNotesSkipReasonCore.ts";

test("every blocker has a skip reason", () => {
  assert.deepEqual(unmappedBlockers(), []);
});

test("every skip reason this module writes is one the column accepts", () => {
  // The closed list lives in `EmailDelivery_skip_reason_check`. Read from the
  // migration rather than restated here, so a word added to one and not the
  // other is a failure rather than two lists that agree by habit.
  const sql = readMigration();
  const allowed = new Set(
    [...sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  );
  for (const reason of RELEASE_NOTES_SKIP_REASONS) {
    assert.ok(allowed.has(reason), `${reason} is not in the CHECK constraint`);
  }
});

test("an allowed verdict has no reason at all", () => {
  // Null rather than a word: a caller that could ask an allowed verdict for a
  // reason could skip a message the verdict allowed.
  assert.equal(releaseNotesSkipReason({ allowed: true, blockers: [] }), null);
  assert.equal(
    releaseNotesSkipReason({ allowed: true, blockers: ["display_contract_changed"] }),
    null
  );
});

test("a refusal with no blocker is the legal refusal", () => {
  // A send that needs an override and has none: `legalAllowed` is false and
  // nothing was found that could have lifted it, which section 5.6 is deliberate
  // is not the same event as an override that does not cover this person.
  assert.equal(
    releaseNotesSkipReason({ allowed: false, blockers: [] }),
    NO_BASIS_SKIP_REASON
  );
  assert.equal(NO_BASIS_SKIP_REASON, "no_consent");
});

test("each blocker alone maps to its own word", () => {
  const expected = {
    suppressed: "consent_withdrawn",
    objected: "permission_revoked",
    country_undetermined: "jurisdiction_unconfirmed",
    obligation_undecided: "obligation_undecided",
    feature_disabled: "marketing_disabled",
    display_contract_changed: "display_contract_changed",
    display_unsatisfiable: "display_unsatisfiable",
    approval_member_mismatch: "no_consent",
  };
  // Not a subset: the table is checked against the whole blocker list, so a new
  // blocker fails here as well as in `unmappedBlockers()`.
  assert.deepEqual(Object.keys(expected).sort(), [...SEND_BLOCKERS].sort());
  for (const [blocker, reason] of Object.entries(expected)) {
    assert.equal(
      releaseNotesSkipReason({ allowed: false, blockers: [blocker] }),
      reason,
      blocker
    );
  }
});

test("the person's own act outranks anything about the message", () => {
  // Settling the duty would not make this message sendable, so a record naming
  // the duty would read as though settling it were the way to reach this person.
  assert.equal(
    releaseNotesSkipReason({
      allowed: false,
      blockers: ["obligation_undecided", "objected"],
    }),
    "permission_revoked"
  );
  assert.equal(
    releaseNotesSkipReason({
      allowed: false,
      blockers: ["display_contract_changed", "suppressed"],
    }),
    "consent_withdrawn"
  );
});

test("a contract that moved is the reason only when it is the only reason", () => {
  // The same condition `reenqueueIsRight()` applies, arrived at independently:
  // where the contract moved alongside anything else, that other thing is why
  // the message stops, and the row has to say so or a reader would expect a
  // replacement that never comes.
  assert.equal(
    releaseNotesSkipReason({ allowed: false, blockers: ["display_contract_changed"] }),
    "display_contract_changed"
  );
  assert.equal(
    releaseNotesSkipReason({
      allowed: false,
      blockers: ["display_contract_changed", "feature_disabled"],
    }),
    "marketing_disabled"
  );
});

function readMigration() {
  const sql = readFileSync(
    new URL(
      "../prisma/migrations/20260928210000_email_delivery_display_contract/migration.sql",
      import.meta.url
    ),
    "utf8"
  );
  // Only the CHECK constraint, not the whole file. The trigger below it also
  // quotes skip reasons, and a test that read those would pass on a word the
  // column does not accept.
  const start = sql.indexOf(`"EmailDelivery_skip_reason_check"
    CHECK`);
  assert.ok(start > 0, "the skip reason CHECK constraint was not found");
  const end = sql.indexOf("));", start);
  assert.ok(end > start, "the skip reason CHECK constraint does not close");
  return sql.slice(start, end);
}

test("a refusal about the destination is recorded as one", () => {
  // A closed country, or one with no rule, refuses whatever the person said.
  // Recording it as no_consent told an operator the person had not agreed.
  const denied = (reason) => [
    { authority: "recipient", country: "NL", verdict: "deny", reason },
  ];
  assert.equal(
    releaseNotesSkipReason({ allowed: false, blockers: [], authorities: denied("country_closed") }),
    "marketing_country_not_allowed"
  );
  assert.equal(
    releaseNotesSkipReason({ allowed: false, blockers: [], authorities: denied("no_country_rule") }),
    "marketing_country_not_allowed"
  );
  // Even where an override was tried and refused for it.
  assert.equal(
    releaseNotesSkipReason({
      allowed: false,
      blockers: ["approval_member_mismatch"],
      authorities: denied("country_closed"),
    }),
    "marketing_country_not_allowed"
  );
  // The person's own act still comes first.
  assert.equal(
    releaseNotesSkipReason({
      allowed: false,
      blockers: ["objected"],
      authorities: denied("country_closed"),
    }),
    "permission_revoked"
  );
  // And a basis refusal is still no_consent.
  assert.equal(
    releaseNotesSkipReason({ allowed: false, blockers: [], authorities: denied("no_express_consent") }),
    "no_consent"
  );
});

test("an estimate names what refused, and files the switch last", () => {
  // A suppression is a suppression, whatever its cause; the skip reason would
  // have called it a withdrawn consent.
  assert.equal(releaseNotesRefusalKey({ blockers: ["suppressed"] }), "suppressed");
  // A person with no basis is refused for that, switch or no switch.
  assert.equal(
    releaseNotesRefusalKey({
      blockers: ["feature_disabled"],
      authorities: [{ verdict: "deny", reason: "no_express_consent" }],
    }),
    "no_express_consent"
  );
  assert.equal(
    releaseNotesRefusalKey({ blockers: ["feature_disabled", "display_unsatisfiable"] }),
    "display_unsatisfiable"
  );
  assert.equal(releaseNotesRefusalKey({ blockers: ["feature_disabled"] }), "feature_disabled");
  assert.equal(releaseNotesRefusalKey({ blockers: [] }), "no_basis");
});

test("a duty that prints something and whose check fails is an incomplete footer", () => {
  const verdict = (duties) => ({
    allowed: false,
    blockers: ["obligation_undecided"],
    obligations: {
      KR: {
        obligations: duties.map(([obligationKey, reason]) => ({
          obligationKey,
          settled: reason === null,
          reason,
        })),
      },
    },
  });
  const display = { KR: ["body_disclosures", "bilingual_unsubscribe_notice"] };
  // The sender's contact address is missing: every duty was decided, and the
  // footer cannot be printed complete. The ordinary gate's word for that.
  assert.equal(
    releaseNotesSkipReason(
      verdict([
        ["body_disclosures", "readiness_check_failing"],
        ["biennial_consent_notice", null],
      ]),
      display
    ),
    "jurisdiction_footer_incomplete"
  );
  // A duty with no state is a decision nobody has made.
  assert.equal(
    releaseNotesSkipReason(verdict([["body_disclosures", "no_state"]]), display),
    "obligation_undecided"
  );
  // A failing check on a duty that prints nothing is not a footer.
  assert.equal(
    releaseNotesSkipReason(
      verdict([["consent_result_notice_14_days", "readiness_check_failing"]]),
      display
    ),
    "obligation_undecided"
  );
  // Mixed: the undecided one is the one to report.
  assert.equal(
    releaseNotesSkipReason(
      verdict([
        ["body_disclosures", "readiness_check_failing"],
        ["consent_result_notice_14_days", "no_state"],
      ]),
      display
    ),
    "obligation_undecided"
  );
  // Without the table the word is unchanged.
  assert.equal(
    releaseNotesSkipReason(verdict([["body_disclosures", "readiness_check_failing"]])),
    "obligation_undecided"
  );
});
