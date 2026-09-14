import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOOTER_LANGUAGES,
  RENDERABLE_FOOTER_BLOCKS,
  renderJurisdictionFooter,
} from "../lib/emailFooterRenderer.ts";
import { JURISDICTION_PROFILE_SEED } from "../lib/emailJurisdictionSeed.ts";

// The per-jurisdiction footer.
// Contract: docs/policy/email-notifications.md §5.2 E3, §8.6, §18.3.

/**
 * A complete set of business identity values.
 *
 * Invented for the test. Q8 has not been answered, so there are no real ones
 * yet -- which is the case the "refuses to render" tests below are about.
 */
const IDENTITY = {
  legalName: "Tomverse Ltd.",
  postalAddress: "1 Example Street, Seoul 00000, Republic of Korea",
  contactEmail: "support@example.test",
  businessRegistrationNumber: "000-00-00000",
  mailOrderRegistrationNumber: "0000-Seoul-0000",
  abn: "00 000 000 000",
};

const render = (profileKey, overrides = {}) => {
  const profile = JURISDICTION_PROFILE_SEED.find(
    (candidate) => candidate.profileKey === profileKey
  );
  return renderJurisdictionFooter({
    profile,
    identity: IDENTITY,
    unsubscribeUrl: "https://example.test/unsubscribe?token=t",
    ...overrides,
  });
};

test("every profile renders in every language", () => {
  // §18.3's acceptance criterion, now 9 profiles x 7 languages = 63: Switzerland
  // left the EU profile on 2026-09-14. The count is asserted rather than assumed,
  // because the reason it is 63 and not 63-ish is that a country maps onto a
  // profile and a person carries a language, and the two axes never multiply out
  // to something else.
  let rendered = 0;
  for (const profile of JURISDICTION_PROFILE_SEED) {
    for (const language of FOOTER_LANGUAGES) {
      const result = render(profile.profileKey, { language });
      assert.equal(
        result.ok,
        true,
        `${profile.profileKey}/${language}: ${result.ok ? "" : result.missing.join(", ")}`
      );
      assert.ok(result.text.length > 0);
      assert.ok(result.html.includes("<p"));
      rendered += 1;
    }
  }
  assert.equal(rendered, 63);
});

test("the blocks appear in the order the profile lists them", () => {
  // The order is a profile decision, not a renderer one: Australia puts the ABN
  // directly under the name and above the address, and reordering it would be
  // an edit to the profile rather than a deploy (§8.7).
  //
  // Read off Australia rather than Korea since 2026-09-14: Korea's profile no
  // longer names a jurisdiction-specific block, so its order is the common one
  // and proves nothing about a profile choosing its own.
  const result = render("AU", { language: "ko" });
  const lines = result.text.split("\n");
  assert.equal(lines[0], IDENTITY.legalName);
  assert.ok(lines[1].startsWith("ABN"));
  assert.equal(lines[2], IDENTITY.postalAddress);
});

test("language and jurisdiction are separate axes", () => {
  // §8.6. An Australian resident reading in Korean gets Australia's blocks with
  // Korean labels. Collapsing the two would put `ko` = Korea into the code,
  // which is wrong for every Korean speaker abroad.
  //
  // Australia carries this since 2026-09-14 for the reason above: Korea's
  // profile no longer has a block of its own, so it cannot show that the block
  // set follows the country while the words follow the reader.
  const english = render("AU", { language: "en" });
  const korean = render("AU", { language: "ko" });

  assert.ok(english.text.includes("Contact:"));
  assert.ok(korean.text.includes("문의:"));
  // Same blocks either way -- the jurisdiction picked them, not the language.
  assert.ok(english.text.includes("ABN"));
  assert.ok(korean.text.includes("ABN"));
  assert.equal(english.text.split("\n").length, korean.text.split("\n").length);

  // And the reverse: an American reading in Korean gets Korean labels and no
  // Australian block at all.
  const american = render("US", { language: "ko" });
  assert.equal(american.text.includes("ABN"), false);
  assert.ok(american.text.includes("수신거부"));
});

test("a missing identity value refuses the footer instead of dropping the line", () => {
  // The failure C4 exists to prevent: a footer that looks complete and is
  // unlawful in the jurisdiction that required the missing block.
  const result = render("AU", { identity: { ...IDENTITY, abn: null } });
  assert.deepEqual(result, { ok: false, missing: ["abn"] });
});

