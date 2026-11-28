export const dynamic = "force-dynamic";

import { receiptOwner } from "@/lib/externalApiCaller";
import { externalApiRequestStatus, type ExternalApiRequestSelector } from "@/lib/externalApiKeys";
import { sha256Hex } from "@/lib/externalApiKeyCore";
import { externalApiErrorResponse } from "@/lib/externalApiInference";
import { NO_STORE_HEADERS, withBearerKey } from "@/lib/externalApiRoutes";

const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;

/**
 * Tomverse-specific: the receipt of one request of this key, by `request_id`
 * or by the `Idempotency-Key` header the client sent with it. Read only -- it
 * never dispatches, reserves or changes anything, and no output is stored to
 * return. Not found is not evidence that nothing was sent or charged: the
 * request may not have arrived or been admitted yet.
 */
export async function GET(request: Request) {
    return withBearerKey(request, async (key) => {
        const requestId = new URL(request.url).searchParams.get("request_id");
        const idempotencyKey = request.headers.get("idempotency-key")?.trim() || null;
        if ((requestId === null) === (idempotencyKey === null)) {
            return externalApiErrorResponse(
                400,
                "Send exactly one of the request_id query parameter or the Idempotency-Key header.",
                "invalid_request_selector"
            );
        }
        let selector: ExternalApiRequestSelector;
        if (requestId !== null) {
            if (!REQUEST_ID_PATTERN.test(requestId)) {
                return externalApiErrorResponse(400, "request_id is not a Tomverse request id.", "invalid_request_selector", {
                    param: "request_id",
                });
            }
            selector = { kind: "request_id", requestId };
        } else {
            if (idempotencyKey!.length > 255) {
                return externalApiErrorResponse(400, "Idempotency-Key must be at most 255 characters.", "invalid_idempotency_key");
            }
            // The same digest the generation routes store; the raw value is
            // neither stored nor logged.
            selector = { kind: "idempotency_key", idempotencyKeyDigest: sha256Hex(idempotencyKey!) };
        }
        const receipt = await externalApiRequestStatus(receiptOwner(key), selector);
        if (!receipt) {
            return externalApiErrorResponse(
                404,
                "No request of this key matches. That does not show it was never sent or charged: it may not have arrived or been admitted yet.",
                "request_not_found"
            );
        }
        return Response.json(
            {
                object: "tomverse.request_status",
                request: receipt,
                // Settled token counts are the settlement's: provider-reported
                // where the provider reported usage, the reservation estimate
                // where it did not. The row does not say which.
                usage_source: receipt.usage ? "server_settlement" : null,
                output_stored: false,
            },
            { headers: NO_STORE_HEADERS }
        );
    });
}
