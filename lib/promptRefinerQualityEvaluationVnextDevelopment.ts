/**
 * Development-fixture checks only. A matching result is not a holdout score,
 * semantic-preservation proof, run admission, or product release decision.
 */
import {
    classifyPromptRefinerVnextDirection,
    parsePromptRefinerVnextModelOutput,
    type PromptRefinerVnextDirectionCase,
} from "./promptRefinerQualityEvaluationVnextCore";

export type PromptRefinerVnextDevelopmentFixture = Readonly<{
    sourceText: string;
    direction: PromptRefinerVnextDirectionCase;
    requiredExactLiterals: readonly string[];
}>;

export type PromptRefinerVnextDevelopmentResult = Readonly<{
    structuralAndDirectionMatch: boolean;
    exactLiteralsPresent: boolean | null;
    directionCode: ReturnType<typeof classifyPromptRefinerVnextDirection>["code"];
    semanticPreservation: "unverified";
    releaseDecision: "not_admissible";
}>;

/** Literal presence is a narrow proxy; meaning, safety and quality need review. */
export function evaluatePromptRefinerVnextDevelopmentFixture(
    fixture: PromptRefinerVnextDevelopmentFixture,
    outputText: string
): PromptRefinerVnextDevelopmentResult {
    if (
        fixture.requiredExactLiterals.some(
            (literal) => typeof literal !== "string" || !literal.trim()
        )
    ) {
        throw new Error("vnext_development_literal_invalid");
    }
    const output = parsePromptRefinerVnextModelOutput(outputText, fixture.sourceText);
    const direction = classifyPromptRefinerVnextDirection(
        fixture.direction,
        output,
        fixture.sourceText
    );
    return {
        structuralAndDirectionMatch: direction.code === "direction_match",
        exactLiteralsPresent:
            output.outcome === "suggested"
                ? fixture.requiredExactLiterals.length === 0
                    ? null
                    : fixture.requiredExactLiterals.every((literal) =>
                          output.refinedPrompt.includes(literal)
                      )
                : null,
        directionCode: direction.code,
        semanticPreservation: "unverified",
        releaseDecision: "not_admissible",
    };
}
