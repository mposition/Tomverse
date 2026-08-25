import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ADDRESS_REVEAL_KINDS,
  ADDRESS_REVEAL_MAX_IDS,
  ADDRESS_REVEAL_ROLES,
  ADDRESS_REVEAL_TARGET_TYPES,
  MASK_CHARACTER,
  looksMasked,
  maskEmailAddress,
  roleMayRevealAddresses,
} from "../lib/emailAddressMaskingCore.ts";
import { DELIVERY_PAGE_SIZE_MAX } from "../lib/adminEmailDeliveryFilters.ts";

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
  assert.deepEqual(
    [...ADDRESS_REVEAL_KINDS],
    ["delivery", "suppression", "campaign_recipient"]
  );
});

test("no screen may list more rows than one reveal covers", () => {
  // Shipped wrong once: the delivery page allowed `?limit=200` while the cap
  // was 100, so on a page that looked like every other page the button failed
  // validation and said only "Could not show the addresses." A cap whose whole
  // meaning is "one screen" has to be the screen, so it is one number.
  assert.equal(DELIVERY_PAGE_SIZE_MAX, ADDRESS_REVEAL_MAX_IDS);
});

test("every kind names its own table in the audit record", () => {
  // A single hardcoded target type filed a campaign ledger disclosure under
  // `EmailDelivery`, where it is findable only by somebody who already knew to
  // look in the wrong place.
  const types = ADDRESS_REVEAL_KINDS.map((kind) => {
    const target = ADDRESS_REVEAL_TARGET_TYPES[kind];
    assert.ok(target, `${kind} has no target type`);
    return target;
  });
  assert.equal(new Set(types).size, types.length, "two kinds share a target type");
  assert.equal(ADDRESS_REVEAL_TARGET_TYPES.campaign_recipient, "EmailCampaignRecipient");
});

test("the campaign ledger reveals through the one shared path", () => {
  // Three tables answer to the reveal now. A second implementation would be a
  // second place the role check and the audit entry could be missing, so the
  // route imports the shared module and the campaign screen has no reveal of
  // its own.
  const route = readFileSync(
    "app/api/admin/email-deliveries/reveal/route.ts",
    "utf8"
  );
  assert.ok(route.includes('from "@/lib/adminEmailAddressReveal"'));

  const ledger = readFileSync("components/admin/AdminWaveLedger.tsx", "utf8");
  assert.ok(
    ledger.includes('kind="campaign_recipient"'),
    "the ledger must reveal as its own kind"
  );
  assert.ok(
    !/fetch\((?!.*email-campaigns).*reveal/.test(ledger),
    "the ledger must not call a reveal endpoint of its own"
  );
});

test("the campaign ledger page never carries a raw address", () => {
  // The masked value is all the response holds, so an operator who does not
  // press the button never had the address in their browser. Asserted as the
  // absence of the field name the panel would have to reach for.
  const ledger = readFileSync("components/admin/AdminWaveLedger.tsx", "utf8");
  assert.ok(ledger.includes("emailAddressMasked"));
  assert.ok(
    !/\bemailAddress\b(?!Masked)/.test(ledger),
    "the ledger row type must not name the raw field"
  );
});

test("the campaign screen no longer defers the question D10 answered", () => {
  // The seventh slice said on screen that building the list would be answering
  // an open question. It is answered, so that sentence would now be false.
  const panel = readFileSync(
    "components/admin/AdminCampaignDetailPanel.tsx",
    "utf8"
  );
  assert.ok(!panel.includes("Building the list would be"));
  assert.ok(!panel.includes("Counts, not people"));
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
