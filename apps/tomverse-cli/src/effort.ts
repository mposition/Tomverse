export type Effort = "default" | "low" | "high";

export const isExplicitEffort = (value: unknown): value is Exclude<Effort, "default"> =>
    value === "low" || value === "high";

export const isEffort = (value: unknown): value is Effort =>
    value === "default" || isExplicitEffort(value);
