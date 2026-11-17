import "server-only";
import type { Prisma } from "@prisma/client";
import { ChatAccessError } from "@/lib/chatSecurity";
import { externalApiKeyCommittedCredits, externalApiKeyState } from "@/lib/externalApiKeyCore";

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
        if (key.creditCap !== null) {
            const committed = await tx.externalApiRequest.findMany({
                where: { keyId: key.id },
                select: {
                    reservation: {
                        select: { status: true, reservedCredits: true, settledCredits: true },
                    },
                },
            });
            const used = externalApiKeyCommittedCredits(committed.map((row) => row.reservation));
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
                throw new ChatAccessError(409, "idempotency_key_in_use", "A request with this Idempotency-Key already exists.");
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
            },
        });
        // At most once a minute: the row is already locked, and a timestamp
        // that is a minute stale says the same thing to the person reading it.
        if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > 60_000) {
            await tx.externalApiKey.update({ where: { id: key.id }, data: { lastUsedAt: now } });
        }
    };