test("every missing value is reported at once", () => {
  // Learning about one missing value, fixing it, and learning about the next
  // is three deploys to learn three facts.
  const result = render("KR", {
    identity: {
      legalName: "Tomverse Ltd.",
      postalAddress: null,
      contactEmail: null,
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["postal_address", "contact_email"]);
});

test("a footer that names an unsubscribe link and has no URL is refused", () => {
  // A profile naming the block with no URL supplied is a classification
  // mistake -- transactional mail carries no link at all (C10) -- and it is
  // refused rather than rendered with a dead link.
  const result = render("US", { unsubscribeUrl: null });
  assert.equal(result.ok, false);
  assert.ok(result.missing.includes("unsubscribe_link"));
});

test("the unsubscribe line quotes the profile's own deadline", () => {
  // E4. The number is per jurisdiction and the behaviour is not: processing is
  // immediate everywhere, and the sentence says both.
  const australia = render("AU", { language: "en" });
  assert.ok(australia.html.includes("5 business days"));
  assert.ok(australia.html.includes("immediately"));
  const america = render("US", { language: "en" });
  assert.ok(america.html.includes("10 business days"));
});

test("a block the renderer does not know is reported, not ignored", () => {
  const result = renderJurisdictionFooter({
    profile: {
      profileKey: "XX",
      footerBlocks: ["legal_name", "vat_number"],
      unsubscribeSlaBusinessDays: 5,
    },
    identity: IDENTITY,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["vat_number"]);
});

test("identity values are escaped into the HTML", () => {
  const result = render("US", {
    identity: { ...IDENTITY, legalName: 'Tom & "Verse" <Ltd>' },
  });
  assert.equal(result.ok, true);
  assert.ok(result.html.includes("Tom &amp; &quot;Verse&quot; &lt;Ltd&gt;"));
  assert.equal(result.html.includes("<Ltd>"), false);
  // The plain-text alternative (C11) carries the value as written.
  assert.ok(result.text.includes('Tom & "Verse" <Ltd>'));
});

test("an unknown language falls back to English rather than rendering blanks", () => {
  const result = render("US", { language: "sv" });
  assert.equal(result.ok, true);
  assert.ok(result.text.includes("Unsubscribe"));
});

test("the reason line is always present, supplied or not", () => {
  // C4 requires the recipient to be told why they are receiving it. A caller
  // that forgets gets the default rather than a footer missing the clause.
  const supplied = render("US", { reasonLine: "You bought a Pro plan." });
  assert.ok(supplied.text.includes("You bought a Pro plan."));
  const fallback = render("US", { language: "en" });
  assert.ok(fallback.text.includes("You are receiving this because"));
});

/**
 * Blocks the renderer can draw that no seeded profile currently names.
 *
 * The invariant below exists to catch a dead branch, and a block goes unused
 * for two very different reasons. If a jurisdiction stopped requiring a value,
 * the branch really is dead and should go. If *this sender* cannot fill it,
 * the jurisdiction rule is unchanged and the capability has to stay -- country
 * rules are data in this system (§12.5, §8.7), so a Korean registration later
 * must be a seed change and a new policy version, not a code change that
 * re-adds a renderer branch and an environment variable.
 *
 * Both Korean numbers are the second kind, as of 2026-09-14: they come from
 * 전자상거래법's duty on 통신판매업자, the sender is an Australian company, and it
 * was confirmed not to be a Korean mail-order registrant. Nothing about
 * 정보통신망법 changed.
 *
 * Anything added here needs that reason written next to it. An entry with no
 * reason is how this list becomes a way to silence the check.
 */
const UNUSED_BY_THIS_SENDER = new Set([
  "business_registration",
  "mail_order_registration",
]);

test("every renderable block is reachable from at least one profile", () => {
  // A block nobody uses is either a missing profile or a dead branch, and both
  // are worth noticing. `abn` is the narrow one.
  const used = new Set(
    JURISDICTION_PROFILE_SEED.flatMap((profile) => profile.footerBlocks)
  );
  for (const block of RENDERABLE_FOOTER_BLOCKS) {
    if (UNUSED_BY_THIS_SENDER.has(block)) continue;
    assert.ok(used.has(block), `${block} is rendered by nothing`);
  }
});

test("a block excused as unusable by this sender is really unused", () => {
  // The escape hatch above only covers blocks no profile names. If one is
  // seeded again -- a Korean registration arrives -- the entry is stale and
  // says a capability is unfillable while the footer is asking for it.
  const used = new Set(
    JURISDICTION_PROFILE_SEED.flatMap((profile) => profile.footerBlocks)
  );
  for (const block of UNUSED_BY_THIS_SENDER) {
    assert.ok(
      RENDERABLE_FOOTER_BLOCKS.includes(block),
      `${block} is excused but the renderer no longer draws it, so remove the entry`
    );
    assert.ok(
      !used.has(block),
      `${block} is named by a profile again, so it is no longer unusable by this sender`
    );
  }
});
