export const dynamic = "force-dynamic";

import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { normalizeExternalApiCreditCap, normalizeExternalApiKeyName } from "@/lib/externalApiKeyCore";
import {
    ExternalApiKeyError,
    externalApiKeyUsage,
    revokeExternalApiKey,
    updateExternalApiKey,
} from "@/lib/externalApiKeys";
import { managementJson, withKeyManagementSession } from "@/lib/externalApiRoutes";
import { prisma } from "@/lib/prisma";

const updateSchema = z
    .object({
        name: z.string().optional(),
        creditCap: z.number().int().positive().nullable().optional(),
    })
    .strict();

const failure = (error: unknown) => {
    if (error instanceof ExternalApiKeyError) {
        return managementJson(error.status, { error: error.message, code: error.code });
    }
    const security = apiSecurityResponse(error);
    if (security) return security;
    throw error;
};

// This key's recent request receipts. Another account's key is a 404.
export async function GET(request: Request, context: RouteContext<"/api/user/api-keys/[keyId]">) {
    return withKeyManagementSession(request, async ({ userId }) => {
        const { keyId } = await context.params;
        const owned = await prisma.externalApiKey.findFirst({ where: { id: keyId, userId }, select: { id: true } });
        if (!owned) return managementJson(404, { error: "Key not found.", code: "EXTERNAL_API_KEY_NOT_FOUND" });
        return managementJson(200, { requests: await externalApiKeyUsage(keyId, 50) });
    });
}

export async function PATCH(request: Request, context: RouteContext<"/api/user/api-keys/[keyId]">) {
    return withKeyManagementSession(request, async ({ session, userId }) => {
        try {
            await consumeApiRateLimit(request, userId, "external-api-key-update", { minute: 20, day: 200 });
            const { keyId } = await context.params;
            const body = await readLimitedJson(request, 4 * 1024, updateSchema);
            const name = body.name === undefined ? undefined : normalizeExternalApiKeyName(body.name);
            if (name === null) {
                return managementJson(400, { error: "Give the key a name of 1 to 80 characters.", code: "INVALID_KEY_NAME" });
            }
            const creditCap = body.creditCap === undefined ? undefined : normalizeExternalApiCreditCap(body.creditCap);
            if (body.creditCap !== undefined && creditCap === undefined) {
                return managementJson(400, { error: "The credit limit is out of range.", code: "INVALID_CREDIT_CAP" });
            }
            const updated = await updateExternalApiKey({ userId, keyId, name, creditCap }, { session, request });
            return managementJson(200, { key: updated });
        } catch (error) {
            return failure(error);
        }
    });
}

export async function DELETE(request: Request, context: RouteContext<"/api/user/api-keys/[keyId]">) {
    return withKeyManagementSession(request, async ({ session, userId }) => {
        try {
            const { keyId } = await context.params;
            const result = await revokeExternalApiKey({ userId, keyId }, { session, request });
            return managementJson(200, { revoked: true, alreadyRevoked: result.alreadyRevoked });
        } catch (error) {
            return failure(error);
        }
    }, { allowWhenDisabled: true });
}
