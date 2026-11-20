import { adminAutoRouterOptimizerMessages } from "@/lib/adminMessages/autoRouterOptimizer";
import {
    buildRecommendationInstruction,
    optimizerCyclePath,
    type ActionableRecommendationKind,
} from "@/lib/autoRouterRecommendationsCore";

/**
 * The AMUX idea an owner sends: the stored report's work instruction, in the owner's language.
 * Kept apart from the request id (node:crypto) so Admin › Routing can copy the same text for a
 * local CLI (components/admin/AdminAutoRouterRecommendations.tsx).
 */
export const recommendationIdeaText = (input: {
    recommendation: { kind: ActionableRecommendationKind; text: string };
    findings: readonly string[];
    cycle: { id: string; createdAt: string };
    origin: string;
}): string =>
    buildRecommendationInstruction({
        labels: adminAutoRouterOptimizerMessages.ko.instruction,
        recommendation: input.recommendation,
        findings: input.findings,
        cycle: input.cycle,
        link: `${input.origin}${optimizerCyclePath(input.cycle.id)}`,
    });
