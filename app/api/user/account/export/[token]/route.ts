export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import {
    exportDownloadFilename,
    exportDownloadHeaders,
} from "@/lib/accountDataExportTicketCore";
import {
    recordAccountDataExportDelivery,
    redeemAccountDataExportTicket,
} from "@/lib/accountDataExportTickets";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

/**
 * Step two: exchange the single-use token for the export, once.
 *
 * The session is still required. The token is not a bearer credential that
 * replaces signing in -- it narrows an already-authenticated request to one
 * download in one five-minute window, so a leaked URL is useless to anyone who
 * is not already the account holder in that browser.
 *
 * No file is written. The document is built in memory and streamed in this
 * response, which is a stronger property than deleting a generated file
 * afterwards: there is no window in which a copy exists on disk, in a backup of
 * that disk, or in object storage waiting for a lifecycle rule that might be
 * misconfigured. The only artefact that outlives the request is the audit row,
 * which holds counts and never content.
 */
export async function GET(
    req: Request,
    context: { params: Promise<{ token: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: "Authentication required." },
                { status: 401, headers: { "Cache-Control": "no-store" } }
            );
        }
        const userId = session.user.id;

        // Guessing is not a viable attack against a 256-bit single-use token,
        // but a limit here also bounds how fast a stolen link can be probed
        // against every signed-in session an attacker holds.
        await consumeApiRateLimit(req, userId, "account-data-export-download", {
            minute: 5,
            day: 20,
        });

        const { token } = await context.params;
        const redemption = await redeemAccountDataExportTicket({
            token,
            userId,
            request: req,
        });

        if (!redemption.ok) {
            logSecurityAuditEvent("account.data_export.refused", {
                userId,
                request: req,
                outcome: "denied",
            });
            // One message for every refusal. "Expired", "already used" and
            // "belongs to someone else" are different answers, and the
            // difference is worth something to whoever is holding a link they
            // should not have. The audit row keeps the distinction.
            return NextResponse.json(
                {
                    error: "This download link is no longer usable. Request a new export.",
                    code: "EXPORT_LINK_UNUSABLE",
                },
                { status: 410, headers: { "Cache-Control": "no-store" } }
            );
        }

        const result = await buildAccountDataExport(userId);
        const body = JSON.stringify(
            result,
            // The credit and payment rows carry BigInt cost columns. Without
            // this, JSON.stringify throws after the ticket is already spent.
            (_key, value) => (typeof value === "bigint" ? value.toString() : value),
            2
        );

        await recordAccountDataExportDelivery({
            ticketId: redemption.ticketId,
            exportSchemaVersion: result.manifest.schemaVersion,
            includedDomainCount: result.manifest.includedDomains.length,
            filteredDomainCount: result.manifest.filteredDomains.length,
            byteLength: Buffer.byteLength(body, "utf8"),
        });

        logSecurityAuditEvent("account.data_export.download", {
            userId,
            request: req,
            outcome: "success",
        });

        return new Response(body, {
            headers: exportDownloadHeaders(exportDownloadFilename(new Date())),
        });
    } catch (error) {
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("account data export download failed", error);
        // The ticket is spent by now. Saying so is the honest answer: silently
        // returning 500 leaves the user re-clicking a link that can never work
        // again.
        return NextResponse.json(
            {
                error: "The export could not be produced. Request a new one.",
                code: "EXPORT_BUILD_FAILED",
            },
            { status: 500, headers: { "Cache-Control": "no-store" } }
        );
    }
}
