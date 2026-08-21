export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  emailDeliveryStatusCounts,
  listEmailDeliveries,
} from "@/lib/adminEmailDeliveries";
import { parseDeliveryFilters } from "@/lib/adminEmailDeliveryFilters";

/**
 * The outbox, read back.
 *
 * Contract: docs/policy/email-notifications.md §9.5, §13.7.
 *
 * Read-only, and there is no companion write endpoint: nothing about a
 * delivery row is an administrator's to change. A row that should not have been
 * abandoned is re-sent by enqueuing the message again, which creates a new row
 * with its own idempotency key rather than reviving one whose key the provider
 * may still be suppressing.
 *
 * Filters are parsed by `lib/adminEmailDeliveryFilters.ts`, which drops what it
 * does not recognise rather than refusing the request -- this answers
 * hand-edited URLs and bookmarks that outlived a status name.
 */

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      // 404, not 403: the same answer an unauthenticated caller gets, so the
      // existence of the endpoint is not itself readable.
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-deliveries", {
      minute: 30,
      day: 600,
    });

    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const filters = parseDeliveryFilters(query);
    const [page, counts] = await Promise.all([
      listEmailDeliveries(filters),
      emailDeliveryStatusCounts(),
    ]);

    return NextResponse.json(
      { rows: page.rows, nextCursor: page.nextCursor, statusCounts: counts },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Failed to read the delivery history." },
      { status: 500 }
    );
  }
}
