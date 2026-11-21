export const dynamic = "force-dynamic";

import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { externalApiOfferedModels } from "@/lib/externalApiCatalog";
import { externalApiPlanAllowed } from "@/lib/externalApiCatalogCore";
import { codingApiBaseUrl, tomverseCliGuide } from "@/lib/externalApiCodingTools";
import {
    EXTERNAL_API_KEY_LIMITS,
    externalApiKeyExpiry,
    normalizeExternalApiCreditCap,
    normalizeExternalApiKeyName,
} from "@/lib/externalApiKeyCore";
import { createExternalApiKey, ExternalApiKeyError, listExternalApiKeys } from "@/lib/externalApiKeys";
import { externalApiBaseUrl, managementJson, withKeyManagementSession, withManagementReadLimit } from "@/lib/externalApiRoutes";

// Cookie-authenticated key management. Mutations keep the ordinary
// same-origin check (lib/requestOrigin.ts); an Authorization header is refused
// outright so an API key can never manage keys.

const createSchema = z
    .object({
        name: z.string(),
        creditCap: z.number().int().positive().nullable().optional(),
        expiresInDays: z.number().int().nullable().optional(),
    })
    .strict();

export async function GET(request: Request) {
    return withKeyManagementSession(
        request,
        async ({ userId, plan }) => withManagementReadLimit(request, userId, async () => {
            // A Free account sees an upgrade prompt and its existing keys, which
            // it can still revoke; nothing it could use is offered.
            if (!externalApiPlanAllowed(plan.tier)) {
                return managementJson(200, { enabled: false, reason: "plan_not_eligible", keys: await listExternalApiKeys(userId) });
            }
            // Two APIs on one key (owner decision 2026-11-21): the general one
            // for Aside, VS Code and other apps, the coding one for Claude Code,
            // Codex, Cursor and the tomverse CLI.
            const baseUrl = externalApiBaseUrl(request);
            const codingBaseUrl = codingApiBaseUrl(baseUrl);
            const [models, codingModels] = await Promise.all([
                externalApiOfferedModels(plan.tier, { surface: "general" }),
                externalApiOfferedModels(plan.tier, { surface: "coding" }),
            ]);
            return managementJson(200, {
                enabled: true,
                baseUrl,
                codingBaseUrl,
                limits: {
                    maxKeys: EXTERNAL_API_KEY_LIMITS.maxKeysPerUser,
                    maxCreditCap: EXTERNAL_API_KEY_LIMITS.maxCreditCap,
                    expiryDays: EXTERNAL_API_KEY_LIMITS.expiryDays,
                },
                models,
                codingModels,
                keys: await listExternalApiKeys(userId),
                // Null until the Tomverse CLI package is published.
                tomverseCli: tomverseCliGuide(process.env, codingBaseUrl),
            });
        }),
        {
            // Keys issued before the API was switched off stay listed so they can
            // still be revoked; nothing else is offered.
            whenDisabled: async ({ userId }) =>
                withManagementReadLimit(request, userId, async () =>
                    managementJson(200, { enabled: false, keys: await listExternalApiKeys(userId) })
                ),
        }
    );
}

export async function POST(request: Request) {
    return withKeyManagementSession(request, async ({ session, userId }) => {
        try {
            await consumeApiRateLimit(request, userId, "external-api-key-create", { minute: 5, day: 50 });
            const body = await readLimitedJson(request, 8 * 1024, createSchema);
            const name = normalizeExternalApiKeyName(body.name);
            if (!name) {
                return managementJson(400, { error: "Give the key a name of 1 to 80 characters.", code: "INVALID_KEY_NAME" });
            }
            const creditCap = body.creditCap === undefined ? null : normalizeExternalApiCreditCap(body.creditCap);
            if (creditCap === undefined) {
                return managementJson(400, { error: "The credit limit is out of range.", code: "INVALID_CREDIT_CAP" });
            }
            const expiresAt = externalApiKeyExpiry(body.expiresInDays, new Date());
            if (expiresAt === undefined) {
                return managementJson(400, { error: "Choose one of the offered expiry periods.", code: "INVALID_EXPIRY" });
            }
            const created = await createExternalApiKey({ userId, name, creditCap, expiresAt }, { session, request });
            return managementJson(201, {
                // Shown once. The server keeps only a digest and cannot show it again.
                key: created.key,
                summary: created.summary,
            });
        } catch (error) {
            if (error instanceof ExternalApiKeyError) {
                return managementJson(error.status, { error: error.message, code: error.code });
            }
            const security = apiSecurityResponse(error);
            if (security) return security;
            throw error;
        }
    });
}
