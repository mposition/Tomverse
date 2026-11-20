/**
 * The closed lists of the image routing improvement agent's records
 * (prisma/schema.prisma ImageRoutingDecision, ImageGenerationSignal), held by
 * the database's CHECK constraints (scripts/check-enum-constraints.mjs).
 */

/** Where a Chat image routing decision was made. */
export const IMAGE_ROUTING_DECISION_SOURCES = ["auto_chat", "composer"] as const;
export type ImageRoutingDecisionSource = (typeof IMAGE_ROUTING_DECISION_SOURCES)[number];

/** What the decision was: an image, a text answer, or a call that failed. */
export const IMAGE_ROUTING_DECISION_OUTCOMES = ["image", "chat", "error"] as const;
export type ImageRoutingDecisionOutcome = (typeof IMAGE_ROUTING_DECISION_OUTCOMES)[number];

/**
 * What a person did with one generated image. `selected` is a choice in a
 * comparison; `wanted_text` says the message should have had a text answer.
 */
export const IMAGE_GENERATION_SIGNAL_KINDS = ["download", "selected", "helpful", "not_helpful", "wanted_text"] as const;
export type ImageGenerationSignalKind = (typeof IMAGE_GENERATION_SIGNAL_KINDS)[number];
