/**
 * Reasoning effort. "default" asks for none. An explicit effort is a level id
 * the model catalog names for the model (low, high, and whatever the server
 * adds); the server decides which it takes and says which it applied. The
 * CLI only checks that an id is shaped like one, so a new level needs no
 * change here.
 */
export type Effort = "default" | (string & {});

const EFFORT_ID = /^[a-z][a-z0-9_-]{0,23}$/;

export const isExplicitEffort = (value: unknown): value is Exclude<Effort, "default"> =>
    typeof value === "string" && value !== "default" && EFFORT_ID.test(value);

export const isEffort = (value: unknown): value is Effort =>
    value === "default" || isExplicitEffort(value);
