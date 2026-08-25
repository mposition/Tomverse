/**
 * How an email address is shown to an administrator who has not asked to see it.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10),
 * decided 2026-08-24.
 *
 * ## What the decision changed
 *
 * `/admin/email-delivery` used to render every address in full, to every
 * administrator, on every visit, leaving no trace. That made exposure a
 * **state**. D10 makes it an **event**: masked by default, revealed by a
 * deliberate act that is audited.
 *
 * ## Why the domain stays
 *
 * A mask that hid everything would make the screen useless — an operator
 * scanning a bounce list needs to see that five failures are all one provider,
 * and "•••" five times says nothing. The local part is the identifying half and
 * the domain is the operational half, so the domain is kept and the local part
 * is reduced to its ends.
 *
 * The ends rather than nothing, because the ordinary support question is
 * *"is this row the person who wrote to me"* — and comparing an address the
 * person supplied against `p•••n@example.test` answers it without anybody
 * revealing anything.
 *
 * ## Failing towards less
 *
 * Anything this cannot parse is masked entirely. A value that does not look
 * like an address is a value nothing here understands, and showing it in full
 * on the grounds that the mask did not apply would be exactly backwards.
 */

/** The character standing in for what is hidden. Not `*`, which reads as a wildcard. */
export const MASK_CHARACTER = "•";

const MASK_RUN = MASK_CHARACTER.repeat(3);

/**
 * Masks the local part, keeps the domain.
 *
 * A local part of one or two characters is hidden completely rather than
 * partly: `ab@x.test` masked as `a•••b@x.test` would be longer than the
 * original and would disclose all of it.
 */
export const maskEmailAddress = (
  address: string | null | undefined
): string | null => {
  if (address == null) return null;
  const trimmed = address.trim();
  if (trimmed.length === 0) return "";

  const at = trimmed.lastIndexOf("@");
  // No `@`, nothing after it, or nothing before it: not an address shape this
  // understands, so none of it is shown.
  if (at <= 0 || at === trimmed.length - 1) return MASK_RUN;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length <= 2) return `${MASK_RUN}@${domain}`;
  return `${local[0]}${MASK_RUN}${local[local.length - 1]}@${domain}`;
};

/**
 * Whether a value is already masked.
 *
 * Used by the tests that guarantee a masked address never reaches the reveal
 * comparison, and by nothing in the render path: a screen deciding for itself
 * whether something "looks masked" would be a second place the rule lives.
 */
export const looksMasked = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.includes(MASK_CHARACTER);

/**
 * Which admin roles may reveal (D10, decided 2026-08-24: `owner` and `ops`).
 *
 * A separate list from the navigation entry's `writeRoles`, even though it
 * holds the same two roles today. That one drives the sidebar's "Read" marker
 * and says who may *change* things; this one says who may see an address. They
 * are the same answer to two different questions, and merging them would make a
 * future change to either silently move the other.
 */
export const ADDRESS_REVEAL_ROLES = ["owner", "ops"] as const;

export type AddressRevealRole = (typeof ADDRESS_REVEAL_ROLES)[number];

export const roleMayRevealAddresses = (role: string | null | undefined) =>
  typeof role === "string" &&
  (ADDRESS_REVEAL_ROLES as readonly string[]).includes(role);

/**
 * The kinds of row an address can be revealed for.
 *
 * Separate entries because they are separate tables and a reveal has to say
 * which one it is asking about. The first two live on `/admin/email-delivery`;
 * `campaign_recipient` is the expansion ledger on a campaign's own page, which
 * held counts only until D10 was decided.
 */
export const ADDRESS_REVEAL_KINDS = [
  "delivery",
  "suppression",
  "campaign_recipient",
] as const;

export type AddressRevealKind = (typeof ADDRESS_REVEAL_KINDS)[number];

/**
 * What the audit entry calls the thing that was revealed.
 *
 * Derived from the kind rather than written at the call site: the reveal is one
 * endpoint serving every kind, and a hardcoded target type would file a
 * campaign ledger disclosure under `EmailDelivery` — findable only by somebody
 * who already knew to look in the wrong place.
 */
export const ADDRESS_REVEAL_TARGET_TYPES: Record<AddressRevealKind, string> = {
  delivery: "EmailDelivery",
  suppression: "SuppressionEntry",
  campaign_recipient: "EmailCampaignRecipient",
};

/**
 * The most addresses one reveal may return, and therefore the most rows any
 * screen that offers a reveal may list.
 *
 * D10 chose the **screen** as the unit. The bound is what keeps "one reveal,
 * one audit entry" honest: without it a single audited call could return the
 * whole table, and the record would say an operator revealed one screen when
 * they had taken everything.
 *
 * **It is one number because the two would otherwise drift, and the drift is
 * invisible until somebody presses the button.** `/admin/email-delivery`
 * shipped with a page size an operator could raise to 200 while the reveal
 * still capped at 100, so `?limit=101` and up produced a control that failed
 * validation and said only "Could not show the addresses." A cap whose whole
 * meaning is "one screen" has to *be* the screen.
 */
export const ADDRESS_REVEAL_MAX_IDS = 100;
