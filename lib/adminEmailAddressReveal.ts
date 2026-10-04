import { prisma } from "@/lib/prisma";
import {
  ADDRESS_REVEAL_MAX_IDS,
  type AddressRevealKind,
} from "@/lib/emailAddressMaskingCore";

/**
 * The addresses behind a set of rows, for the audited reveal.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10),
 * decided 2026-08-24.
 *
 * ## Why this is its own module
 *
 * It began inside `lib/adminEmailDeliveries.ts` because the delivery screen was
 * the only thing that had a reveal. Three tables across two features answer to
 * it now, and a campaign screen importing a module named for deliveries is the
 * kind of shape that ends with somebody writing a second reveal rather than
 * finding this one. **One reveal path is the point** — it is the path the
 * route audits before calling.
 *
 * ## Why it is separate from the list reads
 *
 * Those can never return an address, and this can never be reached without the
 * route having checked the role and written the audit entry first. Two
 * functions rather than one with a flag, because a flag is a thing somebody
 * passes wrongly.
 *
 * ## What it does not do
 *
 * It does not check permission and it does not audit. That is the caller's job
 * and there is exactly one caller: `app/api/admin/email-deliveries/reveal`.
 * Putting the check here as well would read as defence in depth and act as a
 * second place for the rule to be different.
 */
export async function revealEmailAddresses(input: {
  kind: AddressRevealKind;
  ids: readonly string[];
  now?: Date;
}): Promise<Record<string, string | null>> {
  const ids = Array.from(new Set(input.ids)).slice(0, ADDRESS_REVEAL_MAX_IDS);
  if (ids.length === 0) return {};
  const now = input.now ?? new Date();

  const where = { id: { in: [...ids] } };
  const select = { id: true, emailAddress: true } as const;
  const rows =
    input.kind === "delivery"
      ? await prisma.emailDelivery.findMany({ where, select })
      : input.kind === "suppression"
        ? // A cause id, not an entry id: the console lists causes, so these are
          // the ids it handed out (docs/policy/email-product-news-redesign-draft.md,
          // section 7.4).
          //
          // **Active causes only.** Causes are append-only, and an entry used
          // to be deleted when its suppression was lifted -- so an entry id
          // stopped resolving to an address the moment the suppression ended,
          // and a cause id would never stop. Every id ever printed on this
          // screen, and every id sitting in an audit entry, would be a
          // permanent handle for turning a masked address back into an address.
          // The reveal exists for the rows on the screen now; a released or
          // expired cause is not one of them, and a request for one comes back
          // as if the id were unknown.
          await prisma.suppressionCause.findMany({
            where: {
              ...where,
              releasedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select,
          })
        : await prisma.emailCampaignRecipient.findMany({ where, select });

  return Object.fromEntries(rows.map((row) => [row.id, row.emailAddress]));
}
