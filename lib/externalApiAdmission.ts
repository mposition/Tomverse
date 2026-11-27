import "server-only";
import { Prisma } from "@prisma/client";
import { ChatAccessError } from "@/lib/chatSecurity";
import { externalApiKeyState } from "@/lib/externalApiKeyCore";
import type { ExternalApiAdmissionCredential } from "@/lib/externalApiCaller";
import type { ExternalApiSurface } from "@/lib/externalApiCatalogCore";
import type { ExternalApiProtocol } from "@/lib/externalApiProtocols";

export type KeyCreditTotals = { committed: number; held: number; count: number };

/**
 * Credits each key has committed, summed in the database: a held
 * reservation counts at its full reserved value, a settled or refunded one
 * at what it settled for. One aggregate row per key, whatever the key's
 * lifetime request count, so the cap check inside the credit-account lock
 * does not grow with history.
 */
export const keyCreditTotals = async (
    client: Pick<Prisma.TransactionClient, "$queryRaw">,
    keyIds: readonly string[]
): Promise<Map<string, KeyCreditTotals>> => {
    const totals = new Map<string, KeyCreditTotals>();
    if (keyIds.length === 0) return totals;
    const rows = await client.$queryRaw<Array<{ keyId: string; committed: bigint; held: bigint; count: bigint }>>`
        SELECT r."keyId" AS "keyId",
               COALESCE(SUM(CASE WHEN c."status" = 'reserved' THEN c."reservedCredits" ELSE c."settledCredits" END), 0)::bigint AS "committed",
               COALESCE(SUM(CASE WHEN c."status" = 'reserved' THEN c."reservedCredits" ELSE 0 END), 0)::bigint AS "held",
               COUNT(*)::bigint AS "count"
        FROM "ExternalApiRequest" r
        JOIN "ChatCreditReservation" c ON c."id" = r."reservationId"
        WHERE r."keyId" IN (${Prisma.join(keyIds)})
        GROUP BY r."keyId"`;
    for (const row of rows) {
        totals.set(row.keyId, { committed: Number(row.committed), held: Number(row.held), count: Number(row.count) });
    }
    return totals;
};

/**
 * The part of an external API admission that runs inside the shared
 * reservation transaction (acquireChatAccess's `withinReservationTransaction`).
 *
 * By the time it runs, the credit account lock is held -- every request of one
 * account, from the web, the API or any of its keys, is serialised behind it --
 * and the reservation row exists. This re-reads the key under `FOR UPDATE`,
 * refuses a key revoked or expired since authentication, enforces the key's own
 * credit cap over everything the key has committed (settled, held, and
 * dispatched-but-unresolved), and binds the request to the reservation. A
 * throw rolls back the whole hold, so a refusal leaves nothing held.
 *
 * A Desktop session request (lib/externalApiCaller.ts) has no key and no key
 * cap: the same transaction re-reads its session family instead, refusing one
 * signed out or ended since authentication, and binds the request under the
 * account's Desktop session. The account's credits, concurrency and cost
 * guardrails were already applied by the reservation itself, as for a key.
 */
export const externalApiAdmissionHook =
    (input: {
        requestId: string;
        /** The key, or the account's Desktop session (lib/externalApiCaller.ts admissionCredential). */
        credential: ExternalApiAdmissionCredential;
        userId: string;
        modelId: string;
        stream: boolean;
        clientName: string | null;
        requestDigest: string;
        idempotencyKeyDigest: string | null;
        /**
         * Which wire protocol the request arrived on; content-free metadata.
         * `web_search` is the coding API's web search (lib/codeWebSearch.ts),
         * which generates nothing and is not a model protocol.
         */
        protocol?: ExternalApiProtocol | "web_search";
        /** Which external API the request came through (its address); content-free. */
        surface: ExternalApiSurface;
        /**
         * Smart Adaptive's decision, content-free: how the model was chosen,
         * whether a cheaper pick was held, and a digest of the conversation's
         * routing key (lib/externalApiRoutingReportCore.ts reads them).
         */
        routing?: { routedBy: "router" | "continued" | "default"; held: boolean; conversation: string | null };
        now?: () => Date;
    }) =>
    async (
        tx: Prisma.TransactionClient,
        reservation: { reservationId: string; usageCredits: number }
    ) => {
        const now = input.now?.() ?? new Date();
        if ("desktopUserId" in input.credential) {
            await admitDesktopSession(tx, input, input.credential, reservation, now);
            return;
        }
        const keyId = input.credential.keyId;
        const rows = await tx.$queryRaw<
            Array<{
                id: string;
                userId: string;
                creditCap: number | null;
                expiresAt: Date | null;
                revokedAt: Date | null;
                lastUsedAt: Date | null;
            }>
        >`SELECT "id", "userId", "creditCap", "expiresAt", "revokedAt", "lastUsedAt"
          FROM "ExternalApiKey" WHERE "id" = ${keyId} FOR UPDATE`;
        const key = rows[0];
        if (!key || key.userId !== input.userId || externalApiKeyState(key, now) !== "active") {
            throw new ChatAccessError(401, "invalid_api_key", "A valid Tomverse API key is required.");
        }
        if (input.idempotencyKeyDigest) {
            const existing = await tx.externalApiRequest.findUnique({
                where: {
                    keyId_idempotencyKeyDigest: {
                        keyId: key.id,
                        idempotencyKeyDigest: input.idempotencyKeyDigest,
                    },
                },
                select: { id: true },
            });
            if (existing) {
                // A concurrent twin won the race after the pre-check; this one
                // must not dispatch. The route turns this into the receipt.
                // Checked before the key cap: a twin of an admitted request is
                // that request, and gets its receipt rather than a cap refusal.
                throw new ChatAccessError(409, "idempotency_key_in_use", "A request with this Idempotency-Key already exists.");
            }
        }
        if (key.creditCap !== null) {
            const used = (await keyCreditTotals(tx, [key.id])).get(key.id)?.committed ?? 0;
            if (used + reservation.usageCredits > key.creditCap) {
                throw new ChatAccessError(
                    429,
                    "key_credit_cap_reached",
                    "This API key has reached the credit limit set for it. Raise the limit or use another key.",
                    undefined,
                    { creditCap: key.creditCap, committedCredits: used }
                );
            }
        }
        await tx.externalApiRequest.create({ data: { ...receiptRow(input, reservation), keyId: key.id } });
        // At most once a minute: the row is already locked, and a timestamp
        // that is a minute stale says the same thing to the person reading it.
        if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
            await tx.externalApiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        }
    };

