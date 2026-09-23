// Loaded for what it does, not for what it exports. A side-effect import runs
// this file, and this file reaches the store at module scope.
import { pauseMarketingChannel } from "@/lib/marketingStore";

export const planted = true;

(globalThis as Record<string, unknown>).__pause = pauseMarketingChannel;
