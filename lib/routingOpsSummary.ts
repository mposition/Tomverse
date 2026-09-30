/**
 * Content-free health, capacity, and quality summary for one deployment.
 *
 * A ratio is reported only when the caller supplies a positive denominator
 * and a numerator that does not exceed it. An empty population is
 * insufficient, not zero. No threshold is chosen here, and nothing is
 * compared against one. Nothing reads a row. The request path does not
 * import this module.
 */

export const QUALITY_SUMMARY_STATES = ["passed", "stale", "pending", "failed"] as const;

export type QualitySummaryState = (typeof QUALITY_SUMMARY_STATES)[number];

export type OpsSummaryInput = {
    health: { failed: number; eligible: number } | null;
    capacityLimited: boolean | null;
    quality: string | null;
};

export type OpsSummary =
    | {
          kind: "insufficient";
          missing: readonly ("health" | "capacity" | "quality")[];
      }
    | {
          kind: "summary";
          healthFailureRatio: number;
          capacityLimited: boolean;
          quality: QualitySummaryState;
      };

const whole = (value: number): boolean => Number.isInteger(value) && value >= 0;

const qualityState = (value: string | null): QualitySummaryState | null => {
    if (value === null) return null;
    return (QUALITY_SUMMARY_STATES as readonly string[]).includes(value)
        ? (value as QualitySummaryState)
        : null;
};

/**
 * Summarise three caller-supplied facts, or name which ones cannot be shown.
 *
 * Health is insufficient when it is absent, not a whole count, has no
 * eligible attempts, or claims more failures than attempts. Capacity is
 * insufficient when the limited flag is absent. Quality is insufficient
 * when the state is absent or not one of the four stored states. A summary
 * is returned only when all three are usable. The ratio is the caller's
 * counts divided, not a judgement that the deployment is healthy.
 */
export const routingOpsSummary = (input: OpsSummaryInput): OpsSummary => {
    const missing: ("health" | "capacity" | "quality")[] = [];
    const health = input.health;
    const healthUsable =
        health !== null &&
        whole(health.failed) &&
        whole(health.eligible) &&
        health.eligible >= 1 &&
        health.failed <= health.eligible;
    if (!healthUsable) missing.push("health");
    if (typeof input.capacityLimited !== "boolean") missing.push("capacity");
    const quality = qualityState(input.quality);
    if (quality === null) missing.push("quality");
    if (missing.length > 0 || health === null || quality === null || typeof input.capacityLimited !== "boolean") {
        return { kind: "insufficient", missing };
    }
    return {
        kind: "summary",
        healthFailureRatio: health.failed / health.eligible,
        capacityLimited: input.capacityLimited,
        quality,
    };
};