type AdmissionInput = Parameters<typeof externalApiAdmissionHook>[0];

/** The receipt row's content-free fields, shared by both credentials. */
const receiptRow = (input: AdmissionInput, reservation: { reservationId: string }) => ({
    id: input.requestId,
    userId: input.userId,
    reservationId: reservation.reservationId,
    idempotencyKeyDigest: input.idempotencyKeyDigest,
    requestDigest: input.requestDigest,
    clientName: input.clientName,
    modelId: input.modelId,
    stream: input.stream,
    protocol: input.protocol ?? "chat_completions",
    surface: input.surface,
    ...(input.routing
        ? {
              routedBy: input.routing.routedBy,
              routedHeld: input.routing.held,
              routeConversation: input.routing.conversation,
          }
        : {}),
});

/**
 * A Desktop session request's half of the admission: its family is still live (a sign-out since authentication
 * refuses here, as a revoked key does above), its Idempotency-Key is the account session's, and it has no cap of its
 * own. The reservation that is already held is what bounds it: the account's credits and every limit the shared
 * reservation applies.
 *
 * The family row is locked FOR SHARE for the rest of the transaction, as the key row is locked FOR UPDATE above: a
 * sign-out (which writes revokedAt) either committed before this read and is refused here, or waits until this
 * admission has committed, so a request is never admitted for a session already signed out. Shared, so concurrent
 * requests of one session do not queue behind each other. Sign-out and rotation (lib/mobileAuthService.ts) never take
 * the credit-account lock this transaction already holds, so they cannot deadlock with it.
 */
const admitDesktopSession = async (
    tx: Prisma.TransactionClient,
    input: AdmissionInput,
    credential: { desktopUserId: string; desktopFamilyId: string },
    reservation: { reservationId: string },
    now: Date
) => {
    if (credential.desktopUserId !== input.userId) {
        throw new ChatAccessError(401, "invalid_desktop_session", "A valid Tomverse Desktop session is required. Sign in to Tomverse Desktop again.");
    }
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "MobileTokenFamily"
        WHERE "id" = ${credential.desktopFamilyId} AND "userId" = ${input.userId} AND "revokedAt" IS NULL
        FOR SHARE`;
    // The expiry is read typed, as resolveAccountRouteSession reads it, so it compares as stored whatever the session
    // time zone; the row is already locked above.
    const live = locked[0]
        ? await tx.mobileTokenFamily.findFirst({
              where: { id: credential.desktopFamilyId, userId: input.userId, revokedAt: null, absoluteExpiresAt: { gt: now } },
              select: { id: true },
          })
        : null;
    if (!live) {
        throw new ChatAccessError(401, "invalid_desktop_session", "A valid Tomverse Desktop session is required. Sign in to Tomverse Desktop again.");
    }
    if (input.idempotencyKeyDigest) {
        const existing = await tx.externalApiRequest.findUnique({
            where: { desktopUserId_idempotencyKeyDigest: { desktopUserId: input.userId, idempotencyKeyDigest: input.idempotencyKeyDigest } },
            select: { id: true },
        });
        if (existing) {
            throw new ChatAccessError(409, "idempotency_key_in_use", "A request with this Idempotency-Key already exists.");
        }
    }
    await tx.externalApiRequest.create({ data: { ...receiptRow(input, reservation), desktopUserId: input.userId } });
};
