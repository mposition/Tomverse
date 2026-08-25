import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ADDRESS_REVEAL_KINDS,
  ADDRESS_REVEAL_MAX_IDS,
  ADDRESS_REVEAL_ROLES,
  MASK_CHARACTER,
  looksMasked,
  maskEmailAddress,
  roleMayRevealAddresses,
} from "../lib/emailAddressMaskingCore.ts";

// D10, decided 2026-08-24: mask by default, reveal by a deliberate audited act,
// no reason required, the screen is the unit, owner and ops only.
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21.

test("the local part is reduced to its ends and the domain is kept", () => {
  // The local part is the identifying half; the domain is the operational half
  // an operator scanning a bounce list actually needs.
  assert.equal(maskEmailAddress("person@example.test"), `p${MASK_CHARACTER.repeat(3)}n@example.test`);
  assert.equal(maskEmailAddress("a.long.name@mail.tomverse.app"), `a${MASK_CHARACTER.repeat(3)}e@mail.tomverse.app`);
});

test("a local part too short to mask is hidden entirely", () => {
  // `a•••b@x.test` would be longer than `ab@x.test` and would disclose all of
  // it, so two characters or fewer get nothing.
  assert.equal(maskEmailAddress("ab@x.test"), `${MASK_CHARACTER.repeat(3)}@x.test`);
  assert.equal(maskEmailAddress("a@x.test"), `${MASK_CHARACTER.repeat(3)}@x.test`);
});

test("anything that is not address-shaped is masked entirely", () => {
  // Failing towards less. A value nothing here understands is not a value to
  // show in full on the grounds that the mask did not apply.
  for (const value of ["not-an-address", "@x.test", "person@", "@", "  "]) {
    const masked = maskEmailAddress(value);
    assert.ok(
      masked === MASK_CHARACTER.repeat(3) || masked === "",
      `${JSON.stringify(value)} leaked as ${JSON.stringify(masked)}`
    );
  }
});

test("null stays null, so an absent address is not reported as a hidden one", () => {
  // A delivery with no address and a delivery whose address is hidden are
  // different facts, and a screen showing dots for both would say the wrong one.
  assert.equal(maskEmailAddress(null), null);
  assert.equal(maskEmailAddress(undefined), null);
});

test("a masked value never contains the local part it hid", () => {
  const address = "confidential@example.test";
  const masked = maskEmailAddress(address);
  assert.ok(masked);
  assert.ok(!masked.includes("onfidentia"));
  assert.ok(looksMasked(masked));
  assert.ok(!looksMasked(address));
});

test("only owner and ops may reveal", () => {
  assert.deepEqual([...ADDRESS_REVEAL_ROLES], ["owner", "ops"]);
  for (const role of ADDRESS_REVEAL_ROLES) {
    assert.equal(roleMayRevealAddresses(role), true);
  }
  // Support reads this screen and sees masks. That is the decision, not an
  // oversight: reading the log and reading the addresses are separate questions.
  for (const role of ["support", "readonly", "not-authorized", null, undefined, ""]) {
    assert.equal(roleMayRevealAddresses(role), false, `${role} must not reveal`);
  }
});

test("the reveal is bounded to a screen", () => {
  // D10 chose the screen as the unit, and the screen is a hundred rows. Without
  // the bound one audited call could return the whole table, and the record
  // would say an operator revealed a screen when they had taken everything.
  assert.equal(ADDRESS_REVEAL_MAX_IDS, 100);
  assert.deepEqual([...ADDRESS_REVEAL_KINDS], ["delivery", "suppression"]);
});

test("the reveal is a POST, never a query parameter", () => {
  // A bookmarkable `?reveal=1` would turn exposure back into a state -- the
  // thing D10 replaced -- and would write an audit entry on every page load
  // until the noise buried the real ones.
  const route = readFileSync(
    "app/api/admin/email-deliveries/reveal/route.ts",
    "utf8"
  );
  assert.ok(route.includes("export async function POST"));
  assert.ok(!/export async function GET/.test(route));

  // And the screen never reads a reveal out of the URL. Asserted as the shape
  // it would take -- a `reveal` search param -- rather than by grepping the
  // word, which appears in the component's own name.
  const page = readFileSync(
    "app/(site)/(application)/admin/email-delivery/page.tsx",
    "utf8"
  );
  assert.ok(!/query\.reveal|searchParams.{0,20}reveal|["'`]reveal["'`]/i.test(page));
});

test("the audit entry records the act and not the addresses", () => {
  const route = readFileSync(
    "app/api/admin/email-deliveries/reveal/route.ts",
    "utf8"
  );
  // Written before the addresses are read, for the same reason
  // `runWithAdminApproval` writes one first: if the audit store is
  // unavailable, the disclosure does not happen.
  const auditAt = route.indexOf("email_address.revealed");
  const readAt = route.indexOf("revealEmailAddresses(");
  assert.ok(auditAt > 0 && readAt > auditAt, "the audit entry must precede the read");
  // The metadata carries the count and the ids. An address in the audit log
  // would make the record a second copy of the thing it is recording.
  // Scoped to the audit call itself: the response below it legitimately has an
  // `addresses` key, and a slice that ran into it would be checking the wrong
  // thing.
  const auditCall = route.slice(
    route.lastIndexOf("writeAdminAuditLog", auditAt),
    route.indexOf("});", auditAt)
  );
  assert.ok(auditCall.includes("count: body.ids.length"));
  assert.ok(!/emailAddress|address:/.test(auditCall));
});
