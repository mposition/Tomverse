import "server-only";
import { Prisma } from "@prisma/client";
import { ChatAccessError } from "@/lib/chatSecurity";
import { externalApiKeyState } from "@/lib/externalApiKeyCore";
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
 */
export const externalApiAdmissionHook =
    (input: {
        requestId: string;
        keyId: string;
        userId: string;
        modelId: string;
        stream: boolean;
        clientName: string | null;
        requestDigest: string;
        idempotencyKeyDigest: string | null;
        /** Which wire protocol the request arrived on; content-free metadata. */
        protocol?: ExternalApiProtocol;
        now?: () => Date;
    }) =>
    async (
        tx: Prisma.TransactionClient,
        reservation: { reservationId: string; usageCredits: number }
    ) => {
        const now = input.now?.() ?? new Date();
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
          FROM "ExternalApiKey" WHERE "id" = ${input.keyId} FOR UPDATE`;
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
        await tx.externalApiRequest.create({
            data: {
                id: input.requestId,
                keyId: key.id,
                userId: input.userId,
                reservationId: reservation.reservationId,
                idempotencyKeyDigest: input.idempotencyKeyDigest,
                requestDigest: input.requestDigest,
                clientName: input.clientName,
                modelId: input.modelId,
                stream: input.stream,
                protocol: input.protocol ?? "chat_completions",
            },
        });
        // At most once a minute: the row is already locked, and a timestamp
        // that is a minute stale says the same thing to the person reading it.
        if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
            await tx.externalApiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        }
    };
