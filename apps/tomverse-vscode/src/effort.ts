/** UI choices only. Model support always comes from the server catalog. */
export type { Effort } from "../../tomverse-cli/src/effort.js";
import type { Effort } from "../../tomverse-cli/src/effort.js";
export const effortLevels = (model: { reasoningEfforts?: readonly string[] } | undefined): Effort[] =>
    ["low", "default", "high"].filter((level) => level === "default" || model?.reasoningEfforts?.includes(level)) as Effort[];
