import "server-only";

import {
    ASSISTANT_PROFILE_IMPORT_LIMITS,
} from "@/lib/assistantProfileImportCore";
import {
    AssistantProfileImportError,
    cancelProfileImport,
} from "@/lib/assistantProfileImportService";
import { prisma } from "@/lib/prisma";

/**
 * Collecting imports nobody came back to, and upload claims nobody finished.
 *
 * docs/policy/assistant-package-import.md §5.6.
 *
 * Both run in the ordinary maintenance sweep rather than on a timer of their
 * own, for the reason the knowledge sweeps already do: a queue that is only
 * drained by the request that filled it is a queue that stops being drained
 * the moment the requests stop.
 */

/** How many expired imports one sweep will take. */
const EXPIRY_BATCH = 50;

export type ImportExpirySweepResult = {
    considered: number;
    cancelled: number;
    /** Imports the fail-closed cleanup declined to touch, with the reasons. */
    refused: number;
};

/**
 * Expires staging imports on either clock.
 *
 * The work is `cancelProfileImport()` -- the same function the owner's cancel
 * button calls, including its refusal conditions. A second implementation here
 * would be a second answer to "may this profile be deleted", and this one runs
 * unattended.
 *
 * A refusal is not an error and does not stop the batch: it means the import
 * is in a state a person should look at, which is exactly what the refusal is
 * for. It is counted and logged rather than retried, because retrying would
 * produce the same refusal every fifteen minutes forever.
 */
export async function sweepExpiredProfileImports(
    now: Date
): Promise<ImportExpirySweepResult> {
    const expired = await prisma.assistantProfileImport.findMany({
        where: {
            status: "staging",
            OR: [
                { idleExpiresAt: { lte: now } },
                { absoluteExpiresAt: { lte: now } },
            ],
        },
        orderBy: { idleExpiresAt: "asc" },
        take: EXPIRY_BATCH,
        select: { id: true, userId: true, mode: true },
    });

    let cancelled = 0;
    let refused = 0;
    for (const row of expired) {
        try {
            await cancelProfileImport({ userId: row.userId, importId: row.id });
            cancelled += 1;
        } catch (error) {
            if (error instanceof AssistantProfileImportError) {
                refused += 1;
                // The id and the mode, and nothing about what was imported.
                console.error("Expired assistant import was not collected:", {
                    importId: row.id,
                    mode: row.mode,
                    code: error.code,
                });
                continue;
            }
            throw error;
        }
    }

    return { considered: expired.length, cancelled, refused };
}

/**
 * Returns upload claims whose finalize never came back.
 *
 * Only the claim is released; the reservation itself stays, because the key is
 * still one this server issued and the owner may still finish the upload. The
 * object behind an abandoned key is the orphan sweep's, which is the one place
 * that knows an object has no row at all.
 */
export async function reclaimStaleUploadClaims(now: Date): Promise<{
    reclaimed: number;
}> {
    const cutoff = new Date(
        now.getTime() - ASSISTANT_PROFILE_IMPORT_LIMITS.reservationClaimStaleMs
    );
    const result = await prisma.assistantKnowledgeUploadReservation.updateMany({
        where: { state: "finalizing", finalizingStartedAt: { lte: cutoff } },
        // All three together: the combined CHECK refuses a row that keeps a
        // token without a state, and a half-cleared claim is the shape the
        // sweep would then pass over forever.
        data: { state: "pending", claimToken: null, finalizingStartedAt: null },
    });
    return { reclaimed: result.count };
}
