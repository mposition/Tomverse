export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  ADDRESS_REVEAL_KINDS,
  ADDRESS_REVEAL_MAX_IDS,
  roleMayRevealAddresses,
  type AddressRevealKind,
} from "@/lib/emailAddressMaskingCore";
import { revealEmailAddresses } from "@/lib/adminEmailDeliveries";

/**
 * Showing the addresses on one screen, once, on the record.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10),
 * decided 2026-08-24: mask by default, reveal by a deliberate act, audit the
 * act. No reason required, the screen is the unit, and only `owner` and `ops`
 * may do it.
 *
 * ## Why this is a POST and not `?reveal=1`
 *
 * A query parameter is bookmarkable and survives a reload, which would turn
 * exposure back into a **state** — the exact thing D10 replaced — and would
 * write an audit entry on every page load until the noise buried the real ones.
 * A call whose result lives in memory until the page is left is an **event**,
 * which is what the decision asked for.
 *
 * ## Why it takes ids
 *
 * The screen is the unit, so the reveal covers what is on the screen: the
 * caller names those rows. This is not a widening — an operator could filter to
 * any rows they like and reveal those — and the cap keeps one call worth one
 * screen, so the audit record cannot say "revealed a screen" about somebody who
 * took the whole table.
 */

const revealSchema = z
  .object({
    kind: z.enum(
      ADDRESS_REVEAL_KINDS as unknown as [AddressRevealKind, ...AddressRevealKind[]]
    ),
    ids: z.array(z.string().trim().min(1).max(64)).min(1).max(ADDRESS_REVEAL_MAX_IDS),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // D10's third answer. Deliberately its own list rather than the navigation
    // entry's `writeRoles`: that one says who may change things, this one says
    // who may see an address, and they are two questions with the same answer
    // today.
    if (!roleMayRevealAddresses(getAdminRole(session))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-address-reveal", {
      minute: 10,
      day: 200,
    });

    const body = await readLimitedJson(req, 16 * 1024, revealSchema);

    // Written before the addresses are read, for the same reason
    // `runWithAdminApproval` writes one first: if the audit store is
    // unavailable, the disclosure does not happen. An exposure nobody can
    // account for afterwards is the state D10 replaced.
    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_address.revealed",
      targetType: "EmailDelivery",
      targetId: null,
      summary: `Revealed ${body.ids.length} ${body.kind} address(es).`,
      // The count and the ids, never the addresses. The record says what was
      // shown and to whom without becoming a second copy of it.
      metadata: { kind: body.kind, count: body.ids.length, ids: body.ids },
    });

    return NextResponse.json({
      addresses: await revealEmailAddresses({ kind: body.kind, ids: body.ids }),
    });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to reveal the addresses.", error);
    return NextResponse.json(
      { error: "Failed to reveal the addresses." },
      { status: 500 }
    );
  }
}
