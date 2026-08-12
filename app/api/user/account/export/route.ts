export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import {
    assertRecentAdminAuthentication,
    isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
    issueAccountDataExportTicket,
    listAccountDataExportHistory,
} from "@/lib/accountDataExportTickets";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * The account's own record of who downloaded its data and when.
 *
 * Deliberately not behind the step-up: it is the trail a user consults when
 * they suspect somebody else has been in the account, and requiring a fresh
 * sign-in to look would put the check behind the same door the attacker
 * already opened. Nothing here is a credential -- no token hash, no request
 * context, only what happened and when.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401, headers: { "Cache-Control": "no-store" } }
            );
        }

        await consumeApiRateLimit(req, session.user.id, "account-data-export-history", {
            minute: 20,
            day: 200,
        });

        return NextResponse.json(
            { requests: await listAccountDataExportHistory(session.user.id) },
            { headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("account data export history failed", error);
        return NextResponse.json(
            { error: "Failed to load the export history." },
            { status: 500, headers: { "Cache-Control": "no-store" } }
        );
    }
}

/**
 * Step one of the unified account export (PRIVACY-02): issue a download link.
 *
 * The export itself is not built here and no file is written anywhere. This
 * hands back a single-use token with a five-minute life; step two exchanges it
 * for the document, generated on the spot and streamed once.
 *
 * Why this is a POST that returns a URL, rather than one GET that returns the
 * file the way /api/memories/export does. That export is a subset of a subset;
 * this one is conversations, memories, linked providers and payments in a
 * single object, and it is the highest-value thing the product can produce
 * about a person. The properties the split buys:
 *
 *   - the URL, if it survives into shell history, a proxy log, a Referer or a
 *     screenshot, is almost always already spent and always expired within
 *     minutes, where a plain GET works for the life of the session;
 *   - a second use is refused and recorded, so the account owner and an
 *     operator can both see that a link was presented twice;
 *   - the step-up is required to *obtain* the link, so a stolen link cannot be
 *     re-obtained without signing in again.
 *
 * `assertRecentAdminAuthentication` reads session freshness, not an admin role.
 * Account deletion and the memory export already use it as the account-holder
 * step-up, and reusing it keeps one step-up contract and one 428 client path.
 */
export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401, headers: { "Cache-Control": "no-store" } }
            );
        }
        const userId = session.user.id;

        // Deliberately tighter than the per-domain exports. Each issued ticket
        // is a live download link for the whole account, and there is no
        // legitimate reason to hold several at once.
        await consumeApiRateLimit(req, userId, "account-data-export", {
            minute: 2,
            day: 10,
        });
        await assertRecentAdminAuthentication(session);

        const ticket = await issueAccountDataExportTicket({ userId, request: req });

        logSecurityAuditEvent("account.data_export.request", {
            userId,
            request: req,
            outcome: "success",
        });

        return NextResponse.json(
            {
                // Relative, so the token is never pasted into an absolute URL
                // by a caller that guessed the wrong origin.
                downloadPath: `/api/user/account/export/${ticket.token}`,
                expiresAt: ticket.expiresAt.toISOString(),
                singleUse: true,
            },
            { status: 201, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (isAdminReauthenticationError(error)) {
            return NextResponse.json(
                {
                    error: "Sign in again before downloading your account data.",
                    code: "ACCOUNT_REAUTHENTICATION_REQUIRED",
                },
                { status: 428, headers: { "Cache-Control": "no-store" } }
            );
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("account data export ticket failed", error);
        return NextResponse.json(
            { error: "Failed to prepare the export." },
            { status: 500, headers: { "Cache-Control": "no-store" } }
        );
    }
}
