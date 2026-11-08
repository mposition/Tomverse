import { createHash } from "node:crypto";

export { recommendationIdeaText } from "@/lib/autoRouterRecommendationIdeaText";

/**
 * The AMUX request id of a recommendation, derived from where it is, as the
 * Scout console does for a suggestion: a lost answer, a second tab or a second
 * owner all name the same request, so AMUX takes it once and the rest read it
 * back. Shaped as the UUID v4 AMUX request ids are.
 */
export function recommendationSendRequestId(cycleId: string, index: number): string {
    const bytes = createHash("sha256").update(`auto-router-recommendation:${cycleId}:${index}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
