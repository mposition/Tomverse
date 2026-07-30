/**
 * The shelf price of the two comparison actions, in credits.
 *
 * This module is deliberately dependency-free and free of `server-only`: the
 * rail, the review dialog and the server routes all quote the same numbers, and
 * before this they each carried their own copy. When the rail advertised 4 and
 * the route charged 8, the difference was invisible until a user with a balance
 * of 6 clicked a button the UI had told them they could afford.
 *
 * These are *estimates*, and they are the only thing a client is ever allowed
 * to state. The authoritative figure is always what the server computes at run
 * time from the reviewer models it actually selected
 * (`createChatBudget().usageCredits`), which is why the preview endpoints
 * return a server-computed `estimatedCredits` and the run endpoints never read
 * a cost from the request body.
 */

/** One low-cost reviewer, one pass. */
export const QUICK_SUMMARY_CREDITS = 1;

/**
 * Two independent `advanced`-class reviewers (4 credits each) run for every
 * cross-review: the orchestration starts a second one from a different provider
 * once the first succeeds, which doubles the cost on purpose. Reviewer models
 * come from COMPARISON_REVIEW_MODEL_IDS and are filtered by plan and runtime
 * availability, so the exact figure is only knowable server-side.
 */
export const AI_REVIEW_CREDITS = 8;

/**
 * Guests run the same pipeline with the same reviewer pool as a Free account,
 * so the estimate is the same number. It is named separately so a future guest
 * -only reviewer policy has somewhere to land that is not a magic literal in a
 * component.
 */
export const GUEST_AI_REVIEW_CREDITS = AI_REVIEW_CREDITS;
